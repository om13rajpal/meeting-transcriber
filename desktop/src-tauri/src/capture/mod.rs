// Audio capture: microphone plus system audio ("loopback"), mixed into a
// single mono WAV file.
//
// Every capture source in here hands the mixer the same shape - chunks of mono
// `f32` samples plus, on its handle, the sample rate it is *actually* producing
// at. That last part is deliberate: the plan assumed a single hardcoded
// SAMPLE_RATE would hold for both sides, and it does not. `cpal` negotiates
// whatever the input device offers (this varies by machine and by whether a
// headset is plugged in), while ScreenCaptureKit/WASAPI produce the rate we
// asked them for. `mix_and_write` resamples each source from its reported rate
// to `OUTPUT_SAMPLE_RATE` instead of trusting a constant, so a mismatch is a
// no-op cost rather than pitch-shifted, half-speed audio.

mod mic;

#[cfg(target_os = "macos")]
mod loopback_macos;
#[cfg(target_os = "macos")]
use loopback_macos as loopback;

#[cfg(target_os = "windows")]
mod loopback_windows;
#[cfg(target_os = "windows")]
use loopback_windows as loopback;

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
compile_error!(
    "This app captures system audio, which has no cross-platform implementation. \
     Only macOS (ScreenCaptureKit) and Windows (WASAPI loopback) are supported."
);

use crossbeam_channel::{bounded, unbounded, Receiver, Sender};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// The rate the WAV is written at. Both sources are resampled to this.
const OUTPUT_SAMPLE_RATE: u32 = 48_000;

/// A source that has produced nothing for this long is treated as stalled, and
/// the other source is written through on its own rather than the whole
/// recording blocking on it. Long enough to be well clear of ordinary buffer
/// jitter (tens of milliseconds), short enough that a dead source costs a
/// couple of seconds rather than the whole meeting.
const STALL_TIMEOUT: Duration = Duration::from_secs(2);

/// Hard cap on how far one source may run ahead of the other before its oldest
/// samples are dropped. Two independent audio clocks drift slowly apart over a
/// long meeting; without this the faster one's backlog grows without bound.
const MAX_BUFFERED_SAMPLES: usize = 2 * OUTPUT_SAMPLE_RATE as usize;

/// How long the final drain waits for in-flight buffers after the sources have
/// been stopped.
const FINAL_DRAIN: Duration = Duration::from_millis(500);

/// A recording in progress.
///
/// Everything platform-specific - the `cpal::Stream` (which is `!Send` on
/// macOS) and the loopback session - lives on the session thread and never
/// crosses back out, so this handle is a plain `Send + Sync` pair of a channel
/// and a join handle. That is what lets Task 6 park it in Tauri's app state.
pub struct RecordingHandle {
    stop_tx: Sender<()>,
    session: JoinHandle<Result<PathBuf, String>>,
}

/// Starts recording microphone + system audio into `output_path`.
///
/// Returns once both capture sources are confirmed running, so a permission
/// denial or a missing device surfaces here rather than as a silent empty file
/// later.
pub fn start_recording(output_path: &Path) -> Result<RecordingHandle, String> {
    let output_path = output_path.to_path_buf();
    let (stop_tx, stop_rx) = bounded::<()>(1);
    let (ready_tx, ready_rx) = bounded::<Result<(), String>>(1);

    let session = std::thread::Builder::new()
        .name("recording-session".to_string())
        .spawn(move || run_session(output_path, stop_rx, ready_tx))
        .map_err(|e| format!("Could not start the recording thread: {e}"))?;

    // Deliberately an unbounded `recv()`, not `recv_timeout`. On macOS the
    // first ever call blocks inside ScreenCaptureKit for as long as the user
    // takes to answer the Screen Recording prompt, and a timeout here would
    // not bound that anyway - the timeout branch has to join the session
    // thread regardless, so all a deadline buys is replacing the real error
    // ("Screen Recording permission is required…") with a misleading
    // "did not start in time". Measured: a 20-second deadline fired on
    // exactly that prompt. The session thread always sends exactly one
    // result before doing anything else, and a panic drops the sender, so
    // this cannot wait on nothing.
    match ready_rx.recv() {
        Ok(Ok(())) => Ok(RecordingHandle { stop_tx, session }),
        Ok(Err(e)) => {
            let _ = session.join();
            Err(e)
        }
        Err(_) => {
            let _ = session.join();
            Err("The recording failed to start.".to_string())
        }
    }
}

