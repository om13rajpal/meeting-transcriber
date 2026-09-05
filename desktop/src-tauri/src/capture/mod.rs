// Audio capture: microphone plus system audio ("loopback"), written as a
// stereo WAV file - mic on the left channel, system audio on the right.
//
// This used to be summed into one mono channel, which made Deepgram's
// diarization guess "which parts are you" purely from voice characteristics -
// a much harder problem than it needs to be, since system audio can be
// anything (music, a video, another person's voice) and summing two
// full-scale signals into one channel can clip/distort both when both are
// loud at once. Keeping them on separate channels means the backend can ask
// Deepgram to transcribe each channel independently (`multichannel=true`)
// and knows deterministically which channel is "you" - diarization then only
// has to separate *further* speakers within the system-audio channel (a
// genuine multi-person meeting), which is the case it's actually designed
// for. See `backend/services/deepgram.js` for the receiving end of this.
//
// Every capture source in here hands the mixer the same shape - chunks of mono
// `f32` samples plus, on its handle, the sample rate it is *actually* producing
// at. That last part is deliberate: the plan assumed a single hardcoded
// SAMPLE_RATE would hold for both sides, and it does not. `cpal` negotiates
// whatever the input device offers (this varies by machine and by whether a
// headset is plugged in). Windows' WASAPI loopback produces the rate we asked
// it for, but macOS's Core Audio tap has no rate to request at all - it mirrors
// whatever the system output's current format is, read back after the tap is
// created rather than assumed. `mix_and_write` resamples each source from its
// reported rate to `OUTPUT_SAMPLE_RATE` instead of trusting a constant, so a
// mismatch is a no-op cost rather than pitch-shifted, half-speed audio.

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
     Only macOS (Core Audio process taps) and Windows (WASAPI loopback) are supported."
);

