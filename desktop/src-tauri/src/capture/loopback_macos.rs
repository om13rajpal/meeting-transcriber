//! macOS system-audio ("loopback") capture via Apple's ScreenCaptureKit.
//!
//! API notes, taken from reading the real source of `screencapturekit` 9.0.1
//! (not from the plan, whose example version numbers predate this crate's
//! entire 4.x-9.x API rewrite):
//!
//! - There is no audio-only entry point. ScreenCaptureKit models system audio
//!   as a second *output type* on a screen-capture stream, so you always build
//!   a display filter first and then ask the configuration for audio:
//!   `SCShareableContent::get()` -> `.displays()` ->
//!   `SCContentFilter::create().with_display(&d).with_excluding_windows(&[]).build()`.
//! - `SCShareableContent::get()` is the permission gate. With Screen Recording
//!   permission missing or denied it fails with `SCError::NoShareableContent`,
//!   and on a first run it is also what triggers the OS prompt. That is why the
//!   permission wording below hangs off this specific call.
//! - `SCStreamConfiguration::new().with_captures_audio(true).with_sample_rate(i32)
//!   .with_channel_count(i32).with_excludes_current_process_audio(bool)` - none
//!   of these four are behind a `macos_*` cargo feature in 9.0.1 (only
//!   `captures_microphone` and `microphone_capture_device_id` are), so the
//!   crate's default feature set is enough for what this module needs.
//! - Samples arrive through `SCStreamOutputTrait::did_output_sample_buffer(
//!   &self, CMSampleBuffer, SCStreamOutputType)`, registered with
//!   `stream.add_output_handler(handler, SCStreamOutputType::Audio)`. The trait
//!   requires `Send + Sync` because ScreenCaptureKit invokes it on its own
//!   dispatch queue, which is a different OS thread over time.
//! - Audio bytes come out via the `CMSampleBufferExt::audio_buffer_list()`
//!   extension trait, which yields an `AudioBufferList` of `AudioBuffer`s. Each
//!   `AudioBuffer` exposes only `number_channels()` and `data() -> &[u8]`; the
//!   crate does NOT expose the `AudioStreamBasicDescription`, so the layout
//!   (planar vs. interleaved) has to be inferred from the buffer count and
//!   per-buffer channel count - see `sample_buffer_to_mono` below, which
//!   handles both rather than betting on one.
//! - `SCStream` is `Send + Sync` and its `Drop` releases the native stream and
//!   the handler registry (and with them our `Sender`), so `LoopbackHandle`
//!   just owns the stream, exactly mirroring how `mic.rs` owns a `cpal::Stream`.

use crossbeam_channel::Sender;
use screencapturekit::cm::CMSampleBufferExt;
use screencapturekit::prelude::{
    CMSampleBuffer, CMTime, SCContentFilter, SCError, SCShareableContent, SCStream,
    SCStreamConfiguration, SCStreamOutputTrait, SCStreamOutputType,
};
use std::sync::atomic::{AtomicBool, Ordering};

/// The rate we ask ScreenCaptureKit for. Reported back on the handle so the
/// mixer resamples against a real number instead of a global constant that
/// nobody re-checked - see `capture/mod.rs`.
const SYSTEM_AUDIO_SAMPLE_RATE: u32 = 48_000;
const SYSTEM_AUDIO_CHANNELS: i32 = 2;

/// ScreenCaptureKit has no audio-only stream, so a video stream is captured
/// alongside and immediately thrown away (we register no `Screen` handler).
/// Keeping it tiny and slow makes that unavoidable work as close to free as
/// the framework allows. 2x2 is rejected by some macOS versions as degenerate,
/// so this stays at a small-but-ordinary size.
const THROWAWAY_VIDEO_SIZE: u32 = 64;

pub struct LoopbackHandle {
    stream: SCStream,
    _awake: DisplaySleepAssertion,
    /// The sample rate this source is actually producing at.
    pub sample_rate: u32,
}

