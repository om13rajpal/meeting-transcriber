//! macOS system-audio ("loopback") capture via Apple's Core Audio Process
//! Taps (`AudioHardwareCreateProcessTap` + `CATapDescription`, macOS 14.2+).
//!
//! This replaced an earlier ScreenCaptureKit-based implementation. ScreenCaptureKit
//! has no audio-only stream - capturing system audio through it means also
//! standing up a real (if tiny and thrown-away) video stream alongside it, and
//! that video component is exactly why macOS gated the whole thing behind the
//! broad "Screen & System Audio Recording" permission. A process tap captures
//! system output audio directly, with no video component at all, so macOS
//! gates it behind the separate, narrower "System Audio Recording Only"
//! permission instead (the same one apps like Wispr Flow use) - visible as its
//! own section in System Settings -> Privacy & Security -> Screen & System
//! Audio Recording, distinct from the list of apps that can record the screen.
//! It also drops the Swift-toolchain build requirement the ScreenCaptureKit
//! crate had (building its Swift bridge via `swift build`).
//!
//! Every function/struct/constant used below was read directly out of the
//! `objc2-core-audio` 0.3.2, `objc2-core-audio-types` 0.3.2, and
//! `objc2-core-foundation` 0.3.2 crate sources (the header-translator-generated
//! files under each crate's `src/generated/`), not guessed from Apple's
//! Swift-facing documentation, which describes a different (Swift/Obj-C)
//! calling convention than what these bindings expose. The overall sequence
//! mirrors Apple's own reference implementation
//! (<https://github.com/insidegui/AudioCap>), ported from Swift to these
//! bindings:
//!
//! 1. Build a `CATapDescription` describing what to tap - here, every
//!    process's output *except* this one's own (so this app's own sounds, if
//!    it ever made any, would not feed back into the recording), mixed down
//!    to stereo.
//! 2. `AudioHardwareCreateProcessTap` creates the tap. This is both the
//!    permission gate and, on a first run, the prompt trigger - the same role
//!    `SCShareableContent::get()` played for ScreenCaptureKit.
//! 3. A tap has no clock or IO cycle of its own, so it has to be wrapped in a
//!    private "aggregate device" that also references a real output device -
//!    purely as a clock/timing anchor. None of that device's own audio is
//!    read; only the tap's.
//! 4. Audio is read by registering an IOProc block on the aggregate device,
//!    exactly like reading from any other Core Audio input device.

use crossbeam_channel::Sender;
use objc2::AnyThread;
use objc2_core_audio::{
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceIsStackedKey,
    kAudioAggregateDeviceMainSubDeviceKey, kAudioAggregateDeviceNameKey,
    kAudioAggregateDeviceSubDeviceListKey, kAudioAggregateDeviceTapAutoStartKey,
    kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey, kAudioDevicePermissionsError,
    kAudioDevicePropertyDeviceUID, kAudioHardwarePropertyDefaultSystemOutputDevice,
    kAudioHardwarePropertyProcessObjectList, kAudioObjectPropertyElementMain,
    kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, kAudioProcessPropertyPID,
    kAudioSubDeviceUIDKey, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey,
    kAudioTapPropertyFormat, AudioDeviceCreateIOProcIDWithBlock, AudioDeviceDestroyIOProcID,
    AudioDeviceIOProcID, AudioDeviceStart, AudioDeviceStop, AudioHardwareCreateAggregateDevice,
    AudioHardwareCreateProcessTap, AudioHardwareDestroyAggregateDevice,
    AudioHardwareDestroyProcessTap, AudioObjectGetPropertyData, AudioObjectGetPropertyDataSize,
    AudioObjectID, AudioObjectPropertyAddress, CATapDescription, CATapMuteBehavior,
};
use objc2_core_audio_types::{AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp};
use objc2_core_foundation::{CFArray, CFBoolean, CFDictionary, CFRetained, CFString, CFType};
use objc2_foundation::{NSArray, NSNumber, NSUUID};
use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::atomic::{AtomicBool, Ordering};

