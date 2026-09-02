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
//!   `get_iaudioclient()` -> `get_device_period()` (its minimum period is what
//!   `buffer_duration_hns` below is set from) -> `initialize_client(&format,
//!   &Direction::Capture, &StreamMode::EventsShared { autoconvert: true,
//!   buffer_duration_hns })` -> `set_get_eventhandle()` ->
//!   `get_audiocaptureclient()` -> `get_buffer_size()` (load-bearing: it sizes
//!   the read buffer, and `read_from_device` silently returns zero frames
//!   forever if handed a slice too small for one frame) -> `start_stream()`.
//! - `autoconvert: true` turns on `AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM`, which
//!   is what lets us name our own `WaveFormat` (48 kHz stereo f32) instead of
//!   having to accept and then convert the endpoint's mix format.
//! - Samples are pulled with `AudioCaptureClient::read_from_device(&mut [u8])
//!   -> (frames, BufferInfo)`. The sibling `read_from_device_to_deque` is the
//!   more obvious call but is the wrong one here: it appends the raw buffer
//!   bytes unconditionally, and two fields of the `BufferInfo` it returns have
//!   to change what we do with those bytes. `flags.silent`
//!   (`AUDCLNT_BUFFERFLAGS_SILENT`) means the packet must be *treated* as
//!   silence - Microsoft explicitly does not guarantee the buffer is zeroed -
//!   and `index` is the device's own frame position, which is what makes a
//!   dropout measurable. The frame-count-returning variant is what lets us act
//!   on both. `Handle::wait_for_event(timeout_ms)` blocks until the next
//!   period, returning `Err(WasapiError::EventTimeout)` on timeout.
//! - There is no callback API, so unlike ScreenCaptureKit this needs its own
//!   thread; `LoopbackHandle` owns it and joins it on drop, so the handle still
//!   behaves like the macOS one and like `cpal::Stream`.
//!
//! The one real behavioural difference from macOS worth knowing about: WASAPI
//! loopback emits **nothing at all** while the endpoint is idle - it does not
//! manufacture silence the way ScreenCaptureKit does. Two mechanisms cover
//! that between them, and they are deliberately keyed to the *same* threshold
//! so that every possible gap length falls to exactly one of them:
//!
//! - up to `MAX_GAP_FILL_FRAMES`, the gap is filled here, exactly, from the
//!   device frame index (`gap_fill_frames`);
//! - beyond it, nothing is filled, because the mixer's stall guard in `mod.rs`
//!   has by then already written the microphone through on its own.
//!
//! `MAX_GAP_FILL_FRAMES` is therefore *derived from* `mod.rs`'s
//! `STALL_TIMEOUT` rather than chosen independently - see its doc comment for
//! what went wrong when the two numbers were allowed to differ.

use crossbeam_channel::Sender;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;
use wasapi::{
    initialize_mta, AudioCaptureClient, AudioClient, DeviceEnumerator, Direction, Handle,
    SampleType, StreamMode, WaveFormat,
};

const SYSTEM_AUDIO_SAMPLE_RATE: u32 = 48_000;
const SYSTEM_AUDIO_CHANNELS: usize = 2;

/// How long to block on the "buffer ready" event before looking at the stop
/// flag again.
const EVENT_WAIT_MS: u32 = 100;

/// Largest device-position jump that is filled in with silence.
///
/// A jump up to this size is filled exactly, which keeps this source aligned
/// with the microphone across a dropout. Anything larger is left alone, because
/// by then the mixer's own stall guard has already written the microphone
/// through for that stretch - back-filling the same silence a second time,
/// late and in one burst, would land against the wrong point on the timeline
/// and then be trimmed by the drift cap anyway.
///
/// **This is derived from `mod.rs`'s `STALL_TIMEOUT` rather than being its own
/// number, and it has to stay that way.** The two mechanisms only work if they
/// tile the whole range with nothing in between. When this was an independent
/// 500ms while the stall guard was 2s, a gap in the 500ms-2s band was handled
/// by *neither*: too big to fill here, too short to trip the guard there. The
/// mixer would simply wait, the microphone backlog would grow unfilled, and
/// when system audio came back the two sources would resume in lockstep with
/// the microphone permanently that far behind - a skew that never
/// self-corrects and that starts silently discarding real speech from the head
/// of the backlog once it crosses `MAX_BUFFERED_SAMPLES`. Deriving the cap
/// makes that band impossible to reopen by editing one constant.
const MAX_GAP_FILL_FRAMES: u64 =
    super::STALL_TIMEOUT.as_millis() as u64 * SYSTEM_AUDIO_SAMPLE_RATE as u64 / 1000;