impl Drop for LoopbackHandle {
    fn drop(&mut self) {
        // Mirrors cpal's "dropping the stream stops capture" contract, so both
        // capture sources behave identically from the mixer's point of view.
        if let Err(e) = self.stream.stop_capture() {
            eprintln!("system audio capture failed to stop cleanly: {e}");
        }
    }
}

/// Wakes the display, blocking until it is actually on.
///
/// Per `caffeinate(8)`, `-d` and `-i` are purely *preventive* - they stop a
/// display that is currently on from sleeping, and do nothing whatsoever to a
/// display that is already off. `-u` is the only flag that "turns the display
/// on", and its timeout has to be given as `-t`, which applies to the whole
/// invocation - so this cannot be folded into the long-lived `-d -i` assertion
/// below and has to be its own short-lived child.
///
/// This matters because an already-asleep display makes ScreenCaptureKit's
/// `displays()` come back empty, which is a hard failure to start recording at
/// all. Waiting for the one-second assertion to expire (rather than spawning
/// and racing on) is what guarantees the display is up before we enumerate.
///
/// That one second is also why the caller only reaches this after seeing an
/// empty display list, rather than calling it unconditionally up front.
fn wake_display() {
    match std::process::Command::new("/usr/bin/caffeinate")
        .args(["-u", "-t", "1"])
        .status()
    {
        Ok(_) => {}
        // Not fatal on its own: if the display was already awake (the usual
        // case) nothing was needed, and if it was not, the empty-display error
        // below says so in plain language.
        Err(e) => eprintln!("could not wake the display for recording: {e}"),
    }
}

/// Keeps the display awake for as long as it is alive.
///
/// This is not a nicety. ScreenCaptureKit stops delivering audio when the
/// display sleeps - measured, not assumed: a 15-second recording left to idle
/// produced only 7.0 seconds of system audio and then went silent, while the
/// identical recording wrapped in `caffeinate -d` produced the full 15.0
/// seconds. A meeting is exactly the situation where nobody touches the
/// keyboard for ten minutes, so without this the far side of a call goes
/// missing partway through and the file still looks fine.
///
/// `caffeinate` is a base-OS tool, so this costs no dependency and no `unsafe`
/// IOKit FFI; the alternative is `IOPMAssertionCreateWithName`, which would
/// need CoreFoundation string plumbing for the same effect. `-d` blocks
/// display sleep (the one that actually kills the stream) and `-i` blocks idle
/// system sleep. Neither wakes a sleeping display - see `wake_display`.
///
/// `-w <our pid>` is what makes this safe against an abnormal exit: `Drop`
/// never runs if the app is SIGKILLed or aborts, and a `caffeinate` orphaned
/// that way would hold the user's display awake indefinitely with nothing on
/// screen to explain why. With `-w`, the kernel reaping our process releases
/// the assertion no matter how we died.
struct DisplaySleepAssertion(Option<std::process::Child>);

impl DisplaySleepAssertion {
    fn hold() -> Self {
        match std::process::Command::new("/usr/bin/caffeinate")
            .args(["-d", "-i", "-w", &std::process::id().to_string()])
            .spawn()
        {
            Ok(child) => Self(Some(child)),
            Err(e) => {
                // Recording is still worth doing without it; it just stops
                // early if the machine is left completely idle.
                eprintln!("could not hold the display awake for recording: {e}");
                Self(None)
            }
        }
    }
}

impl Drop for DisplaySleepAssertion {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            // Reap it, so a long session that starts and stops recording
            // repeatedly does not accumulate zombies.
            let _ = child.wait();
        }
    }
}

struct AudioForwarder {
    tx: Sender<Vec<f32>>,
    logged_layout: AtomicBool,
}

impl SCStreamOutputTrait for AudioForwarder {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, of_type: SCStreamOutputType) {
        if of_type != SCStreamOutputType::Audio {
            return;
        }
        let Some(list) = sample.audio_buffer_list() else {
            return;
        };