use crossbeam_channel::{bounded, unbounded, Receiver, Sender};
use hound::{SampleFormat, WavSpec, WavWriter};
use std::collections::VecDeque;
use std::fs::File;
use std::io::BufWriter;
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
///
/// Must comfortably exceed `start_sources()`'s mic rate-calibration window
/// (currently ~2.4s): both channels keep filling, undrained, for that whole
/// window before mixing ever starts, so the very first `drain()` call always
/// sees a real backlog that size on *both* sources - not drift, just start-up
/// catch-up. A cap too close to that duration trimmed a real recording's
/// first couple of seconds on both sides for no reason. 5s leaves solid
/// headroom over the calibration window while still bounding memory growth
/// for genuine, sustained drift over the rest of a long meeting.
const MAX_BUFFERED_SAMPLES: usize = 5 * OUTPUT_SAMPLE_RATE as usize;

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
/// Returns once the output file is open and both capture sources are confirmed
/// running, so a bad path, a permission denial, or a missing device all surface
/// here rather than as a silent empty file an hour later.
///
/// # This call can block for minutes, and cannot be cancelled
///
/// **Do not call this on a thread whose blocking would freeze the UI.** Tauri
/// v2 runs non-`async` commands on the main thread, so a command that calls
/// this directly will hang the whole window. On macOS the first ever recording
/// blocks inside Core Audio for as long as the user takes to answer the
/// System Audio Recording permission prompt - measured at over ten minutes in
/// testing, and unbounded in principle, since the prompt waits forever. Call it
/// from an `async` command (Tauri runs those off the main thread) or an
/// explicitly spawned thread.
///
/// There is also no way to cancel a call that is stuck on that prompt: the stop
/// channel lives in the `RecordingHandle` this function has not returned yet.
/// A caller that needs a responsive "cancel" during first-run permission has to
/// abandon the call and let it finish on its own thread.
pub fn start_recording(output_path: &Path) -> Result<RecordingHandle, String> {
    let output_path = output_path.to_path_buf();
    let (stop_tx, stop_rx) = bounded::<()>(1);
    let (ready_tx, ready_rx) = bounded::<Result<(), String>>(1);

    let session = std::thread::Builder::new()
        .name("recording-session".to_string())
        .spawn(move || run_session(output_path, stop_rx, ready_tx))
        .map_err(|e| format!("Could not start the recording thread: {e}"))?;

    // Deliberately an unbounded `recv()`, not `recv_timeout`. On macOS the
    // first ever call blocks inside Core Audio for as long as the user
    // takes to answer the System Audio Recording prompt, and a timeout here
    // would not bound that anyway - the timeout branch has to join the session
    // thread regardless, so all a deadline buys is replacing the real error
    // ("System Audio Recording permission is required…") with a misleading
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

/// Finishes the header of a WAV file that `hound` never got to finalize.
///
/// `WavWriter::create` writes the RIFF size and the `data` chunk size as zero
/// placeholders and only fills them in from `finalize()` (or from its `Drop`,
/// which is what covers an ordinary early return). **Neither runs when the
/// process is SIGKILLed, OOM-killed, or crashes**, so a recording interrupted
/// that way is left on disk as a *structurally valid* WAV whose header claims
/// it contains zero samples. Every decoder, ffmpeg included, then reads it as
/// an empty file - the audio bytes are all still there, only the two length
/// fields are wrong.
///
/// This is what makes `lib.rs`'s crash-recovery sweep actually recover audio
/// instead of faithfully uploading a header that says "nothing here". It walks
/// the real chunk list rather than assuming a fixed 44-byte header, so it stays
/// correct if `hound` ever emits a `WAVE_FORMAT_EXTENSIBLE` `fmt ` chunk (it
/// does for some specs) or grows a chunk ahead of `data`.
///
/// Returns `Ok(true)` if the file holds real audio (already correct, or now
/// repaired), `Ok(false)` if it holds none at all, and `Err` if it does not
/// parse as a WAV - in which case the caller leaves the file alone rather than
/// writing guesses into something this app may not have created.
pub fn repair_unfinalized_wav(path: &Path) -> Result<bool, String> {
    use std::io::{Read, Seek, SeekFrom, Write};

    let mut file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| format!("could not open it: {e}"))?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("could not measure it: {e}"))?
        .len();

    let mut riff = [0u8; 12];
    file.read_exact(&mut riff)
        .map_err(|_| "it is shorter than a WAV header".to_string())?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err("it is not a RIFF/WAVE file".to_string());
    }

    // Walk the chunk list for `fmt ` (which gives the frame size) and `data`.
    let mut offset: u64 = 12;
    let mut block_align: u64 = 0;
    let mut data_start: Option<u64> = None;
    let mut declared_data_len: u64 = 0;
    while offset + 8 <= file_len {
        file.seek(SeekFrom::Start(offset))
            .map_err(|e| format!("could not read its chunk list: {e}"))?;
        let mut header = [0u8; 8];
        file.read_exact(&mut header)
            .map_err(|e| format!("could not read its chunk list: {e}"))?;
        let id = &header[0..4];
        let size = u64::from(u32::from_le_bytes([
            header[4], header[5], header[6], header[7],
        ]));
        let body = offset + 8;

        if id == b"data" {
            data_start = Some(body);
            declared_data_len = size;
            break;
        }
        if id == b"fmt " {
            let mut fmt = [0u8; 16];
            file.read_exact(&mut fmt)
                .map_err(|e| format!("could not read its format chunk: {e}"))?;
            // nBlockAlign, at a fixed offset in both WAVEFORMATEX and
            // WAVEFORMATEXTENSIBLE, so reading only the first 16 bytes of
            // either is enough.
            block_align = u64::from(u16::from_le_bytes([fmt[12], fmt[13]]));
        }
        // RIFF chunks are word-aligned: an odd-sized one is followed by a pad
        // byte that is not counted in its size.
        offset = body + size + (size & 1);
    }

    let Some(data_start) = data_start else {
        return Err("it has no data chunk".to_string());
    };
    if block_align == 0 {
        return Err("it has no usable format chunk".to_string());
    }

    // Whatever is actually on disk after the header, rounded down to a whole
    // frame: a crash can cut the file mid-frame, and half a frame decodes as a
    // click and shifts the channel alignment of everything after it.
    let mut real_data_len = file_len.saturating_sub(data_start);
    real_data_len -= real_data_len % block_align;

    if real_data_len == 0 {
        return Ok(false);
    }
    if declared_data_len == real_data_len {
        // Already finalized: the app died somewhere between `stop_recording`
        // and the upload finishing, which is the only case the plan's brief
        // assumed existed.
        return Ok(true);
    }

    // RIFF's own size field counts everything after the first 8 bytes.
    file.seek(SeekFrom::Start(4))
        .map_err(|e| format!("could not rewrite its header: {e}"))?;
    file.write_all(&((data_start + real_data_len - 8) as u32).to_le_bytes())
        .map_err(|e| format!("could not rewrite its header: {e}"))?;
    file.seek(SeekFrom::Start(data_start - 4))
        .map_err(|e| format!("could not rewrite its header: {e}"))?;
    file.write_all(&(real_data_len as u32).to_le_bytes())
        .map_err(|e| format!("could not rewrite its header: {e}"))?;
    // Drop the partial trailing frame, if there was one, so the file's own
    // length and the two length fields all agree.
    file.set_len(data_start + real_data_len)
        .map_err(|e| format!("could not rewrite its header: {e}"))?;
    file.flush()
        .map_err(|e| format!("could not rewrite its header: {e}"))?;
    Ok(true)
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