pub struct LoopbackHandle {
    tap_id: AudioObjectID,
    aggregate_device_id: AudioObjectID,
    io_proc_id: AudioDeviceIOProcID,
    _awake: IdleSleepAssertion,
    /// The sample rate this source is actually producing at. A tap has no
    /// rate of its own to request (unlike ScreenCaptureKit's
    /// `with_sample_rate`) - it mirrors whatever the tapped output's current
    /// format is, which is why this is read back from the tap after creation
    /// (`read_tap_stream_format`) instead of a constant.
    pub sample_rate: u32,
}

impl Drop for LoopbackHandle {
    fn drop(&mut self) {
        // Mirrors cpal's "dropping the stream stops capture" contract, so both
        // capture sources behave identically from the mixer's point of view.
        // Every step is attempted even if an earlier one failed - a decayed
        // partial teardown (e.g. a leaked aggregate device) is worse than a
        // logged, best-effort one.
        unsafe {
            let stop_status = AudioDeviceStop(self.aggregate_device_id, self.io_proc_id);
            if stop_status != 0 {
                eprintln!(
                    "system audio capture failed to stop cleanly: {}",
                    describe_os_status(stop_status)
                );
            }
            let destroy_proc_status =
                AudioDeviceDestroyIOProcID(self.aggregate_device_id, self.io_proc_id);
            if destroy_proc_status != 0 {
                eprintln!(
                    "system audio: failed to destroy device I/O proc: {}",
                    describe_os_status(destroy_proc_status)
                );
            }
            let destroy_aggregate_status =
                AudioHardwareDestroyAggregateDevice(self.aggregate_device_id);
            if destroy_aggregate_status != 0 {
                eprintln!(
                    "system audio: failed to destroy aggregate device: {}",
                    describe_os_status(destroy_aggregate_status)
                );
            }
            let destroy_tap_status = AudioHardwareDestroyProcessTap(self.tap_id);
            if destroy_tap_status != 0 {
                eprintln!(
                    "system audio: failed to destroy process tap: {}",
                    describe_os_status(destroy_tap_status)
                );
            }
        }
    }
}

/// Keeps the system from idle-sleeping for as long as it is alive.
///
/// Unlike the ScreenCaptureKit implementation this replaced, there is no
/// display-specific concern here - a Core Audio tap reads directly from the
/// audio HAL, which keeps running regardless of display power state (the same
/// reason music keeps playing with the lid closed on an external monitor).
/// What still matters is *system* idle sleep: if the whole machine suspends
/// mid-meeting, every capture source stops cold along with it, which is a
/// real risk for a call nobody is touching the keyboard during. `-i` blocks
/// exactly that, without also forcing the display to stay lit.
///
/// `-w <our pid>` is what makes this safe against an abnormal exit: `Drop`
/// never runs if the app is SIGKILLed or aborts, and a `caffeinate` orphaned
/// that way would hold the machine awake indefinitely with nothing running to
/// explain why. With `-w`, the kernel reaping our process releases the
/// assertion no matter how we died.
struct IdleSleepAssertion(Option<std::process::Child>);

impl IdleSleepAssertion {
    fn hold() -> Self {
        match std::process::Command::new("/usr/bin/caffeinate")
            .args(["-i", "-w", &std::process::id().to_string()])
            .spawn()
        {
            Ok(child) => Self(Some(child)),
            Err(e) => {
                // Recording is still worth doing without it; it just risks
                // being cut short if the machine is left completely idle.
                eprintln!("could not hold the system awake for recording: {e}");
                Self(None)
            }
        }
    }
}

impl Drop for IdleSleepAssertion {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            // Reap it, so a long session that starts and stops recording
            // repeatedly does not accumulate zombies.
            let _ = child.wait();
        }
    }
}

/// Turns a raw `OSStatus` into something worth logging. Most Core Audio error
/// codes are ASCII four-char codes packed into an `i32` (e.g. `kAudioDevicePermissionsError`
/// is `'!hog'`), so this decodes that when possible instead of printing an
/// opaque number.
fn describe_os_status(status: i32) -> String {
    let bytes = status.to_be_bytes();
    if bytes.iter().all(|&b| (0x20..=0x7e).contains(&b)) {
        format!("'{}' ({status})", String::from_utf8_lossy(&bytes))
    } else {
        status.to_string()
    }
}

