let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let combinedStream: MediaStream | null = null;

async function startCapture(streamId: string) {
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as any
  });
  const micStream = await navigator.mediaDevices.getUserMedia({ audio: true });

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
  recorder.start(1000); // 1s timeslices so a crash mid-recording still leaves recent chunks in `chunks`
}

function stopCapture(): Blob | null {
  if (!recorder) return null;
  recorder.stop();
  combinedStream?.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: 'audio/webm' });
  recorder = null;
  combinedStream = null;
  return blob;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'OFFSCREEN_START') {
    startCapture(message.streamId);
  }
  if (message.type === 'OFFSCREEN_STOP') {
    const blob = stopCapture();
    if (blob) {
      (globalThis as any).__lastRecordingBlob = blob;
      chrome.runtime.sendMessage({ type: 'RECORDING_FINISHED', size: blob.size });
    }
  }
});