/// The capture half of a start: both sources running, and the mixer's view of
/// each of them.
struct Started {
    sources: Sources,
    mic: Source,
    system: Source,
}

/// Opens the output file.
///
/// Deliberately the first thing a session does, before either capture source:
/// it is the only instant check here, and getting it wrong (an unwritable
/// directory, a bad path) used to be invisible until `stop_recording` - i.e.
/// after a whole meeting had been recorded into nothing. Doing it first also
/// means a bad path fails without making the user answer a permission prompt
/// on the way.
fn create_writer(output_path: &Path) -> Result<WavWriter<BufWriter<File>>, String> {
    let spec = WavSpec {
        channels: 2,
        sample_rate: OUTPUT_SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };
    WavWriter::create(output_path, spec)
        .map_err(|e| format!("Could not create the recording file: {e}"))
}

/// Starts both capture sources.
fn start_sources() -> Result<Started, String> {
    let (mic_tx, mic_rx) = unbounded();
    let (system_tx, system_rx) = unbounded();

    // Microphone opens first (system audio used to go first, specifically to
    // avoid its unbounded channel filling at ~192 KB/s while system audio
    // blocked on the permission prompt - `AudioHardwareCreateProcessTap`,
    // unlike ScreenCaptureKit's `SCShareableContent::get()`, does not
    // actually block this thread on that prompt, so there is no multi-minute
    // window that risk was ever protecting against here). Order alone does
    // not fix the real bug below, but there is no remaining reason to prefer
    // system-audio-first either.
    let mic = mic::start_mic_capture(mic_tx)?;
    let loopback = loopback::start_system_audio_capture(system_tx)?;

    // `mic.sample_rate` (what cpal/CoreAudio *declared* when the stream
    // opened) cannot be trusted here - confirmed across multiple real
    // recordings, independent of mic/system-audio start order: this Mac's
    // built-in mic and speakers/output share one hardware clock domain, and
    // creating the system-audio tap's aggregate device (which wraps the real
    // output device as a clock anchor - see `loopback_macos.rs`) forces that
    // shared clock to a different actual rate for the rest of the recording,
    // silently invalidating whatever cpal negotiated at open time. This never
    // happened with the older ScreenCaptureKit-based system audio, which
    // never created a real `AudioObjectID` aggregate device at all.
    //
    // So rather than trust the declaration, measure the mic's *actual*
    // delivery rate directly. Real recordings so far all used a Bluetooth
    // mic (AirPods), which layers another well-known wrinkle on top of the
    // clock-domain issue above: opening a Bluetooth headset's *microphone*
    // forces macOS to hand the whole accessory off from its high-quality
    // media profile (A2DP - output only) to the low-bandwidth voice profile
    // (HFP - mono, far lower rate, carries input *and* output together), and
    // that handoff is not instant. A single fixed-length calibration window
    // averaged across the handoff (first attempt: 750ms flat) still measured
    // a transitional, not-yet-settled rate (19306 Hz - not a real HFP rate
    // like 8000/16000, and still triggered heavy drift-guard drops).
    //
    // So this takes several readings and uses only the *last* segment's rate
    // - by construction, whatever the handoff was doing early on is excluded,
    // and only the (presumably by-then-settled) most recent delivery rate
    // counts. `mic_rx` just buffers throughout - nothing is lost, since
    // nothing starts draining it into a `Source` until after this returns.
    const CALIBRATION_STEP: Duration = Duration::from_millis(400);
    const CALIBRATION_STEPS: u32 = 6; // 2.4s total - comfortably past a slow BT handoff.
    let mut previous = (Duration::ZERO, 0u64);
    let mut mic_rate = mic.sample_rate;
    for step in 1..=CALIBRATION_STEPS {
        std::thread::sleep(CALIBRATION_STEP);
        let Some(first_frame_at) = *mic.first_frame_at.lock().expect("mutex poisoned") else {
            continue; // No audio has arrived at all yet - nothing to measure.
        };
        let elapsed = first_frame_at.elapsed();
        let frames = mic.frames_received.load(std::sync::atomic::Ordering::Relaxed);
        let (prev_elapsed, prev_frames) = previous;
        let segment_secs = (elapsed - prev_elapsed).as_secs_f64();
        if segment_secs > 0.0 && frames > prev_frames {
            let segment_rate = ((frames - prev_frames) as f64 / segment_secs).round() as u32;
            eprintln!(
                "mic calibration step {step}/{CALIBRATION_STEPS}: {segment_rate} Hz over this \
                 segment ({} frames in {segment_secs:.2}s)",
                frames - prev_frames
            );
            mic_rate = segment_rate;
        }
        previous = (elapsed, frames);
    }

    let system_rate = loopback.sample_rate;
    eprintln!(
        "recording: mic at {mic_rate} Hz (cpal declared {} Hz), system audio at {system_rate} Hz, writing {OUTPUT_SAMPLE_RATE} Hz",
        mic.sample_rate
    );

    Ok(Started {
        sources: Sources {
            mic: Some(mic),
            loopback: Some(loopback),
        },
        mic: Source::new("mic", mic_rx, mic_rate),
        system: Source::new("system audio", system_rx, system_rate),
    })
}