/// Turns an `AudioHardwareCreateProcessTap` failure into something worth
/// putting in front of a user. `kAudioDevicePermissionsError` is Core Audio's
/// access-denied code and the one failure the user can actually fix;
/// everything else keeps a short description plus the raw status, matching
/// `mic.rs`'s `describe_error` for the same reason (CLAUDE.md's "never return
/// internals" - a four-char code is not an internal detail, it is already the
/// most specific thing Core Audio itself reports).
fn describe_tap_creation_error(status: i32) -> String {
    if status == kAudioDevicePermissionsError {
        PERMISSION_DENIED_MESSAGE.to_string()
    } else {
        format!(
            "Could not start system audio capture: Core Audio returned {}",
            describe_os_status(status)
        )
    }
}

/// Shared with Task 8's permission-denial UI - keep the two in step.
pub const PERMISSION_DENIED_MESSAGE: &str =
    "System Audio Recording permission is required to record the other side of a call. \
     Open System Settings → Privacy & Security → Screen & System Audio Recording, \
     enable Meeting Transcriber under \"System Audio Recording Only\", then start recording again.";

fn property_address(selector: u32) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress {
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    }
}

/// Reads a fixed-size Core Audio property (a `u32`, an `AudioObjectID`, an
/// `AudioStreamBasicDescription`, ...) via `AudioObjectGetPropertyData`.
///
/// # Safety
///
/// `T` must be exactly the type Core Audio documents for `selector` on this
/// object - there is no way to verify that from here, since the HAL just
/// writes `size_of::<T>()` raw bytes into whatever pointer it is given.
unsafe fn get_fixed_size_property<T: Copy>(
    object_id: AudioObjectID,
    selector: u32,
) -> Result<T, String> {
    let address = property_address(selector);
    let mut size = std::mem::size_of::<T>() as u32;
    let mut value = std::mem::MaybeUninit::<T>::uninit();
    let status = AudioObjectGetPropertyData(
        object_id,
        NonNull::from(&address),
        0,
        std::ptr::null(),
        NonNull::from(&mut size),
        NonNull::new(value.as_mut_ptr().cast::<c_void>())
            .expect("pointer to a stack value is never null"),
    );
    if status != 0 {
        return Err(format!(
            "Core Audio property lookup failed: {}",
            describe_os_status(status)
        ));
    }
    Ok(value.assume_init())
}

/// Reads a `CFString`-typed Core Audio property (e.g. `kAudioDevicePropertyDeviceUID`).
///
/// The HAL hands back an already-retained `CFStringRef` for this kind of
/// property (the caller owns it and must release it), which is exactly what
/// `CFRetained::from_raw` takes ownership of without an extra retain.
///
/// # Safety
///
/// `selector` must document a `CFStringRef`-typed property on `object_id`.
unsafe fn get_cfstring_property(
    object_id: AudioObjectID,
    selector: u32,
) -> Result<CFRetained<CFString>, String> {
    let address = property_address(selector);
    let mut size = std::mem::size_of::<*const c_void>() as u32;
    let mut raw: *const c_void = std::ptr::null();
    let status = AudioObjectGetPropertyData(
        object_id,
        NonNull::from(&address),
        0,
        std::ptr::null(),
        NonNull::from(&mut size),
        NonNull::from(&mut raw).cast::<c_void>(),
    );
    if status != 0 {
        return Err(format!(
            "Core Audio property lookup failed: {}",
            describe_os_status(status)
        ));
    }
    let ptr = NonNull::new(raw.cast_mut().cast::<CFString>())
        .ok_or("Core Audio returned a null string property")?;
    Ok(CFRetained::from_raw(ptr))
}

