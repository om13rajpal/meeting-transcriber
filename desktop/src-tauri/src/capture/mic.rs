use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use crossbeam_channel::Sender;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

/// A running microphone capture.
///
/// IMPORTANT: `cpal`'s design means the `Stream` itself owns the capture -
/// dropping it (going out of scope, or being the last reference collected)
/// stops the underlying platform audio callback immediately, silently, with
/// no error. The caller MUST hold on to this struct for as long as capture
/// should continue (e.g. store it in app state), not just call
/// `start_mic_capture` and discard the result.
pub struct MicCapture {
    pub stream: cpal::Stream,
    /// The rate `cpal` actually negotiated with the device, which is NOT
    /// guaranteed to match the loopback source's rate - the mixer in
    /// `capture/mod.rs` resamples based on this rather than assuming.
    pub sample_rate: u32,
    /// Raw (pre-downmix) *frames* received so far, and when the first one
    /// arrived. A real recording proved `sample_rate` above cannot always be
    /// trusted (cpal/CoreAudio reported 24 kHz while the device demonstrably
    /// delivered far more data than that over real wall-clock time) - these
    /// let a caller compute the mic's *actual* empirical delivery rate
    /// (`frames_received / elapsed`) at any point, to check it against what
    /// was negotiated rather than assuming they match.
    pub frames_received: Arc<AtomicU64>,
    pub first_frame_at: Arc<Mutex<Option<Instant>>>,
}

/// What to tell the user when the microphone is there but the OS will not let
/// this app open it. Named per platform because the two Settings apps have
/// genuinely different paths, and a macOS-worded instruction shown on Windows
/// (which is what this file used to do for the no-device case) is worse than
/// no instruction at all - it sends the user looking for a pane that does not
/// exist.
#[cfg(target_os = "macos")]
const PERMISSION_DENIED_MESSAGE: &str =
    "Microphone access is required to record your side of a call. \
     Open System Settings → Privacy & Security → Microphone, enable \
     Meeting Transcriber, then start recording again.";

#[cfg(target_os = "macos")]
const NO_DEVICE_MESSAGE: &str =
    "No microphone was found. Plug one in, or check System Settings → \
     Privacy & Security → Microphone, then start recording again.";

#[cfg(target_os = "windows")]
const PERMISSION_DENIED_MESSAGE: &str =
    "Microphone access is required to record your side of a call. \
     Open Settings → Privacy & security → Microphone, turn on \
     \"Let desktop apps access your microphone\", then start recording again.";

// Windows' microphone privacy setting hides the endpoint from enumeration
// altogether rather than failing the open, so "no device" and "blocked" are
// the same observation on this platform and the message has to cover both.
#[cfg(target_os = "windows")]
const NO_DEVICE_MESSAGE: &str =
    "No microphone was found. Plug one in, or open Settings → Privacy & \
     security → Microphone and turn on \"Let desktop apps access your \
     microphone\", then start recording again.";

/// Whether an audio-backend error string is really the OS refusing access.
///
/// `cpal` flattens every platform failure into `BackendSpecific { description }`,
/// a plain string, so there is no error variant to match on - the OS's own
/// wording is all there is to go on. Deliberately kept to unambiguous markers:
/// a false positive would replace a real, actionable error (no device, device
/// in use) with permission instructions that would not help, so anything not
/// matched here keeps its own message rather than being guessed at.
fn looks_like_permission_denial(raw: &str) -> bool {
    let lower = raw.to_lowercase();
    lower.contains("permission")
        || lower.contains("not authorized")
        || lower.contains("unauthorized")
        // Windows E_ACCESSDENIED, by name and by HRESULT.
        || lower.contains("access is denied")
        || lower.contains("accessdenied")
        || lower.contains("0x80070005")
}

/// Turns a `cpal` failure into something worth putting in front of a user.
///
/// Follows the same rule as `loopback_macos.rs`'s `describe_error`, and the
/// same reason (CLAUDE.md's "never return internals"): the one failure the
/// user can actually fix gets exact remediation steps, everything else keeps
/// a short description of what was being attempted plus the backend's own
/// text, which is already user-facing wording rather than an internal detail.
fn describe_error(context: &str, raw: String) -> String {
    if looks_like_permission_denial(&raw) {
        return PERMISSION_DENIED_MESSAGE.to_string();
    }
    format!("{context}: {raw}")
}