        // The layout ScreenCaptureKit actually delivers is not in this crate's
        // API surface, and it is the one thing that would silently produce
        // half-speed or channel-swapped audio if guessed wrong. Log what the
        // first buffer really looked like, once, so a maintainer can confirm it
        // from a real run instead of re-deriving it from Apple's headers.
        if !self.logged_layout.swap(true, Ordering::Relaxed) {
            let shape: Vec<String> = list
                .iter()
                .map(|b| format!("{}ch/{}B", b.number_channels(), b.data_byte_size()))
                .collect();
            eprintln!(
                "system audio layout: {} buffer(s) [{}]",
                list.num_buffers(),
                shape.join(", ")
            );
        }

        let mono = audio_buffer_list_to_mono(&list);
        if !mono.is_empty() {
            let _ = self.tx.send(mono);
        }
    }
}

/// Flattens whatever `AudioBufferList` layout arrived into mono `f32`.
///
/// ScreenCaptureKit delivers non-interleaved 32-bit float in practice: one
/// `AudioBuffer` per channel, each reporting `number_channels() == 1`. Nothing
/// in the API promises that, though, so the interleaved shape (one buffer
/// reporting N channels) is handled too. Both collapse to the same mono
/// average, so getting the layout classification right is the only thing that
/// matters, and a wrong guess would be audible immediately rather than subtle.
fn audio_buffer_list_to_mono(list: &screencapturekit::cm::AudioBufferList) -> Vec<f32> {
    let planes: Vec<Vec<f32>> = list
        .iter()
        .map(|buffer| bytes_to_f32(buffer.data()))
        .collect();
    if planes.is_empty() {
        return Vec::new();
    }

    if planes.len() == 1 {
        // Single buffer: either already mono, or interleaved across N channels.
        let channels = list.get(0).map_or(1, |b| b.number_channels()).max(1) as usize;
        let plane = &planes[0];
        if channels <= 1 {
            return plane.clone();
        }
        return plane
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect();
    }

    // Multiple buffers: planar, one channel per buffer. Short planes would
    // desynchronise the average, so only the frames every plane has are used.
    let frames = planes.iter().map(Vec::len).min().unwrap_or(0);
    let plane_count = planes.len() as f32;
    (0..frames)
        .map(|i| planes.iter().map(|p| p[i]).sum::<f32>() / plane_count)
        .collect()
}