/// Stops recording and returns the finished WAV file's path.
///
/// Deviates from the plan's `-> PathBuf` signature on purpose: the plan's
/// version `.expect()`s on every WAV write and on the join, which would abort
/// the whole app on a full disk. This project's rule is that a failure comes
/// back as a client-safe message, never a panic.
pub fn stop_recording(handle: RecordingHandle) -> Result<PathBuf, String> {
    let _ = handle.stop_tx.send(());
    handle
        .session
        .join()
        .map_err(|_| "The recording stopped unexpectedly.".to_string())?
}

/// Owns both capture sources for the whole life of a recording. Dropping it is
/// what stops capture (cpal stops on stream drop; the loopback handles do the
/// same), and it happens on the session thread that created them.
struct Sources {
    mic: Option<mic::MicCapture>,
    loopback: Option<loopback::LoopbackHandle>,
}

impl Sources {
    fn stop(&mut self) {
        self.mic.take();
        self.loopback.take();
    }
}

fn run_session(
    output_path: PathBuf,
    stop_rx: Receiver<()>,
    ready_tx: Sender<Result<(), String>>,
) -> Result<PathBuf, String> {
    let (mic_tx, mic_rx) = unbounded();
    let (system_tx, system_rx) = unbounded();

    let mic = match mic::start_mic_capture(mic_tx) {
        Ok(mic) => mic,
        Err(e) => {
            let _ = ready_tx.send(Err(e.clone()));
            return Err(e);
        }
    };
    let loopback = match loopback::start_system_audio_capture(system_tx) {
        Ok(loopback) => loopback,
        Err(e) => {
            let _ = ready_tx.send(Err(e.clone()));
            return Err(e);
        }
    };

    let mic_rate = mic.sample_rate;
    let system_rate = loopback.sample_rate;
    eprintln!("recording: mic at {mic_rate} Hz, system audio at {system_rate} Hz, writing {OUTPUT_SAMPLE_RATE} Hz");

    let _ = ready_tx.send(Ok(()));

    let sources = Sources {
        mic: Some(mic),
        loopback: Some(loopback),
    };
    mix_and_write(
        sources,
        Source::new(mic_rx, mic_rate),
        Source::new(system_rx, system_rate),
        &stop_rx,
        output_path,
    )
}

/// One capture source's side of the mixer: its channel, its resampler, the
/// samples it has produced but that have not been mixed yet, and when it last
/// produced anything.
struct Source {
    rx: Receiver<Vec<f32>>,
    resampler: Resampler,
    pending: VecDeque<f32>,
    last_data_at: Instant,
    closed: bool,
    total_samples: u64,
}

impl Source {
    fn new(rx: Receiver<Vec<f32>>, input_rate: u32) -> Self {
        Self {
            rx,
            resampler: Resampler::new(input_rate, OUTPUT_SAMPLE_RATE),
            pending: VecDeque::new(),
            last_data_at: Instant::now(),
            closed: false,
            total_samples: 0,
        }
    }

    /// Moves everything currently queued on the channel into `pending`,
    /// resampling on the way. Never blocks.
    fn drain(&mut self) {
        let mut resampled = Vec::new();
        loop {
            match self.rx.try_recv() {
                Ok(chunk) => {
                    self.total_samples += chunk.len() as u64;
                    resampled.clear();
                    self.resampler.process(&chunk, &mut resampled);
                    self.pending.extend(resampled.iter().copied());
                    self.last_data_at = Instant::now();
                }
                Err(crossbeam_channel::TryRecvError::Empty) => break,
                Err(crossbeam_channel::TryRecvError::Disconnected) => {
                    self.closed = true;
                    break;
                }
            }
        }
        // Drift guard: keep the newest samples, drop the stale head.
        if self.pending.len() > MAX_BUFFERED_SAMPLES {
            let excess = self.pending.len() - MAX_BUFFERED_SAMPLES;
            self.pending.drain(..excess);
        }
    }

    fn is_stalled(&self, now: Instant) -> bool {
        self.closed || now.duration_since(self.last_data_at) > STALL_TIMEOUT
    }
}