/// Finds the Mac's built-in microphone via raw Core Audio, independent of
/// whatever `cpal` considers the current default input device.
///
/// There is no cross-platform `cpal` API for this (device transport type -
/// built-in, USB, Bluetooth, etc. - is a macOS/CoreAudio-specific concept),
/// so this reads `kAudioHardwarePropertyDevices` directly, using exactly the
/// same property-reading pattern as `loopback_macos.rs` (see that file's
/// module doc for why these are read straight from the pinned crate sources
/// rather than assumed). A device qualifies if its `kAudioDevicePropertyTransportType`
/// is `kAudioDeviceTransportTypeBuiltIn` *and* it has at least one input
/// stream - Macs expose built-in speakers and the built-in mic as two
/// separate device objects that both report the same transport type, so
/// transport type alone is not enough to tell them apart.
///
/// Matches the result back to a `cpal::Device` by name (not by
/// `AudioObjectID`, which `cpal`'s cross-platform `Device` type does not
/// expose) - CoreAudio's own device name is what `cpal` reports for
/// `Device::name()` on macOS, so this is a reliable match, not a guess.
#[cfg(target_os = "macos")]
fn builtin_input_device(host: &cpal::Host) -> Option<(objc2_core_audio::AudioObjectID, cpal::Device)> {
    use objc2_core_audio::{
        kAudioDeviceTransportTypeBuiltIn, kAudioDevicePropertyStreams,
        kAudioDevicePropertyTransportType, kAudioHardwarePropertyDevices,
        kAudioObjectPropertyElementMain, kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal,
        kAudioObjectPropertyScopeInput, kAudioObjectSystemObject, AudioObjectGetPropertyData,
        AudioObjectGetPropertyDataSize, AudioObjectID, AudioObjectPropertyAddress,
    };
    use objc2_core_foundation::{CFRetained, CFString};
    use std::ffi::c_void;
    use std::ptr::NonNull;

    fn address(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress {
            mSelector: selector,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain,
        }
    }

    // SAFETY (for every `unsafe` block below): each follows the exact same
    // "query size, allocate, read" or "read a fixed-size value" pattern
    // documented and used throughout `loopback_macos.rs` - `in_address` is
    // always a valid stack reference, and output buffers are always sized to
    // match what was just measured or the type being read.
    unsafe fn has_input_stream(id: AudioObjectID) -> bool {
        let addr = address(kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput);
        let mut size: u32 = 0;
        let status = AudioObjectGetPropertyDataSize(
            id,
            NonNull::from(&addr),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
        );
        status == 0 && size > 0
    }

    unsafe fn transport_type(id: AudioObjectID) -> Option<u32> {
        let addr = address(kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal);
        let mut size = std::mem::size_of::<u32>() as u32;
        let mut value: u32 = 0;
        let status = AudioObjectGetPropertyData(
            id,
            NonNull::from(&addr),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut value).cast::<c_void>(),
        );
        (status == 0).then_some(value)
    }

    unsafe fn device_name(id: AudioObjectID) -> Option<String> {
        let addr = address(kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal);
        let mut size = std::mem::size_of::<*const c_void>() as u32;
        let mut raw: *const c_void = std::ptr::null();
        let status = AudioObjectGetPropertyData(
            id,
            NonNull::from(&addr),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut raw).cast::<c_void>(),
        );
        if status != 0 {
            return None;
        }
        let ptr = NonNull::new(raw.cast_mut().cast::<CFString>())?;
        // SAFETY: a `kAudioObjectPropertyName` read hands back an
        // already-retained `CFStringRef`, same as `loopback_macos.rs`'s
        // `get_cfstring_property` for `kAudioDevicePropertyDeviceUID`.
        Some(CFRetained::from_raw(ptr).to_string())
    }

    let system_object = kAudioObjectSystemObject as AudioObjectID;
    let addr = address(kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal);
    let mut size: u32 = 0;
    let size_ok = unsafe {
        AudioObjectGetPropertyDataSize(
            system_object,
            NonNull::from(&addr),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
        )
    };
    if size_ok != 0 {
        return None;
    }
    let count = size as usize / std::mem::size_of::<AudioObjectID>();
    let mut ids = vec![0u32; count];
    if count == 0 {
        return None;
    }
    let data_ok = unsafe {
        AudioObjectGetPropertyData(
            system_object,
            NonNull::from(&addr),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::new(ids.as_mut_ptr().cast::<c_void>())?,
        )
    };
    if data_ok != 0 {
        return None;
    }

    let (builtin_id, builtin_name) = ids.into_iter().find_map(|id| unsafe {
        if transport_type(id) == Some(kAudioDeviceTransportTypeBuiltIn) && has_input_stream(id) {
            device_name(id).map(|name| (id, name))
        } else {
            None
        }
    })?;

    let device = host
        .input_devices()
        .ok()?
        .find(|d| d.to_string() == builtin_name)?;
    Some((builtin_id, device))
}