/// `AudioBuffer::data()` hands back raw bytes with no alignment guarantee, so
/// this decodes them 4 at a time rather than transmuting the slice.
fn bytes_to_f32(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

/// Starts capturing everything playing out of the system's speakers, sending
/// chunks of mono `f32` samples to `tx`.
pub fn start_system_audio_capture(tx: Sender<Vec<f32>>) -> Result<LoopbackHandle, String> {
    // First real call into ScreenCaptureKit, and therefore the point where a
    // missing Screen Recording grant shows up (and where the OS prompt fires
    // on a first run).
    // Keeps the display from sleeping for the rest of the recording. Cheap
    // (a spawn), and it does not wake anything - see its doc comment.
    let awake = DisplaySleepAssertion::hold();

    // An asleep display reports no displays at all, and there is nothing to
    // build a content filter from. That is the *only* case that needs waking,
    // so it is detected rather than assumed: `wake_display()` costs a full
    // second, and paying that on every recording start would tax the normal
    // case (a user clicking Record while looking at the screen) to fix a rare
    // one.
    let mut displays = SCShareableContent::get().map_err(describe_error)?.displays();
    if displays.is_empty() {
        wake_display();
        displays = SCShareableContent::get().map_err(describe_error)?.displays();
    }

    let display = displays.into_iter().next().ok_or(
        "No display was found to capture system audio from. \
         Wake the screen and start recording again.",
    )?;

    let filter = SCContentFilter::create()
        .with_display(&display)
        .with_excluding_windows(&[])
        .build();

    let config = SCStreamConfiguration::new()
        .with_width(THROWAWAY_VIDEO_SIZE)
        .with_height(THROWAWAY_VIDEO_SIZE)
        // One frame per second of video we never read.
        .with_minimum_frame_interval(&CMTime::new(1, 1))
        .with_captures_audio(true)
        .with_sample_rate(SYSTEM_AUDIO_SAMPLE_RATE as i32)
        .with_channel_count(SYSTEM_AUDIO_CHANNELS)
        // Without this, anything this app itself plays would be recorded back
        // into the meeting audio.
        .with_excludes_current_process_audio(true);

    let mut stream = SCStream::new(&filter, &config);
    stream.add_output_handler(
        AudioForwarder {
            tx,
            logged_layout: AtomicBool::new(false),
        },
        SCStreamOutputType::Audio,
    );

    stream.start_capture().map_err(describe_error)?;

    Ok(LoopbackHandle {
        stream,
        _awake: awake,
        sample_rate: SYSTEM_AUDIO_SAMPLE_RATE,
    })
}

/// Turns a ScreenCaptureKit failure into something worth putting in front of a
/// user. The permission case gets the exact remediation steps, because it is
/// both the most likely failure and the only one the user can actually fix;
/// everything else keeps Apple's own message, which is already user-facing
/// text (an `NSError` localised description), not an internal detail.
fn describe_error(error: SCError) -> String {
    let raw = error.to_string();
    let looks_like_permission = matches!(error, SCError::NoShareableContent(_))
        || matches!(error, SCError::PermissionDenied(_))
        // -3801 is SCStreamErrorCode::UserDeclined.
        || raw.contains("-3801")
        || raw.to_lowercase().contains("declined");

    if looks_like_permission {
        return PERMISSION_DENIED_MESSAGE.to_string();
    }
    format!("Could not start system audio capture: {raw}")
}

/// Shared with Task 8's permission-denial UI - keep the two in step.
pub const PERMISSION_DENIED_MESSAGE: &str =
    "Screen Recording permission is required to record the other side of a call. \
     Open System Settings → Privacy & Security → Screen & System Audio Recording, \
     enable Meeting Transcriber, then start recording again.";

#[cfg(test)]
mod tests {
    use super::*;

    /// The assertion has to actually run `caffeinate` and actually reap it -
    /// a silently-failed spawn would look identical to a working one until a
    /// meeting quietly lost its second half.
    #[test]
    fn display_sleep_assertion_starts_and_is_reaped() {
        let assertion = DisplaySleepAssertion::hold();
        let pid = assertion.0.as_ref().expect("caffeinate should spawn").id();
        let running = std::process::Command::new("/bin/ps")
            .args(["-o", "args=", "-p", &pid.to_string()])
            .output()
            .expect("ps");
        let argv = String::from_utf8_lossy(&running.stdout).to_string();
        assert!(
            argv.contains("caffeinate"),
            "caffeinate should be running while the assertion is held"
        );
        // `-w <our pid>` is the crash-safety net: without it an abnormal exit
        // (SIGKILL, abort) leaves the display pinned awake forever, because
        // Drop never runs.
        assert!(
            argv.contains(&format!("-w {}", std::process::id())),
            "assertion must be tied to this process's lifetime, got: {argv}"
        );

        drop(assertion);

        // Killed and waited for, so it is neither alive nor a zombie.
        let after = std::process::Command::new("/bin/ps")
            .args(["-p", &pid.to_string()])
            .output()
            .expect("ps");
        assert!(
            !String::from_utf8_lossy(&after.stdout).contains("caffeinate"),
            "caffeinate should be gone once the assertion is dropped"
        );
    }

    #[test]
    fn decodes_little_endian_f32_bytes() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&1.0f32.to_le_bytes());
        bytes.extend_from_slice(&(-0.5f32).to_le_bytes());
        // A trailing partial sample is dropped rather than misread.
        bytes.push(0x00);
        assert_eq!(bytes_to_f32(&bytes), vec![1.0, -0.5]);
    }
}