/// Floor on the read buffer, in frames (100 ms), independent of whatever the
/// endpoint reports for its own buffer size.
const MIN_READ_FRAMES: usize = SYSTEM_AUDIO_SAMPLE_RATE as usize / 10;

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
    buffer_frames: usize,
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
    let buffer_frames = client
        .get_buffer_size()
        .map_err(|e| format!("Could not read the system audio buffer size: {e}"))?
        as usize;
    client
        .start_stream()
        .map_err(|e| format!("Could not start system audio capture: {e}"))?;

    Ok(Session {
        client,
        capture,
        event,
        bytes_per_frame,
        buffer_frames,
    })
}

fn capture_loop(
    session: Session,
    tx: &Sender<Vec<f32>>,
    stop: &AtomicBool,
) -> Result<(), String> {
    // One packet can never exceed the endpoint buffer; doubling it means
    // `read_from_device` can never come back with DataLengthTooShort. The
    // floor matters because `read_from_device` returns `(0, _)` when the slice
    // it is handed cannot fit a single frame - so an implausibly small
    // `get_buffer_size` would otherwise turn into a loop that polls forever and
    // captures nothing, with no error anywhere.
    let read_frames = session.buffer_frames.max(MIN_READ_FRAMES) * 2;
    let mut raw = vec![0u8; read_frames * session.bytes_per_frame];
    let mut expected_next_index: Option<u64> = None;

    while !stop.load(Ordering::Relaxed) {
        // A timeout here is normal, not an error: with nothing playing, WASAPI
        // loopback never signals the event at all.
        let _ = session.event.wait_for_event(EVENT_WAIT_MS);

        // Drain every packet the engine has queued, not just one, or a burst
        // after a stall would be consumed one event at a time. The stop flag is
        // rechecked inside the drain so shutdown latency stays bounded by one
        // packet rather than by however deep the backlog is.
        while !stop.load(Ordering::Relaxed) {
            let (frames, info) = session
                .capture
                .read_from_device(&mut raw)
                .map_err(|e| format!("System audio capture read failed: {e}"))?;
            if frames == 0 {
                break;
            }
            let frames = frames as usize;

            // `info.index` is the device's own frame position for the first
            // frame of this packet, so comparing it against where the previous
            // packet ended gives the real size of any dropout - no wall-clock
            // guessing, and nothing that can drift.
            let gap = gap_fill_frames(expected_next_index, info.index, MAX_GAP_FILL_FRAMES);
            expected_next_index = Some(info.index + frames as u64);

            let mut out = Vec::with_capacity(gap as usize + frames);
            out.resize(gap as usize, 0.0);

            if info.flags.silent {
                // AUDCLNT_BUFFERFLAGS_SILENT. Microsoft's contract is that the
                // caller must *treat* the packet as silence; the buffer's
                // actual contents are explicitly not guaranteed to be zeroed.
                // Copying them would splice whatever the engine last left in
                // that memory into the meeting recording, and on a loopback
                // stream (a render endpoint that is open but outputting
                // silence) this is a routine occurrence, not an edge case.
                out.resize(gap as usize + frames, 0.0);
            } else {
                out.extend(interleaved_to_mono(
                    &raw[..frames * session.bytes_per_frame],
                ));
            }

            let _ = tx.send(out);
        }
    }

    if let Err(e) = session.client.stop_stream() {
        eprintln!("system audio capture failed to stop cleanly: {e}");
    }
    Ok(())
}