/// Reads a variable-length `AudioObjectID` array property (e.g.
/// `kAudioHardwarePropertyProcessObjectList`), sizing the buffer from a real
/// `AudioObjectGetPropertyDataSize` call rather than guessing a capacity.
///
/// # Safety
///
/// `selector` must document a property whose value is a packed array of
/// `AudioObjectID` (`u32`).
unsafe fn get_audio_object_id_list_property(
    object_id: AudioObjectID,
    selector: u32,
) -> Result<Vec<AudioObjectID>, String> {
    let address = property_address(selector);
    let mut size: u32 = 0;
    let size_status = AudioObjectGetPropertyDataSize(
        object_id,
        NonNull::from(&address),
        0,
        std::ptr::null(),
        NonNull::from(&mut size),
    );
    if size_status != 0 {
        return Err(format!(
            "Core Audio property size lookup failed: {}",
            describe_os_status(size_status)
        ));
    }

    let count = size as usize / std::mem::size_of::<AudioObjectID>();
    let mut ids = vec![0u32; count];
    if count == 0 {
        return Ok(ids);
    }
    let status = AudioObjectGetPropertyData(
        object_id,
        NonNull::from(&address),
        0,
        std::ptr::null(),
        NonNull::from(&mut size),
        NonNull::new(ids.as_mut_ptr().cast::<c_void>()).expect("Vec buffer is never null"),
    );
    if status != 0 {
        return Err(format!(
            "Core Audio property lookup failed: {}",
            describe_os_status(status)
        ));
    }
    Ok(ids)
}

/// Finds this process's own Core Audio "process object" id, so it can be
/// excluded from the tap - otherwise anything this app itself ever played
/// back would be captured into the recording. `kAudioHardwarePropertyProcessObjectList`
/// enumerates every process object the HAL currently knows about; each one's
/// `kAudioProcessPropertyPID` is matched against our own `std::process::id()`
/// to find the right one. Returns `None` (rather than erroring the whole
/// recording) if the lookup fails for any reason - the tap still works, it
/// would just also (harmlessly, since this app makes no sound of its own)
/// capture this process's audio.
fn find_own_process_object_id() -> Option<AudioObjectID> {
    let pid = std::process::id();
    let system_object = kAudioObjectSystemObject as AudioObjectID;
    let ids =
        unsafe { get_audio_object_id_list_property(system_object, kAudioHardwarePropertyProcessObjectList) }
            .ok()?;
    ids.into_iter().find(|&id| {
        unsafe { get_fixed_size_property::<u32>(id, kAudioProcessPropertyPID) }
            .map(|found_pid| found_pid == pid)
            .unwrap_or(false)
    })
}

/// Wraps a `&CStr` Core Audio dictionary-key constant (e.g.
/// `kAudioAggregateDeviceNameKey`) as a `CFString`. These constants are plain
/// ASCII string literals (`"name"`, `"uid"`, ...), not Objective-C selectors,
/// so this is always infallible.
fn key(cstr: &std::ffi::CStr) -> CFRetained<CFString> {
    CFString::from_str(cstr.to_str().expect("Core Audio dictionary keys are ASCII"))
}

