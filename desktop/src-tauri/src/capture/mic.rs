use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::SampleFormat;
use crossbeam_channel::Sender;

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
}

/// Starts capturing the default input device's audio, sending chunks of
/// **mono** `f32` samples to `tx` as they arrive from `cpal`'s callback thread.
///
/// The downmix happens here rather than in the mixer so that every capture
/// source in this module (mic, macOS loopback, Windows loopback) hands the
/// mixer the same shape: mono `f32` at a rate the handle reports.
pub fn start_mic_capture(tx: Sender<Vec<f32>>) -> Result<MicCapture, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No microphone found. Check System Settings → Privacy & Security → Microphone.")?;
    let supported = device
        .default_input_config()
        .map_err(|e| format!("Could not read microphone config: {e}"))?;

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

    let sample_rate = supported.sample_rate().0;
    let channels = supported.channels() as usize;
    let config: cpal::StreamConfig = supported.into();

    let stream = device
        .build_input_stream(
            &config,
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
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