fn mix_and_write(
    mut sources: Sources,
    mut mic: Source,
    mut system: Source,
    stop_rx: &Receiver<()>,
    output_path: PathBuf,
) -> Result<PathBuf, String> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: OUTPUT_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    let mut writer = WavWriter::create(&output_path, spec)
        .map_err(|e| format!("Could not create the recording file: {e}"))?;

    let mut stopping: Option<Instant> = None;
    let mut written: u64 = 0;

    loop {
        if stopping.is_none() && stop_rx.try_recv().is_ok() {
            // Stop the sources *before* the final drain so their channels
            // disconnect and every buffer already in flight still gets written.
            sources.stop();
            stopping = Some(Instant::now());
        }

        mic.drain();
        system.drain();

        let n = mixable_len(&mic, &system, Instant::now());
        for _ in 0..n {
            let m = mic.pending.pop_front().unwrap_or(0.0);
            let s = system.pending.pop_front().unwrap_or(0.0);
            let mixed = (m + s).clamp(-1.0, 1.0);
            writer
                .write_sample((mixed * f32::from(i16::MAX)) as i16)
                .map_err(|e| format!("Could not write to the recording file: {e}"))?;
            written += 1;
        }

        if let Some(since) = stopping {
            let drained = mic.pending.is_empty() && system.pending.is_empty();
            if (drained && mic.closed && system.closed) || since.elapsed() > FINAL_DRAIN {
                break;
            }
        }

        if n == 0 {
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    writer
        .finalize()
        .map_err(|e| format!("Could not finish the recording file: {e}"))?;

    eprintln!(
        "recording finished: {written} samples written ({:.1}s), mic produced {}, system audio produced {}",
        written as f64 / f64::from(OUTPUT_SAMPLE_RATE),
        mic.total_samples,
        system.total_samples
    );
    Ok(output_path)
}

/// How many samples can be mixed right now.
///
/// Normally `min` of the two backlogs: consuming both at the same rate is what
/// keeps the two sources locked to one timeline. Taking `max` (as the plan's
/// sketch did) would consume one chunk from each side per tick and write the
/// larger chunk's worth of samples, so two sources with different buffer sizes
/// would stretch the recording to roughly twice its real duration.
///
/// The exception is a source that has gone quiet for longer than any buffering
/// explains, or has closed: waiting on it forever would stall the entire
/// recording, so the healthy side is written through with silence mixed in for
/// the stalled one.
fn mixable_len(mic: &Source, system: &Source, now: Instant) -> usize {
    let both = mic.pending.len().min(system.pending.len());
    if both > 0 {
        return both;
    }
    if !mic.pending.is_empty() && system.is_stalled(now) {
        return mic.pending.len();
    }
    if !system.pending.is_empty() && mic.is_stalled(now) {
        return system.pending.len();
    }
    0
}

/// Linear-interpolation resampler with state carried across chunk boundaries.
///
/// Speech headed for transcription does not justify a windowed-sinc resampler,
/// but it does justify not restarting the interpolation at every buffer: the
/// previous chunk's last sample and the fractional read position both persist,
/// so there is no discontinuity every few milliseconds. When the rates already
/// match - the common case, since most machines' input runs at 48 kHz - this
/// is an exact pass-through with no arithmetic at all.
struct Resampler {
    ratio: f64,
    /// Read position relative to the current chunk. Negative means "still
    /// interpolating between `prev` and this chunk's first sample".
    pos: f64,
    prev: f32,
}

impl Resampler {
    fn new(input_rate: u32, output_rate: u32) -> Self {
        Self {
            ratio: f64::from(input_rate) / f64::from(output_rate),
            pos: 0.0,
            prev: 0.0,
        }
    }

    fn is_passthrough(&self) -> bool {
        (self.ratio - 1.0).abs() < f64::EPSILON
    }

    fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        if input.is_empty() {
            return;
        }
        if self.is_passthrough() {
            out.extend_from_slice(input);
            return;
        }

        let len = input.len();
        while self.pos < len as f64 {
            let floor = self.pos.floor();
            let frac = (self.pos - floor) as f32;
            let i = floor as isize;
            let a = if i < 0 { self.prev } else { input[i as usize] };
            let next = i + 1;
            let b = if next < 0 {
                self.prev
            } else if (next as usize) < len {
                input[next as usize]
            } else {
                // The sample we would interpolate towards is the first one of
                // the *next* chunk, so stop here and resume from the same
                // fractional position once it arrives.
                break;
            };
            out.push(a + (b - a) * frac);
            self.pos += self.ratio;
        }

        self.prev = input[len - 1];
        self.pos -= len as f64;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resample(input_rate: u32, output_rate: u32, chunks: &[&[f32]]) -> Vec<f32> {
        let mut resampler = Resampler::new(input_rate, output_rate);
        let mut out = Vec::new();
        for chunk in chunks {
            resampler.process(chunk, &mut out);
        }
        out
    }

    #[test]
    fn matching_rates_pass_samples_through_untouched() {
        let out = resample(48_000, 48_000, &[&[0.1, 0.2], &[0.3]]);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn halving_the_rate_halves_the_sample_count() {
        // 48k -> 24k over 100 input samples split across two chunks.
        let first: Vec<f32> = (0..50).map(|i| i as f32).collect();
        let second: Vec<f32> = (50..100).map(|i| i as f32).collect();
        let out = resample(48_000, 24_000, &[&first, &second]);
        assert_eq!(out.len(), 50);
        // Every other input sample, exactly, since the ratio is an integer.
        assert_eq!(out[0], 0.0);
        assert_eq!(out[1], 2.0);
        assert_eq!(out[25], 50.0);
    }

    #[test]
    fn upsampling_interpolates_across_the_chunk_boundary() {
        // 24k -> 48k puts a midpoint between each pair of input samples,
        // including the pair that straddles the boundary between chunks. Four
        // input samples yield six output ones, not eight: the last pair cannot
        // be interpolated until the sample after it arrives, so it stays
        // pending rather than being invented.
        let out = resample(24_000, 48_000, &[&[0.0, 2.0], &[4.0, 6.0]]);
        // The boundary value (out[2] == 2.0, out[3] == 3.0) is the point: a
        // resampler that restarted per chunk would emit 4.0 there and click.
        assert_eq!(out, vec![0.0, 1.0, 2.0, 3.0, 4.0, 5.0]);
    }

    #[test]
    fn non_integer_ratio_tracks_the_real_rate_over_many_chunks() {
        // 44.1k -> 48k, fed 10 chunks of 441 samples (0.1s of audio). A
        // per-chunk resampler that reset its position would drift; this must
        // land within a sample or two of 4800.
        let chunk: Vec<f32> = (0..441).map(|i| (i % 7) as f32 * 0.1).collect();
        let mut resampler = Resampler::new(44_100, 48_000);
        let mut out = Vec::new();
        for _ in 0..10 {
            resampler.process(&chunk, &mut out);
        }
        assert!(
            (out.len() as i64 - 4800).abs() <= 2,
            "expected ~4800 samples, got {}",
            out.len()
        );
    }

    #[test]
    fn mixes_the_shorter_backlog_so_sources_stay_in_lockstep() {
        let (_tx_a, rx_a) = unbounded();
        let (_tx_b, rx_b) = unbounded();
        let mut mic = Source::new(rx_a, OUTPUT_SAMPLE_RATE);
        let mut system = Source::new(rx_b, OUTPUT_SAMPLE_RATE);
        mic.pending.extend([0.1; 100]);
        system.pending.extend([0.2; 30]);
        // Not min(100, 30) == 100: taking the larger side would stretch the
        // recording, which is the bug the plan's sketch had.
        assert_eq!(mixable_len(&mic, &system, Instant::now()), 30);
    }

    #[test]
    fn a_stalled_source_does_not_block_the_healthy_one() {
        let (_tx_a, rx_a) = unbounded();
        let (tx_b, rx_b) = unbounded();
        let mut mic = Source::new(rx_a, OUTPUT_SAMPLE_RATE);
        let system = Source::new(rx_b, OUTPUT_SAMPLE_RATE);
        mic.pending.extend([0.1; 100]);

        // Freshly started: system audio is merely late, so nothing is written
        // yet and the two stay aligned.
        assert_eq!(mixable_len(&mic, &system, Instant::now()), 0);

        // Past the stall timeout, the microphone is written through alone.
        let later = Instant::now() + STALL_TIMEOUT + Duration::from_millis(1);
        assert_eq!(mixable_len(&mic, &system, later), 100);

        // A closed channel counts as stalled immediately, so the final drain
        // never waits out the full timeout.
        drop(tx_b);
        let mut system = system;
        system.drain();
        assert_eq!(mixable_len(&mic, &system, Instant::now()), 100);
    }
}