/// How many frames of silence to splice in ahead of the packet starting at
/// `index`, given where the previous packet ended.
///
/// Returns 0 for the first packet (nothing to compare against), for a packet
/// that is contiguous with the last one (the overwhelmingly common case), and
/// for a jump larger than `max` - which is not "give up", but "the mixer's
/// stall guard has already covered this stretch"; see `MAX_GAP_FILL_FRAMES` for
/// why the two thresholds must be the same number. `index` running behind
/// `expected` should be impossible, and is treated as "no gap" rather than
/// allowed to underflow.
fn gap_fill_frames(expected_next_index: Option<u64>, index: u64, max: u64) -> u64 {
    let Some(expected) = expected_next_index else {
        return 0;
    };
    let gap = index.saturating_sub(expected);
    if gap == 0 || gap > max {
        return 0;
    }
    gap
}

/// Averages interleaved 32-bit float frames down to mono. Any trailing partial
/// frame is dropped rather than averaged against zeros, since a half-frame
/// would shift every following frame's channel alignment.
///
/// The 4-bytes-per-sample and `SYSTEM_AUDIO_CHANNELS` shape is not an
/// assumption about the hardware: it is the `WaveFormat` this module asks for,
/// which the audio engine is required to deliver because the stream is opened
/// with `autoconvert: true`.
fn interleaved_to_mono(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4 * SYSTEM_AUDIO_CHANNELS)
        .map(|frame| {
            frame
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                .sum::<f32>()
                / SYSTEM_AUDIO_CHANNELS as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn averages_interleaved_frames_and_drops_partial_ones() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1.0f32.to_le_bytes());
        bytes.extend_from_slice(&3.0f32.to_le_bytes());
        assert_eq!(interleaved_to_mono(&bytes), vec![2.0]);

        // A trailing half-frame is discarded: keeping it would swap the
        // left/right assignment of every frame after it.
        bytes.extend_from_slice(&9.0f32.to_le_bytes());
        assert_eq!(interleaved_to_mono(&bytes), vec![2.0]);
    }

    #[test]
    fn fills_only_real_dropouts() {
        // First packet: nothing to compare against.
        assert_eq!(gap_fill_frames(None, 5_000, 24_000), 0);
        // Contiguous packets: the common case, no silence spliced in.
        assert_eq!(gap_fill_frames(Some(5_000), 5_000, 24_000), 0);
        // A genuine mid-stream dropout is filled exactly.
        assert_eq!(gap_fill_frames(Some(5_000), 5_480, 24_000), 480);
        // A jump larger than the cap means the endpoint was idle, not
        // glitching: the mixer's stall guard owns that case, so filling it
        // here would double-count the silence.
        assert_eq!(gap_fill_frames(Some(5_000), 5_000_000, 24_000), 0);
        // An index running backwards should be impossible; it must not
        // underflow into a colossal allocation.
        assert_eq!(gap_fill_frames(Some(5_000), 4_000, 24_000), 0);
    }

    /// The two silence mechanisms must tile the whole range of gap lengths.
    /// A gap that is too long to fill here but too short to trip the mixer's
    /// stall guard is handled by neither, and leaves the microphone
    /// permanently skewed ahead of system audio.
    #[test]
    fn gap_fill_and_stall_guard_leave_no_uncovered_band() {
        let stall_frames =
            super::super::STALL_TIMEOUT.as_millis() as u64 * SYSTEM_AUDIO_SAMPLE_RATE as u64 / 1000;
        assert_eq!(
            MAX_GAP_FILL_FRAMES, stall_frames,
            "gap fill must reach exactly as far as the stall guard begins"
        );
        // The frame just under the stall guard's threshold is still filled.
        assert_eq!(
            gap_fill_frames(Some(0), stall_frames - 1, MAX_GAP_FILL_FRAMES),
            stall_frames - 1
        );
    }
}