/// Builds the `CFDictionary` description `AudioHardwareCreateAggregateDevice`
/// expects: a private, tap-only aggregate device that uses `output_device_uid`
/// purely as a clock/timing anchor (none of its actual audio is read) and
/// reads real audio only from the one tap named by `tap_uuid_string`.
///
/// Mirrors <https://github.com/insidegui/AudioCap>'s `ProcessTap.prepare(for:)`
/// dictionary literal, the reference implementation this was ported from.
fn build_aggregate_device_description(
    aggregate_name: &str,
    aggregate_uid: &str,
    output_device_uid: &CFString,
    tap_uuid_string: &str,
) -> CFRetained<CFDictionary<CFType, CFType>> {
    let subdevice = CFDictionary::<CFType, CFType>::from_slices(
        &[key(kAudioSubDeviceUIDKey).as_ref()],
        &[output_device_uid.as_ref()],
    );
    let subdevices = CFArray::<CFType>::from_objects(&[subdevice.as_ref()]);

    let tap = CFDictionary::<CFType, CFType>::from_slices(
        &[
            key(kAudioSubTapDriftCompensationKey).as_ref(),
            key(kAudioSubTapUIDKey).as_ref(),
        ],
        &[
            CFBoolean::new(true).as_ref(),
            CFString::from_str(tap_uuid_string).as_ref(),
        ],
    );
    let taps = CFArray::<CFType>::from_objects(&[tap.as_ref()]);

    CFDictionary::<CFType, CFType>::from_slices(
        &[
            key(kAudioAggregateDeviceNameKey).as_ref(),
            key(kAudioAggregateDeviceUIDKey).as_ref(),
            key(kAudioAggregateDeviceMainSubDeviceKey).as_ref(),
            key(kAudioAggregateDeviceIsPrivateKey).as_ref(),
            key(kAudioAggregateDeviceIsStackedKey).as_ref(),
            key(kAudioAggregateDeviceTapAutoStartKey).as_ref(),
            key(kAudioAggregateDeviceSubDeviceListKey).as_ref(),
            key(kAudioAggregateDeviceTapListKey).as_ref(),
        ],
        &[
            CFString::from_str(aggregate_name).as_ref(),
            CFString::from_str(aggregate_uid).as_ref(),
            output_device_uid.as_ref(),
            CFBoolean::new(true).as_ref(),
            CFBoolean::new(false).as_ref(),
            CFBoolean::new(true).as_ref(),
            subdevices.as_ref(),
            taps.as_ref(),
        ],
    )
}

/// Flattens whatever `AudioBufferList` layout arrives into mono `f32`.
///
/// `AudioBufferList.mBuffers` is declared as a 1-element array (C's
/// flexible-array-member idiom - the real backing memory holds
/// `mNumberBuffers` contiguous `AudioBuffer`s, only the first of which the
/// Rust struct's field type can see directly), so reading buffer *n* needs
/// manual pointer arithmetic from that first element, same as Apple's own
/// `UnsafeMutableAudioBufferListPointer` does on the Swift side.
///
/// Core Audio taps are not documented as guaranteeing either an interleaved
/// (one buffer, N channels) or planar (N buffers, 1 channel each) layout, so
/// both are handled here - the same defensive shape already used for
/// ScreenCaptureKit's equally-undocumented layout before this file replaced
/// it, and for the same reason: a wrong guess would be audible immediately,
/// not subtle.
///
/// # Safety
///
/// `list` must be a valid `AudioBufferList` as delivered by a Core Audio
/// IOProc callback - specifically, `list.mNumberBuffers` must accurately
/// describe how many `AudioBuffer`s follow `list.mBuffers.as_ptr()` in memory,
/// and each buffer's `mData`/`mDataByteSize` must describe a valid, readable
/// region of 32-bit float samples (which is what Core Audio taps deliver).
unsafe fn audio_buffer_list_to_mono(list: &AudioBufferList) -> Vec<f32> {
    let count = list.mNumberBuffers as usize;
    let buffers = std::slice::from_raw_parts(list.mBuffers.as_ptr(), count);

    let planes: Vec<&[f32]> = buffers
        .iter()
        .map(|buffer| {
            if buffer.mData.is_null() {
                return &[][..];
            }
            let len = buffer.mDataByteSize as usize / std::mem::size_of::<f32>();
            std::slice::from_raw_parts(buffer.mData.cast::<f32>(), len)
        })
        .collect();

    if planes.is_empty() {
        return Vec::new();
    }

    if planes.len() == 1 {
        // Single buffer: either already mono, or interleaved across N channels.
        let channels = buffers[0].mNumberChannels.max(1) as usize;
        let plane = planes[0];
        if channels <= 1 {
            return plane.to_vec();
        }
        return plane
            .chunks_exact(channels)
            .map(|frame| frame.iter().sum::<f32>() / channels as f32)
            .collect();
    }

    // Multiple buffers: planar, one channel per buffer. Short planes would
    // desynchronise the average, so only the frames every plane has are used.
    let frames = planes.iter().map(|p| p.len()).min().unwrap_or(0);
    let plane_count = planes.len() as f32;
    (0..frames)
        .map(|i| planes.iter().map(|p| p[i]).sum::<f32>() / plane_count)
        .collect()
}

