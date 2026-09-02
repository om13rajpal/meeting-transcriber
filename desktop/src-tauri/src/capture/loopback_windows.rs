//! Windows system-audio ("loopback") capture via WASAPI.
//!
//! **UNVERIFIED.** This module has never been compiled, linked, or run - it was
//! written on a macOS-only machine, where the `wasapi` crate does not even
//! resolve. It is a careful transcription of the crate's documented API, not a
//! tested code path. Run it on a real Windows machine before trusting it.
//!
//! API notes, taken from reading the real source of `wasapi` 0.24.0 (the plan's
//! example pinned 0.15, nine breaking releases back):
//!
//! - Loopback is not a separate call. `AudioClient::initialize_client` inspects
//!   the pair (device direction, requested direction) and sets
//!   `AUDCLNT_STREAMFLAGS_LOOPBACK` for exactly
//!   `(Direction::Render, Direction::Capture, ShareMode::Shared)` - i.e. you
//!   take the *playback* endpoint and initialise it *for capture*. The same
//!   pair in exclusive mode is rejected outright with
//!   `WasapiError::LoopbackWithExclusiveMode`, which is why the stream mode
//!   below is `EventsShared` and must stay shared.
//! - Startup sequence, per `examples/record.rs`: `initialize_mta()` (COM, and
//!   it has to happen on the thread that will do the capturing) ->
//!   `DeviceEnumerator::new()` -> `get_default_device(&Direction::Render)` ->
//!   `get_iaudioclient()` -> `initialize_client(&format, &Direction::Capture,
//!   &StreamMode::EventsShared { autoconvert: true, buffer_duration_hns })` ->
//!   `set_get_eventhandle()` -> `get_audiocaptureclient()` -> `start_stream()`.
//! - `autoconvert: true` turns on `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`, which
//!   is what lets us name our own `WaveFormat` (48 kHz stereo f32) instead of
//!   having to accept and then convert the endpoint's mix format.
//! - Samples are pulled with `AudioCaptureClient::read_from_device_to_deque(
//!   &mut VecDeque<u8>)`, which appends raw interleaved bytes in the negotiated
//!   format and returns a `BufferInfo` whose `flags.silent` marks a
//!   silence-filled packet. `Handle::wait_for_event(timeout_ms)` blocks until
//!   the next period, returning `Err(WasapiError::EventTimeout)` on timeout.
//! - There is no callback API, so unlike ScreenCaptureKit this needs its own
//!   thread; `LoopbackHandle` owns it and joins it on drop, so the handle still
//!   behaves like the macOS one and like `cpal::Stream`.
//!
//! The one real behavioural difference from macOS worth knowing about: WASAPI
//! loopback emits **nothing at all** while the endpoint is idle - it does not
//! manufacture silence the way ScreenCaptureKit does. `pad_to_wall_clock`
//! below is what keeps this source on the same timeline as the microphone
//! despite that, and is the part most in need of real testing.

use crossbeam_channel::Sender;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use wasapi::{
    initialize_mta, AudioCaptureClient, AudioClient, DeviceEnumerator, Direction, Handle,
    SampleType, StreamMode, WaveFormat,
};

const SYSTEM_AUDIO_SAMPLE_RATE: u32 = 48_000;
const SYSTEM_AUDIO_CHANNELS: usize = 2;

/// How long to block on the "buffer ready" event before looking at the stop
/// flag again. Also the granularity at which an idle endpoint gets padded.
const EVENT_WAIT_MS: u32 = 100;

/// Only synthesise silence once the source has fallen at least this far behind
/// wall-clock time, so ordinary scheduling jitter never injects a gap.
const PAD_THRESHOLD: Duration = Duration::from_millis(150);

/// How long `start_system_audio_capture` waits for the capture thread to
/// report whether its WASAPI setup succeeded.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(5);

pub struct LoopbackHandle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    /// The sample rate this source is actually producing at.
    pub sample_rate: u32,
}

impl Drop for LoopbackHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            // The loop checks `stop` at most EVENT_WAIT_MS after it is set, so
            // this join is bounded even with a completely idle endpoint.
            if thread.join().is_err() {
                eprintln!("system audio capture thread panicked");
            }
        }
    }
}