fn run_session(
    output_path: PathBuf,
    stop_rx: Receiver<()>,
    ready_tx: Sender<Result<(), String>>,
) -> Result<PathBuf, String> {
    // Note the two failure paths below are deliberately different. Nothing is
    // unlinked when *opening* the file is what failed, because in that case
    // this call never created anything: a file may well already exist at that
    // path, and on Unix unlinking it would succeed anyway (removing a
    // directory entry needs write permission on the directory, not the file),
    // so a shared cleanup path could delete a recording this session had
    // nothing to do with.
    let writer = match create_writer(&output_path) {
        Ok(writer) => writer,
        Err(e) => {
            let _ = ready_tx.send(Err(e.clone()));
            return Err(e);
        }
    };

    let started = match start_sources() {
        Ok(started) => started,
        Err(e) => {
            // Here the file *is* ours: `WavWriter::create` truncated whatever
            // was there and wrote a header. Note the leftover is not empty in
            // the 0-byte sense - hound writes the RIFF/fmt/data headers at
            // construction and its `Drop` runs `update_header`, so abandoning
            // it leaves a structurally valid 44-byte WAV containing zero
            // samples. Removing it is what stops that from being listed later
            // as a real (silent) recording.
            drop(writer);
            let _ = std::fs::remove_file(&output_path);
            let _ = ready_tx.send(Err(e.clone()));
            return Err(e);
        }
    };

    let _ = ready_tx.send(Ok(()));

    mix_and_write(
        writer,
        started.sources,
        started.mic,
        started.system,
        &stop_rx,
        output_path,
    )
}

/// One capture source's side of the mixer: its channel, its resampler, the
/// samples it has produced but that have not been mixed yet, and when it last
/// produced anything.
struct Source {
    /// Only used in diagnostics (which source a log line is about) - never
    /// affects mixing behaviour.
    name: &'static str,
    /// The rate this source was opened at, kept around only so a drift
    /// warning can name it - see `drain()`'s drift guard below. This is the
    /// one thing the whole resampling step trusts and never re-verifies
    /// against how much audio is actually arriving; see the postmortem on a
    /// real recording where a source's *reported* rate silently stopped
    /// matching its *actual* delivery rate (root-caused in `mic.rs`/
    /// `loopback_macos.rs`'s own history of silent TCC denials, and in the
    /// `mix_and_write` tests below) for why that trust is worth flagging
    /// loudly rather than papering over.
    input_rate: u32,
    rx: Receiver<Vec<f32>>,
    resampler: Resampler,
    pending: VecDeque<f32>,
    last_data_at: Instant,
    closed: bool,
    total_samples: u64,
    /// How many post-resample samples the drift guard has ever discarded.
    /// Surfaced in the "recording finished" summary - previously this
    /// happened in total silence, which is exactly what let a real rate
    /// mismatch (one source's `pending` backlog growing far faster than the
    /// other's, because its true delivery rate did not match what it
    /// reported) go unnoticed until someone had to reverse-engineer it from
    /// raw sample counts after the fact.
    dropped_samples: u64,
    /// Edge-triggers the drift warning so a sustained mismatch logs once,
    /// not on every 5ms mixing tick.
    was_dropping: bool,
}

impl Source {
    fn new(name: &'static str, rx: Receiver<Vec<f32>>, input_rate: u32) -> Self {
        Self {
            name,
            input_rate,
            rx,
            resampler: Resampler::new(input_rate, OUTPUT_SAMPLE_RATE),
            pending: VecDeque::new(),
            last_data_at: Instant::now(),
            closed: false,
            total_samples: 0,
            dropped_samples: 0,
            was_dropping: false,
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
            self.dropped_samples += excess as u64;
            if !self.was_dropping {
                eprintln!(
                    "{} audio is running persistently ahead of the other source and is being \
                     trimmed to bound buffering - check whether its reported rate ({} Hz) actually \
                     matches what the device is delivering; a stale/wrong rate here silently \
                     corrupts the whole recording (wrong resampling ratio) well before this guard \
                     ever engages, this warning is only the first visible symptom",
                    self.name, self.input_rate
                );
                self.was_dropping = true;
            }
        } else {
            self.was_dropping = false;
        }
    }