/// Builds the `NSArray<NSNumber>` of process object ids to exclude from the
/// tap - just this process, if it could be found (see
/// `find_own_process_object_id`), otherwise empty.
fn own_process_exclusion_array() -> objc2::rc::Retained<NSArray<NSNumber>> {
    match find_own_process_object_id() {
        Some(id) => {
            let number = NSNumber::numberWithUnsignedInt(id);
            NSArray::from_slice(&[&*number])
        }
        None => NSArray::from_slice(&[]),
    }
}

/// Starts capturing everything playing out of the system's speakers, sending
/// chunks of mono `f32` samples to `tx`.
pub fn start_system_audio_capture(tx: Sender<Vec<f32>>) -> Result<LoopbackHandle, String> {
    let excluded_processes = own_process_exclusion_array();
    // SAFETY: `CATapDescription::alloc()` produces a freshly allocated,
    // uninitialized instance that `initStereoGlobalTapButExcludeProcesses`
    // then initializes in the single standard Objective-C alloc+init
    // sequence: exactly what these methods require.
    let tap_description = unsafe {
        CATapDescription::initStereoGlobalTapButExcludeProcesses(
            CATapDescription::alloc(),
            &excluded_processes,
        )
    };
    let tap_uuid = NSUUID::new();
    let tap_uuid_string = tap_uuid.to_string();
    // SAFETY: `tap_description` is a live, correctly initialized instance.
    unsafe {
        tap_description.setUUID(&tap_uuid);
        // Leaves the tapped audio audible through the speakers as normal -
        // this is a silent background recorder, not a "mute the room" tool.
        tap_description.setMuteBehavior(CATapMuteBehavior::Unmuted);
    }

    // First real call into Core Audio's tap machinery, and therefore the
    // point where a missing "System Audio Recording Only" grant shows up
    // (and where the OS prompt fires on a first run) - the same role
    // `SCShareableContent::get()` played in the ScreenCaptureKit-based
    // version this replaced.
    let mut tap_id: AudioObjectID = 0;
    // SAFETY: `tap_description` is a live, correctly initialized instance;
    // `tap_id` is a valid pointer to a stack `u32`.
    let create_tap_status =
        unsafe { AudioHardwareCreateProcessTap(Some(&tap_description), &mut tap_id) };
    if create_tap_status != 0 {
        return Err(describe_tap_creation_error(create_tap_status));
    }

    // A tap mirrors whatever the tapped output's current format is - there is
    // no `with_sample_rate`/`with_channel_count` to request, unlike
    // ScreenCaptureKit's `SCStreamConfiguration`. Reading it back is what lets
    // the mixer in `capture/mod.rs` resample against a real number instead of
    // a constant nobody re-checked.
    let format = match unsafe {
        get_fixed_size_property::<AudioStreamBasicDescription>(tap_id, kAudioTapPropertyFormat)
    } {
        Ok(format) => format,
        Err(e) => {
            unsafe {
                let _ = AudioHardwareDestroyProcessTap(tap_id);
            }
            return Err(format!("Could not read the system audio format: {e}"));
        }
    };

    // A tap has no clock or IO cycle of its own; it has to be wrapped in a
    // private aggregate device that also references a real output device
    // purely as a clock/timing anchor. Its own audio is never read - only the
    // tap's, via the "taps" key below.
    let system_object = kAudioObjectSystemObject as AudioObjectID;
    let default_output_id = match unsafe {
        get_fixed_size_property::<AudioObjectID>(
            system_object,
            kAudioHardwarePropertyDefaultSystemOutputDevice,
        )
    } {
        Ok(id) => id,
        Err(e) => {
            unsafe {
                let _ = AudioHardwareDestroyProcessTap(tap_id);
            }
            return Err(format!("Could not find the system's output device: {e}"));
        }
    };
    let output_uid = match unsafe { get_cfstring_property(default_output_id, kAudioDevicePropertyDeviceUID) } {
        Ok(uid) => uid,
        Err(e) => {
            unsafe {
                let _ = AudioHardwareDestroyProcessTap(tap_id);
            }
            return Err(format!("Could not read the system output device's UID: {e}"));
        }
    };

    let aggregate_name = format!("Meeting Transcriber System Audio ({})", std::process::id());
    let aggregate_uid = NSUUID::new().to_string();
    let description = build_aggregate_device_description(
        &aggregate_name,
        &aggregate_uid,
        &output_uid,
        &tap_uuid_string,
    );

    let mut aggregate_device_id: AudioObjectID = 0;
    // SAFETY: `description` is a live `CFDictionary`; `aggregate_device_id`
    // is a valid pointer to a stack `u32`.
    let create_aggregate_status = unsafe {
        AudioHardwareCreateAggregateDevice(description.as_ref(), NonNull::from(&mut aggregate_device_id))
    };
    if create_aggregate_status != 0 {
        unsafe {
            let _ = AudioHardwareDestroyProcessTap(tap_id);
        }
        return Err(format!(
            "Could not start system audio capture: Core Audio returned {}",
            describe_os_status(create_aggregate_status)
        ));
    }

    let logged_layout = AtomicBool::new(false);
    let block = block2::RcBlock::new(
        move |_now: NonNull<AudioTimeStamp>,
              input_data: NonNull<AudioBufferList>,
              _input_time: NonNull<AudioTimeStamp>,
              _output_data: NonNull<AudioBufferList>,
              _output_time: NonNull<AudioTimeStamp>| {
            // SAFETY: Core Audio guarantees `input_data` is valid for the
            // duration of this call.
            let list = unsafe { input_data.as_ref() };

            // The layout Core Audio actually delivers is not documented, and
            // it is the one thing that would silently produce half-speed or
            // channel-swapped audio if guessed wrong. Log what the first
            // buffer really looked like, once, so a maintainer can confirm it
            // from a real run instead of re-deriving it from Apple's headers.
            if !logged_layout.swap(true, Ordering::Relaxed) {
                let count = list.mNumberBuffers as usize;
                // SAFETY: same layout guarantee as `audio_buffer_list_to_mono`.
                let buffers = unsafe { std::slice::from_raw_parts(list.mBuffers.as_ptr(), count) };
                let shape: Vec<String> = buffers
                    .iter()
                    .map(|b| format!("{}ch/{}B", b.mNumberChannels, b.mDataByteSize))
                    .collect();
                eprintln!("system audio layout: {count} buffer(s) [{}]", shape.join(", "));
            }

            // SAFETY: `list` is valid for the duration of this callback, as
            // required by `audio_buffer_list_to_mono`.
            let mono = unsafe { audio_buffer_list_to_mono(list) };
            if !mono.is_empty() {
                let _ = tx.send(mono);
            }
        },
    );

    let mut io_proc_id: AudioDeviceIOProcID = None;
    // A real dispatch queue, not `None` - matches
    // <https://github.com/insidegui/AudioCap>'s `ProcessTap.run(on:...)`,
    // which always hands this a dedicated serial queue rather than relying on
    // "NULL means invoke directly" (technically valid per Apple's own doc
    // comment on this parameter, but not the path any confirmed-working
    // process-tap implementation actually exercises for an *aggregate*
    // device specifically, as opposed to a plain hardware one).
    let queue = dispatch2::DispatchQueue::new("meeting-transcriber-system-audio", None);
    // SAFETY: `aggregate_device_id` is the aggregate device just created
    // above; `block` is a valid block pointer and `queue` a valid dispatch
    // queue for the duration of this call (Core Audio retains its own
    // reference to both, per its own documentation, so neither needs to
    // outlive this call).
    let create_proc_status = unsafe {
        AudioDeviceCreateIOProcIDWithBlock(
            NonNull::from(&mut io_proc_id),
            aggregate_device_id,
            Some(&queue),
            block2::RcBlock::as_ptr(&block),
        )
    };
    if create_proc_status != 0 {
        unsafe {
            let _ = AudioHardwareDestroyAggregateDevice(aggregate_device_id);
            let _ = AudioHardwareDestroyProcessTap(tap_id);
        }
        return Err(format!(
            "Could not start system audio capture: Core Audio returned {}",
            describe_os_status(create_proc_status)
        ));
    }

    // SAFETY: `aggregate_device_id`/`io_proc_id` were both just created above.
    let start_status = unsafe { AudioDeviceStart(aggregate_device_id, io_proc_id) };
    if start_status != 0 {
        unsafe {
            let _ = AudioDeviceDestroyIOProcID(aggregate_device_id, io_proc_id);
            let _ = AudioHardwareDestroyAggregateDevice(aggregate_device_id);
            let _ = AudioHardwareDestroyProcessTap(tap_id);
        }
        return Err(format!(
            "Could not start system audio capture: Core Audio returned {}",
            describe_os_status(start_status)
        ));
    }

    Ok(LoopbackHandle {
        tap_id,
        aggregate_device_id,
        io_proc_id,
        _awake: IdleSleepAssertion::hold(),
        sample_rate: format.mSampleRate.round() as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The assertion has to actually run `caffeinate` and actually reap it -
    /// a silently-failed spawn would look identical to a working one until a
    /// meeting quietly lost its second half.
    #[test]
    fn idle_sleep_assertion_starts_and_is_reaped() {
        let assertion = IdleSleepAssertion::hold();
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
        // (SIGKILL, abort) leaves the assertion held forever, because Drop
        // never runs.
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

    /// A single interleaved buffer with N channels must be averaged across
    /// channels per frame, not treated as N sequential mono samples.
    #[test]
    fn downmixes_a_single_interleaved_buffer() {
        let samples = [1.0f32, 3.0, 2.0, 4.0];
        let list = AudioBufferList {
            mNumberBuffers: 1,
            mBuffers: [objc2_core_audio_types::AudioBuffer {
                mNumberChannels: 2,
                mDataByteSize: (samples.len() * std::mem::size_of::<f32>()) as u32,
                mData: samples.as_ptr() as *mut c_void,
            }],
        };
        let mono = unsafe { audio_buffer_list_to_mono(&list) };
        assert_eq!(mono, vec![2.0, 3.0]);
    }

    /// `AudioBufferList.mBuffers` is declared as a 1-element array, but a real
    /// multi-buffer list has `mNumberBuffers` of them contiguous in memory
    /// beyond that nominal single element - this mirrors that exact shape by
    /// hand, laid out via a `#[repr(C)]` struct with the field types and
    /// order `audio_buffer_list_to_mono`'s pointer arithmetic assumes.
    #[repr(C)]
    #[allow(non_snake_case)]
    struct TwoBufferList {
        mNumberBuffers: u32,
        mBuffers: [objc2_core_audio_types::AudioBuffer; 2],
    }

    /// Planar buffers (one channel per buffer) must be averaged frame-by-frame
    /// across buffers, not concatenated.
    #[test]
    fn downmixes_planar_buffers() {
        let left = [1.0f32, 3.0];
        let right = [3.0f32, 5.0];
        let raw = TwoBufferList {
            mNumberBuffers: 2,
            mBuffers: [
                objc2_core_audio_types::AudioBuffer {
                    mNumberChannels: 1,
                    mDataByteSize: (left.len() * std::mem::size_of::<f32>()) as u32,
                    mData: left.as_ptr() as *mut c_void,
                },
                objc2_core_audio_types::AudioBuffer {
                    mNumberChannels: 1,
                    mDataByteSize: (right.len() * std::mem::size_of::<f32>()) as u32,
                    mData: right.as_ptr() as *mut c_void,
                },
            ],
        };
        // SAFETY: `TwoBufferList` has the same layout as `AudioBufferList` up
        // to and including its first buffer, with the second immediately
        // following in memory - exactly the real shape a multi-buffer
        // `AudioBufferList` has.
        let list = unsafe { &*(&raw as *const TwoBufferList).cast::<AudioBufferList>() };
        let mono = unsafe { audio_buffer_list_to_mono(list) };
        assert_eq!(mono, vec![2.0, 4.0]);
    }
}