/// Reads `kAudioHardwarePropertyDefaultInputDevice`, for `set_input_volume_max`
/// to target when `builtin_input_device` found nothing and `start_mic_capture`
/// fell back to `cpal`'s own default - there is no `AudioObjectID` to recover
/// from a `cpal::Device` after the fact, so the fallback path has to look this
/// up independently rather than reuse `builtin_input_device`'s result.
#[cfg(target_os = "macos")]
fn default_input_device_id() -> Option<objc2_core_audio::AudioObjectID> {
    use objc2_core_audio::{
        kAudioHardwarePropertyDefaultInputDevice, kAudioObjectPropertyElementMain,
        kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, AudioObjectGetPropertyData,
        AudioObjectID, AudioObjectPropertyAddress,
    };
    use std::ffi::c_void;
    use std::ptr::NonNull;

    let addr = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let mut id: AudioObjectID = 0;
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            NonNull::from(&addr),
            0,
            std::ptr::null(),
            NonNull::from(&mut size),
            NonNull::from(&mut id).cast::<c_void>(),
        )
    };
    (status == 0).then_some(id)
}

/// Sets the input device's volume as high as it goes. Requested so a
/// recording never comes out unusably quiet because of whatever the system's
/// input volume happened to be set to - meetings are typically recorded
/// unattended, with nobody watching an input level meter to notice and fix a
/// low setting mid-call.
///
/// Tries the master/main element first (what most devices, including this
/// Mac's built-in mic, expose for input volume); some devices only expose a
/// per-channel volume instead, so this also tries channels 1 and 2 (built-in
/// mics are mono, but this costs nothing extra to cover a stereo one too).
/// Every attempt is a plain best-effort: `AudioObjectHasProperty` is checked
/// first so this never asks a device to set a control it does not have, and a
/// device with no volume control at all (some digital/USB mics fix their gain
/// in hardware) is left alone rather than erroring the whole recording over a
/// non-essential nicety.
#[cfg(target_os = "macos")]
fn set_input_volume_max(id: objc2_core_audio::AudioObjectID) {
    use objc2_core_audio::{
        kAudioDevicePropertyVolumeScalar, kAudioObjectPropertyElementMain,
        kAudioObjectPropertyScopeInput, AudioObjectHasProperty, AudioObjectSetPropertyData,
        AudioObjectPropertyAddress,
    };
    use std::ptr::NonNull;

    let max_volume: f32 = 1.0;
    let data_size = std::mem::size_of::<f32>() as u32;

    let elements = [kAudioObjectPropertyElementMain, 1, 2];
    for element in elements {
        let addr = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyVolumeScalar,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: element,
        };
        // SAFETY: `addr` is a valid stack reference; `max_volume` is a valid
        // `f32` matching `data_size`.
        let has_property = unsafe { AudioObjectHasProperty(id, NonNull::from(&addr)) };
        if has_property {
            let status = unsafe {
                AudioObjectSetPropertyData(
                    id,
                    NonNull::from(&addr),
                    0,
                    std::ptr::null(),
                    data_size,
                    NonNull::from(&max_volume).cast(),
                )
            };
            if status != 0 {
                eprintln!(
                    "mic: could not set input volume to max on element {element}: {status}"
                );
            }
        }
    }
}