/// Starts capturing everything playing out of the system's speakers, sending
/// chunks of mono `f32` samples to `tx`.
pub fn start_system_audio_capture(tx: Sender<Vec<f32>>) -> Result<LoopbackHandle, String> {
    let stop = Arc::new(AtomicBool::new(false));

    // WASAPI setup has to run on the same thread that will pump the capture
    // (COM apartment affinity), so the thread reports its own setup result
    // back here rather than this function doing the setup itself. That keeps
    // `start_system_audio_capture` failing synchronously, like the macOS one.
    let (ready_tx, ready_rx) = crossbeam_channel::bounded::<Result<(), String>>(1);

    let thread = std::thread::Builder::new()
        .name("system-audio-capture".to_string())
        .spawn({
            let stop = Arc::clone(&stop);
            move || match set_up_capture() {
                Err(e) => {
                    let _ = ready_tx.send(Err(e));
                }
                Ok(session) => {
                    let _ = ready_tx.send(Ok(()));
                    if let Err(e) = capture_loop(session, &tx, &stop) {
                        eprintln!("system audio capture stopped: {e}");
                    }
                }
            }
        })
        .map_err(|e| format!("Could not start the system audio capture thread: {e}"))?;

    match ready_rx.recv_timeout(STARTUP_TIMEOUT) {
        Ok(Ok(())) => Ok(LoopbackHandle {
            stop,
            thread: Some(thread),
            sample_rate: SYSTEM_AUDIO_SAMPLE_RATE,
        }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            stop.store(true, Ordering::Relaxed);
            let _ = thread.join();
            Err("System audio capture did not start in time.".to_string())
        }
    }
}

/// The pieces of a live WASAPI loopback session, kept together so they drop as
/// a unit when the capture thread exits.
struct Session {
    client: AudioClient,
    capture: AudioCaptureClient,
    event: Handle,
    bytes_per_frame: usize,
}

fn set_up_capture() -> Result<Session, String> {
    initialize_mta()
        .ok()
        .map_err(|e| format!("Could not initialise COM for system audio capture: {e}"))?;

    let enumerator = DeviceEnumerator::new()
        .map_err(|e| format!("Could not list audio devices: {e}"))?;
    // The *playback* endpoint - initialising it for capture below is what
    // makes this a loopback stream.
    let device = enumerator
        .get_default_device(&Direction::Render)
        .map_err(|e| format!("No speakers or headphones found to record from: {e}"))?;
    let mut client = device
        .get_iaudioclient()
        .map_err(|e| format!("Could not open the system audio device: {e}"))?;

    let format = WaveFormat::new(
        32,
        32,
        &SampleType::Float,
        SYSTEM_AUDIO_SAMPLE_RATE as usize,
        SYSTEM_AUDIO_CHANNELS,
        None,
    );
    let bytes_per_frame = format.get_blockalign() as usize;

    let (_default_period, min_period) = client
        .get_device_period()
        .map_err(|e| format!("Could not read the system audio device timing: {e}"))?;

    // Shared mode is mandatory: exclusive mode plus loopback is rejected by
    // the crate itself (WasapiError::LoopbackWithExclusiveMode). autoconvert
    // lets the audio engine resample the endpoint's mix format into the
    // 48 kHz stereo f32 asked for above.
    let mode = StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period,
    };
    client
        .initialize_client(&format, &Direction::Capture, &mode)
        .map_err(|e| format!("Could not start system audio capture: {e}"))?;

    let event = client
        .set_get_eventhandle()
        .map_err(|e| format!("Could not set up system audio capture timing: {e}"))?;
    let capture = client
        .get_audiocaptureclient()
        .map_err(|e| format!("Could not open the system audio capture stream: {e}"))?;
    client
        .start_stream()
        .map_err(|e| format!("Could not start system audio capture: {e}"))?;

    Ok(Session {
        client,
        capture,
        event,
        bytes_per_frame,
    })
}

