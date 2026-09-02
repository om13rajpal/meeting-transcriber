use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::Sender;

/// Starts capturing the default input device's audio, sending chunks of
/// `f32` samples to `tx` as they arrive from `cpal`'s callback thread.
///
/// IMPORTANT: `cpal`'s design means the `Stream` itself owns the capture -
/// dropping it (going out of scope, or being the last reference collected)
/// stops the underlying platform audio callback immediately, silently, with
/// no error. The caller MUST hold on to the returned `Stream` for as long as
/// capture should continue (e.g. store it in app state), not just call this
/// function and discard the result.
pub fn start_mic_capture(tx: Sender<Vec<f32>>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No microphone found. Check System Settings → Privacy & Security → Microphone.")?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("Could not read microphone config: {e}"))?;

    let stream = device
        .build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let _ = tx.send(data.to_vec());
            },
            move |err| eprintln!("mic capture stream error: {err}"),
            None,
        )
        .map_err(|e| format!("Could not start microphone capture: {e}"))?;

    stream
        .play()
        .map_err(|e| format!("Could not start microphone stream: {e}"))?;
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn captures_nonzero_samples() {
        let (tx, rx) = crossbeam_channel::unbounded();
        let _stream = start_mic_capture(tx).expect("mic capture should start");
        std::thread::sleep(Duration::from_millis(500));
        let mut total_samples = 0;
        while let Ok(chunk) = rx.try_recv() {
            total_samples += chunk.len();
        }
        assert!(total_samples > 0, "expected some samples captured in 500ms");
    }
}
