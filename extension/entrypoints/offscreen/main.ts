let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let combinedStream: MediaStream | null = null;

async function startCapture(streamId: string) {
  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as any
  });
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

  // Mix both into one track via the Web Audio API, per the design spec -
  // a single combined recording is enough for this app's diarization
  // (Deepgram splits speakers from the mixed audio already, the same
  // way it already does for a manually-uploaded recording); keeping
  // the two as fully separate uploaded files would need pipeline
  // changes this plan deliberately doesn't make.
  const audioContext = new AudioContext();
  const destination = audioContext.createMediaStreamDestination();
  audioContext.createMediaStreamSource(tabStream).connect(destination);
  audioContext.createMediaStreamSource(micStream).connect(destination);
  // Also route the tab audio to the real speakers, since capturing it
  // via getUserMedia otherwise silences it for the user mid-meeting.
  audioContext.createMediaStreamSource(tabStream).connect(audioContext.destination);

  combinedStream = destination.stream;
  chunks = [];
  recorder = new MediaRecorder(combinedStream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = () => {
    // Only fires after the final `dataavailable` (queued by `.stop()`)
    // has already landed in `chunks` - building the Blob here, rather
    // than synchronously right after calling `.stop()`, is what keeps
    // that last buffered chunk (up to the 1s timeslice) in the recording
    // instead of silently dropping it.
    const blob = new Blob(chunks, { type: 'audio/webm' });
    (globalThis as any).__lastRecordingBlob = blob;
    chrome.runtime.sendMessage({ type: 'RECORDING_FINISHED', size: blob.size });
    recorder = null;
    combinedStream = null;
    tabStream = null;
    micStream = null;
  };
  recorder.start(1000); // 1s timeslices so a crash mid-recording still leaves recent chunks in `chunks`
}

function stopCapture() {
  if (!recorder) return;
  recorder.stop(); // queues the final `dataavailable` + `stop` events asynchronously
  // Stop every real capture track, not just the synthetic combined
  // stream's output track - `combinedStream` comes from
  // `audioContext.createMediaStreamDestination()` and has no lifecycle
  // link back to the original tabCapture/mic tracks feeding it via
  // `createMediaStreamSource`, so it alone stopping never releases the
  // actual tab-capture/mic capture (leaving a dangling capture
  // indicator) unless those source streams are stopped too.
  tabStream?.getTracks().forEach((t) => t.stop());
  micStream?.getTracks().forEach((t) => t.stop());
  combinedStream?.getTracks().forEach((t) => t.stop());
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'OFFSCREEN_START') {
    startCapture(message.streamId);
  }
  if (message.type === 'OFFSCREEN_STOP') {
    stopCapture();
  }
});