fn capture_loop(
    session: Session,
    tx: &Sender<Vec<f32>>,
    stop: &AtomicBool,
) -> Result<(), String> {
    let mut raw: VecDeque<u8> = VecDeque::new();
    let started = Instant::now();
    let mut samples_sent: u64 = 0;

    while !stop.load(Ordering::Relaxed) {
        // A timeout here is normal, not an error: with nothing playing, WASAPI
        // loopback never signals the event at all.
        let _ = session.event.wait_for_event(EVENT_WAIT_MS);

        session
            .capture
            .read_from_device_to_deque(&mut raw)
            .map_err(|e| format!("System audio capture read failed: {e}"))?;

        if let Some(mono) = drain_whole_frames(&mut raw, session.bytes_per_frame) {
            samples_sent += mono.len() as u64;
            let _ = tx.send(mono);
        }

        if let Some(silence) = pad_to_wall_clock(started.elapsed(), samples_sent) {
            samples_sent += silence.len() as u64;
            let _ = tx.send(silence);
        }
    }

    if let Err(e) = session.client.stop_stream() {
        eprintln!("system audio capture failed to stop cleanly: {e}");
    }
    Ok(())
}

/// Pulls every complete interleaved frame out of `raw` and averages it to mono,
/// leaving any partial trailing frame in the deque for the next read. Returns
/// `None` when there is not yet a whole frame, so an empty read costs nothing.
fn drain_whole_frames(raw: &mut VecDeque<u8>, bytes_per_frame: usize) -> Option<Vec<f32>> {
    let frames = raw.len() / bytes_per_frame;
    if frames == 0 {
        return None;
    }
    let mut mono = Vec::with_capacity(frames);
    for _ in 0..frames {
        let mut sum = 0.0f32;
        for _ in 0..SYSTEM_AUDIO_CHANNELS {
            let bytes = [
                raw.pop_front()?,
                raw.pop_front()?,
                raw.pop_front()?,
                raw.pop_front()?,
            ];
            sum += f32::from_le_bytes(bytes);
        }
        mono.push(sum / SYSTEM_AUDIO_CHANNELS as f32);
    }
    Some(mono)
}

/// WASAPI loopback produces no data at all while nothing is playing, so this
/// source's own sample count is not a clock. Compare it against wall time and
/// emit the shortfall as silence, which keeps system audio aligned with the
/// microphone across a quiet stretch. When audio *is* playing the real samples
/// track wall time on their own and this returns `None` every time.
fn pad_to_wall_clock(elapsed: Duration, samples_sent: u64) -> Option<Vec<f32>> {
    let expected = (elapsed.as_secs_f64() * f64::from(SYSTEM_AUDIO_SAMPLE_RATE)) as u64;
    let behind = expected.saturating_sub(samples_sent);
    let threshold =
        (PAD_THRESHOLD.as_secs_f64() * f64::from(SYSTEM_AUDIO_SAMPLE_RATE)) as u64;
    if behind < threshold {
        return None;
    }
    Some(vec![0.0; behind as usize])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drains_only_whole_frames() {
        let mut raw: VecDeque<u8> = VecDeque::new();
        // One complete stereo frame (1.0, 3.0) plus a stray byte.
        raw.extend(1.0f32.to_le_bytes());
        raw.extend(3.0f32.to_le_bytes());
        raw.push_back(0x7f);
        assert_eq!(drain_whole_frames(&mut raw, 8), Some(vec![2.0]));
        assert_eq!(raw.len(), 1, "partial frame must be left for the next read");
        assert_eq!(drain_whole_frames(&mut raw, 8), None);
    }

    #[test]
    fn pads_only_once_meaningfully_behind() {
        // Barely behind: no padding, so jitter never punches a hole.
        assert!(pad_to_wall_clock(Duration::from_millis(100), 4_800).is_none());
        // A full second with nothing captured: pad the whole second.
        let padded = pad_to_wall_clock(Duration::from_secs(1), 0).expect("should pad");
        assert_eq!(padded.len(), SYSTEM_AUDIO_SAMPLE_RATE as usize);
        // Ahead of wall clock: never pad, and never underflow.
        assert!(pad_to_wall_clock(Duration::from_millis(10), 96_000).is_none());
    }
}