    fn is_stalled(&self, now: Instant) -> bool {
        self.closed || now.duration_since(self.last_data_at) > STALL_TIMEOUT
    }
}

fn mix_and_write(
    mut writer: WavWriter<BufWriter<File>>,
    mut sources: Sources,
    mut mic: Source,
    mut system: Source,
    stop_rx: &Receiver<()>,
    output_path: PathBuf,
) -> Result<PathBuf, String> {
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

        let frames = mix_ready_samples(&mut mic, &mut system, Instant::now());
        let wrote_any = !frames.is_empty();
        for (mic_sample, system_sample) in frames {
            // Interleaved stereo: left (mic) then right (system audio) per
            // frame - the order `hound` (and every WAV reader) expects.
            writer
                .write_sample(mic_sample)
                .map_err(|e| format!("Could not write to the recording file: {e}"))?;
            writer
                .write_sample(system_sample)
                .map_err(|e| format!("Could not write to the recording file: {e}"))?;
            written += 1;
        }

        if let Some(since) = stopping {
            let drained = mic.pending.is_empty() && system.pending.is_empty();
            if (drained && mic.closed && system.closed) || since.elapsed() > FINAL_DRAIN {
                break;
            }
        }

        if !wrote_any {
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    writer
        .finalize()
        .map_err(|e| format!("Could not finish the recording file: {e}"))?;

    eprintln!(
        "recording finished: {written} samples written ({:.1}s), mic produced {} (dropped {}), system audio produced {} (dropped {})",
        written as f64 / f64::from(OUTPUT_SAMPLE_RATE),
        mic.total_samples,
        mic.dropped_samples,
        system.total_samples,
        system.dropped_samples,
    );
    Ok(output_path)
}

/// Pairs up everything currently available from both sources into 16-bit PCM
/// stereo frames `(mic_sample, system_sample)` - exactly what the WAV file
/// gets written with, one frame per output sample-time. Split out from
/// `mix_and_write`'s loop so a test can drive the real path against synthetic
/// sources without a real `WavWriter` or real capture channels.
///
/// No summing/clamping between the two any more (see this module's top-level
/// doc comment for why) - each channel is scaled to `i16` independently, so a
/// loud mic and loud system audio at the same instant can no longer clip into
/// each other the way summing them into one channel could.
fn mix_ready_samples(mic: &mut Source, system: &mut Source, now: Instant) -> Vec<(i16, i16)> {
    let n = mixable_len(mic, system, now);
    let mut out = Vec::with_capacity(n);
    for _ in 0..n {
        let m = mic.pending.pop_front().unwrap_or(0.0);
        let s = system.pending.pop_front().unwrap_or(0.0);
        out.push((
            (m.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16,
            (s.clamp(-1.0, 1.0) * f32::from(i16::MAX)) as i16,
        ));
    }
    out
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

    /// An unwritable output path used to be reported as success, because the
    /// WAV file was not opened until after `start_recording` had already
    /// returned - so the failure only surfaced at `stop_recording`, i.e. once
    /// a whole meeting had been recorded into nothing.
    ///
    /// This runs on any machine with no devices and no permissions, precisely
    /// because opening the file now happens before either capture source is
    /// touched; if that ordering is ever reversed, this test starts hanging on
    /// the microphone or the permission prompt instead of failing fast.
    #[test]
    fn an_unwritable_output_path_fails_at_start_not_at_stop() {
        // `RecordingHandle` is deliberately not `Debug` (it owns a join
        // handle), so this matches rather than using `expect_err`.
        match start_recording(Path::new("/no-such-directory-4f3a/out.wav")) {
            Ok(_) => panic!("an unwritable path must not report success"),
            Err(e) => assert!(
                e.contains("Could not create the recording file"),
                "unexpected error: {e}"
            ),
        }
    }

    /// A scratch directory that cleans itself up, so these tests leave nothing
    /// behind in the system temp directory (CLAUDE.md's "clean up test
    /// artifacts" rule).
    struct ScratchDir(PathBuf);

    impl ScratchDir {
        fn new(name: &str) -> Self {
            let dir = std::env::temp_dir().join(format!(
                "meeting-transcriber-test-{}-{name}",
                std::process::id()
            ));
            std::fs::create_dir_all(&dir).expect("scratch dir");
            Self(dir)
        }

        fn path(&self, file: &str) -> PathBuf {
            self.0.join(file)
        }
    }

    impl Drop for ScratchDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Puts a finalized WAV's header back into the state
    /// `WavWriter::create` leaves it in - both length fields still the zero
    /// placeholders it writes up front - which is exactly the state a SIGKILL
    /// freezes a recording in, because neither `finalize()` nor `Drop` ever
    /// runs to fill them in.
    ///
    /// Written by hand rather than by `std::mem::forget`ing a live
    /// `WavWriter`, so the fixture depends on the WAV format itself rather
    /// than on which of hound's internal methods happen to touch the header.
    fn blank_out_wav_length_fields(path: &Path) {
        let mut bytes = std::fs::read(path).expect("read fixture");
        let data_at = bytes
            .windows(4)
            .position(|w| w == b"data")
            .expect("fixture should have a data chunk");
        bytes[4..8].copy_from_slice(&0u32.to_le_bytes());
        bytes[data_at + 4..data_at + 8].copy_from_slice(&0u32.to_le_bytes());
        std::fs::write(path, bytes).expect("write fixture");
    }

    fn write_test_recording(path: &Path, samples: usize) {
        let mut writer = create_writer(path).expect("writer");
        for i in 0..samples {
            writer.write_sample((i % 100) as i16).expect("write sample");
        }
        writer.finalize().expect("finalize");
    }

    /// The whole point of the crash-recovery sweep: a recording the process
    /// was killed in the middle of still has every one of its audio bytes on
    /// disk, but its header says it has none - so uploading it untouched would
    /// transcribe silence and then delete the real audio, which is the exact
    /// data loss the sweep exists to prevent.
    #[test]
    fn repairs_a_recording_whose_writer_never_finalized() {
        let scratch = ScratchDir::new("repair");
        let path = scratch.path("recording-crashed.wav");
        write_test_recording(&path, 1000);
        let finalized_len = std::fs::metadata(&path).expect("metadata").len();

        blank_out_wav_length_fields(&path);
        assert_eq!(
            hound::WavReader::open(&path).expect("reader").len(),
            0,
            "the fixture must reproduce the real failure: a valid WAV that reads as empty"
        );

        assert_eq!(repair_unfinalized_wav(&path), Ok(true));

        assert_eq!(std::fs::metadata(&path).expect("metadata").len(), finalized_len);
        let mut reader = hound::WavReader::open(&path).expect("reader");
        assert_eq!(reader.len(), 1000);
        let samples: Vec<i16> = reader.samples::<i16>().map(|s| s.expect("sample")).collect();
        assert_eq!(samples.first(), Some(&0));
        assert_eq!(samples.last(), Some(&((999 % 100) as i16)));
    }

    /// A file cut mid-frame must lose only that frame, not be rejected and not
    /// be left claiming a length the file does not have.
    #[test]
    fn drops_a_trailing_partial_frame() {
        let scratch = ScratchDir::new("partial");
        let path = scratch.path("recording-truncated.wav");
        write_test_recording(&path, 1000);
        let full_len = std::fs::metadata(&path).expect("metadata").len();
        blank_out_wav_length_fields(&path);

        // One byte into a four-byte stereo frame (2 channels x 16-bit),
        // exactly what a kill mid-write leaves.
        let file = std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .expect("open");
        file.set_len(full_len - 1).expect("truncate");
        drop(file);

        assert_eq!(repair_unfinalized_wav(&path), Ok(true));
        // 1000 sample values (500 stereo frames) minus the one truncated
        // trailing frame (3 of its 4 bytes survived, still not a whole frame)
        // = 499 frames = 998 sample values.
        assert_eq!(hound::WavReader::open(&path).expect("reader").len(), 998);
    }

    /// `create_writer` runs before either capture source starts, so a crash in
    /// the window between them leaves a header with no audio behind it.
    /// Uploading that would create an empty meeting; the sweep deletes it
    /// instead, which is why this case is `Ok(false)` and not `Ok(true)`.
    #[test]
    fn reports_a_header_only_leftover_as_holding_no_audio() {
        let scratch = ScratchDir::new("empty");
        let path = scratch.path("recording-empty.wav");
        write_test_recording(&path, 0);
        assert_eq!(repair_unfinalized_wav(&path), Ok(false));
        blank_out_wav_length_fields(&path);
        assert_eq!(repair_unfinalized_wav(&path), Ok(false));
    }

    /// An already-finalized recording (the app died between `stop_recording`
    /// and the upload) must come back untouched, byte for byte.
    #[test]
    fn leaves_an_already_finalized_recording_alone() {
        let scratch = ScratchDir::new("finalized");
        let path = scratch.path("recording-fine.wav");
        write_test_recording(&path, 500);
        let before = std::fs::read(&path).expect("read");
        assert_eq!(repair_unfinalized_wav(&path), Ok(true));
        assert_eq!(std::fs::read(&path).expect("read"), before);
    }

    /// Anything that is not one of our WAVs is an error, not a `false` - the
    /// sweep must leave a stranger's file alone rather than rewriting four
    /// bytes of it on a guess.
    #[test]
    fn refuses_to_touch_a_file_that_is_not_a_wav() {
        let scratch = ScratchDir::new("not-a-wav");
        let path = scratch.path("recording-bogus.wav");
        std::fs::write(&path, b"this is not a wave file at all").expect("write");
        assert!(repair_unfinalized_wav(&path).is_err());

        let tiny = scratch.path("recording-tiny.wav");
        std::fs::write(&tiny, b"RIF").expect("write");
        assert!(repair_unfinalized_wav(&tiny).is_err());
    }

    #[test]
    fn mixes_the_shorter_backlog_so_sources_stay_in_lockstep() {
        let (_tx_a, rx_a) = unbounded();
        let (_tx_b, rx_b) = unbounded();
        let mut mic = Source::new("mic", rx_a, OUTPUT_SAMPLE_RATE);
        let mut system = Source::new("system audio", rx_b, OUTPUT_SAMPLE_RATE);
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
        let mut mic = Source::new("mic", rx_a, OUTPUT_SAMPLE_RATE);
        let system = Source::new("system audio", rx_b, OUTPUT_SAMPLE_RATE);
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

    /// The drift guard used to discard excess backlog in total silence - no
    /// counter, no log line, nothing. That is exactly what let a real rate
    /// mismatch (see `mixing_two_real_tones_produces_non_silent_output_with_both_frequencies`
    /// below and the module-level audit notes) go unnoticed until someone had
    /// to reverse-engineer it from raw sample counts after the fact. This
    /// pins down that dropped samples are now counted and a warning fires
    /// exactly once per sustained drop, not on every 5ms mixing tick.
    #[test]
    fn drift_guard_counts_what_it_drops_and_warns_once() {
        let (_tx, rx) = unbounded();
        let mut mic = Source::new("mic", rx, OUTPUT_SAMPLE_RATE);
        mic.pending.extend(vec![0.1; MAX_BUFFERED_SAMPLES + 500]);

        mic.drain();
        assert_eq!(mic.pending.len(), MAX_BUFFERED_SAMPLES);
        assert_eq!(mic.dropped_samples, 500);
        assert!(mic.was_dropping, "should have flagged itself as dropping");

        // Draining again while still over the cap keeps counting, but the
        // warning itself only needs to fire once per sustained episode - the
        // edge flag (not asserted directly here, since it is private
        // bookkeeping) is what a maintainer would check in the eprintln
        // output, not in this test.
        mic.pending.extend(vec![0.1; 200]);
        mic.drain();
        assert_eq!(mic.dropped_samples, 700);

        // Once the backlog is back under the cap, the flag resets so a
        // *second* unrelated drift episode would warn again instead of
        // staying silent forever after the first one.
        mic.pending.clear();
        mic.drain();
        assert!(!mic.was_dropping);
    }

    /// End-to-end reproduction of the real failing recording's exact rates:
    /// a 440 Hz tone standing in for the microphone at 24 kHz (its reported
    /// native rate in that run) and an 880 Hz tone standing in for system
    /// audio at 48 kHz (its reported native rate). Both run through the real
    /// `Source` / `Resampler` / `mixable_len` / `mix_ready_samples` path -
    /// the same code `mix_and_write` uses - with no `WavWriter` or real
    /// capture device involved.
    ///
    /// This passing is what rules the *mixer* out as the cause of the real
    /// bug ("content is silent/unusable despite plausible, non-zero sample
    /// counts"): given genuinely correct per-source rates, the mixing and
    /// resampling code faithfully reproduces both tones. That means the real
    /// recording's problem has to be upstream of this code - either the
    /// sources handing the mixer content that is not what it claims to be
    /// (see `mic.rs`'s and `loopback_macos.rs`'s own documented history of
    /// silent TCC denials, where a tap/stream reports success but delivers
    /// zeroed audio), or a source's *reported* rate not matching what it is
    /// actually delivering (which this test cannot exercise - it always
    /// feeds the resampler an accurate rate for its input).
    #[test]
    fn mixing_two_real_tones_produces_non_silent_output_with_both_frequencies() {
        let (mic_tx, mic_rx) = unbounded();
        let (system_tx, system_rx) = unbounded();
        let mut mic = Source::new("mic", mic_rx, 24_000);
        let mut system = Source::new("system audio", system_rx, 48_000);

        let seconds = 1.0;
        let mic_tone = sine_wave(440.0, 24_000, seconds);
        let system_tone = sine_wave(880.0, 48_000, seconds);
        // Delivered in small chunks, like real cpal/tap callbacks, so the
        // resampler's cross-chunk state is actually exercised rather than
        // resampling one giant buffer in one shot.
        for chunk in mic_tone.chunks(240) {
            mic_tx.send(chunk.to_vec()).expect("send");
        }
        for chunk in system_tone.chunks(480) {
            system_tx.send(chunk.to_vec()).expect("send");
        }
        drop(mic_tx);
        drop(system_tx);
        mic.drain();
        system.drain();

        let now = Instant::now();
        let mut mic_out = Vec::new();
        let mut system_out = Vec::new();
        loop {
            let frames = mix_ready_samples(&mut mic, &mut system, now);
            if frames.is_empty() {
                break;
            }
            for (m, s) in frames {
                mic_out.push(m);
                system_out.push(s);
            }
        }

        assert!(!mic_out.is_empty(), "two real tones produced no output at all");

        let mic_peak = mic_out.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
        let system_peak = system_out.iter().map(|s| s.unsigned_abs()).max().unwrap_or(0);
        assert!(mic_peak > 5000, "mic channel should have real amplitude, got peak {mic_peak}");
        assert!(
            system_peak > 5000,
            "system channel should have real amplitude, got peak {system_peak}"
        );

        // Each source tone should be recoverable from its *own* channel, not
        // drowned out or replaced by noise/silence - a coarse correlation
        // check against each pure tone, not a full FFT.
        let mic_out_f32: Vec<f32> = mic_out.iter().map(|&s| f32::from(s)).collect();
        let system_out_f32: Vec<f32> = system_out.iter().map(|&s| f32::from(s)).collect();
        let mic_ref = sine_wave(440.0, OUTPUT_SAMPLE_RATE, seconds);
        let system_ref = sine_wave(880.0, OUTPUT_SAMPLE_RATE, seconds);
        let mic_corr = correlation(&mic_out_f32, &mic_ref);
        let system_corr = correlation(&system_out_f32, &system_ref);
        assert!(
            mic_corr > 0.5,
            "mic channel's 440 Hz tone should be present, correlation {mic_corr:.3}"
        );
        assert!(
            system_corr > 0.5,
            "system channel's 880 Hz tone should be present, correlation {system_corr:.3}"
        );

        // Channel isolation, meaningful now that the two are never summed:
        // the mic channel must not contain the system tone, and vice versa.
        let mic_cross = correlation(&mic_out_f32, &system_ref);
        let system_cross = correlation(&system_out_f32, &mic_ref);
        assert!(
            mic_cross.abs() < 0.3,
            "mic channel should not contain the system tone, cross-correlation {mic_cross:.3}"
        );
        assert!(
            system_cross.abs() < 0.3,
            "system channel should not contain the mic tone, cross-correlation {system_cross:.3}"
        );
    }

    fn sine_wave(freq_hz: f64, rate: u32, seconds: f64) -> Vec<f32> {
        let n = (f64::from(rate) * seconds) as usize;
        (0..n)
            .map(|i| {
                let t = i as f64 / f64::from(rate);
                (2.0 * std::f64::consts::PI * freq_hz * t).sin() as f32 * 0.5
            })
            .collect()
    }

    /// Zero-lag Pearson correlation, used only to check that a known tone is
    /// still present in the mixed output - proportionate for a hand-written
    /// linear resampler feeding speech-oriented audio, not a claim of
    /// spectral precision.
    fn correlation(a: &[f32], b: &[f32]) -> f64 {
        let n = a.len().min(b.len());
        let a = &a[..n];
        let b = &b[..n];
        let mean_a = a.iter().map(|&x| f64::from(x)).sum::<f64>() / n as f64;
        let mean_b = b.iter().map(|&x| f64::from(x)).sum::<f64>() / n as f64;
        let mut num = 0.0;
        let mut den_a = 0.0;
        let mut den_b = 0.0;
        for i in 0..n {
            let da = f64::from(a[i]) - mean_a;
            let db = f64::from(b[i]) - mean_b;
            num += da * db;
            den_a += da * da;
            den_b += db * db;
        }
        num / (den_a.sqrt() * den_b.sqrt())
    }
}