/// Starts capturing the default input device's audio, sending chunks of
/// **mono** `f32` samples to `tx` as they arrive from `cpal`'s callback thread.
///
/// The downmix happens here rather than in the mixer so that every capture
/// source in this module (mic, macOS loopback, Windows loopback) hands the
/// mixer the same shape: mono `f32` at a rate the handle reports.
pub fn start_mic_capture(tx: Sender<Vec<f32>>) -> Result<MicCapture, String> {
    let host = cpal::default_host();
    // Prefer the built-in mic over whatever the system's current default
    // input device is, on macOS specifically - confirmed by a real recording
    // that the default was a Bluetooth headset (AirPods), and opening a
    // Bluetooth accessory's *microphone* forces macOS to hand the whole
    // accessory off from its high-quality media profile (A2DP, output only)
    // to the low-bandwidth voice profile (HFP - mono, far lower rate, and
    // carries input and output together) - a real, uncontrollable device
    // behaviour, not a bug in this app, but one this app has no reason to
    // subject a recording to when a stable, always-available alternative
    // (the built-in mic) sits right there. Falls back to the system default
    // if no built-in input device can be found (e.g. a Mac desktop with no
    // built-in mic at all), so this never turns "no default device" into a
    // harder failure than before.
    #[cfg(target_os = "macos")]
    let device = match builtin_input_device(&host) {
        Some((id, device)) => {
            set_input_volume_max(id);
            device
        }
        None => {
            let device = host.default_input_device().ok_or(NO_DEVICE_MESSAGE)?;
            if let Some(id) = default_input_device_id() {
                set_input_volume_max(id);
            }
            device
        }
    };
    #[cfg(not(target_os = "macos"))]
    let device = host.default_input_device().ok_or(NO_DEVICE_MESSAGE)?;
    let supported = device
        .default_input_config()
        .map_err(|e| describe_error("Could not read microphone config", e.to_string()))?;

    // The callback below is typed `&[f32]`, so a device whose default format
    // is integer would hand cpal a buffer it cannot deliver. Fail loudly here
    // instead of letting `build_input_stream` surface it as an opaque backend
    // error (or, worse, letting a future cpal reinterpret the bytes).
    if supported.sample_format() != SampleFormat::F32 {
        return Err(format!(
            "Microphone reports an unsupported sample format ({}); only 32-bit float input is supported.",
            supported.sample_format()
        ));
    }

    let sample_rate = supported.sample_rate();
    let channels = supported.channels() as usize;
    let sample_format = supported.sample_format();
    let device_name = device.to_string();
    // Printed unconditionally, not just on suspicion of a mismatch: the only
    // way a *stale* negotiated rate (see `frames_received`/`first_frame_at`
    // below) is distinguishable from a *correct* one is by comparing what was
    // negotiated against what actually arrives, and that comparison is
    // useless without knowing what was negotiated in the first place.
    eprintln!(
        "mic device: \"{device_name}\", declared {sample_rate} Hz, {channels} channel(s), {sample_format}"
    );
    let config: cpal::StreamConfig = supported.into();

    let frames_received = Arc::new(AtomicU64::new(0));
    let first_frame_at = Arc::new(Mutex::new(None));
    let frames_received_cb = Arc::clone(&frames_received);
    let first_frame_at_cb = Arc::clone(&first_frame_at);

    let stream = device
        .build_input_stream(
            config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                // Locked once per callback (not per sample), and only ever
                // written once - negligible next to the downmix below.
                let mut first = first_frame_at_cb.lock().expect("mutex poisoned");
                if first.is_none() {
                    *first = Some(Instant::now());
                }
                drop(first);
                let frames = (data.len() / channels.max(1)) as u64;
                frames_received_cb.fetch_add(frames, Ordering::Relaxed);

                let mono = downmix_to_mono(data, channels);
                let _ = tx.send(mono);
            },
            move |err| eprintln!("mic capture stream error: {err}"),
            None,
        )
        .map_err(|e| format!("Could not start microphone capture: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Could not start microphone stream: {e}"))?;
    Ok(MicCapture {
        stream,
        sample_rate,
        frames_received,
        first_frame_at,
    })
}

/// Averages `channels` interleaved channels down to one. A trailing partial
/// frame (which cpal should never produce, but the slice type permits) is
/// dropped rather than averaged against zeros, since a half-frame would shift
/// every following frame's channel alignment.
fn downmix_to_mono(interleaved: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return interleaved.to_vec();
    }
    interleaved
        .chunks_exact(channels)
        .map(|frame| frame.iter().sum::<f32>() / channels as f32)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn captures_nonzero_samples() {
        let (tx, rx) = crossbeam_channel::unbounded();
        let capture = start_mic_capture(tx).expect("mic capture should start");
        assert!(capture.sample_rate > 0, "mic should report a real rate");
        std::thread::sleep(Duration::from_millis(500));
        let mut total_samples = 0;
        while let Ok(chunk) = rx.try_recv() {
            total_samples += chunk.len();
        }
        assert!(total_samples > 0, "expected some samples captured in 500ms");
    }

    #[test]
    fn downmix_averages_channels_and_drops_partial_frames() {
        assert_eq!(downmix_to_mono(&[1.0, 2.0, 3.0], 1), vec![1.0, 2.0, 3.0]);
        assert_eq!(downmix_to_mono(&[1.0, 3.0, 2.0, 4.0], 2), vec![2.0, 3.0]);
        // Trailing sample with no partner is discarded, not averaged with 0.
        assert_eq!(downmix_to_mono(&[1.0, 3.0, 9.0], 2), vec![2.0]);
    }
}
