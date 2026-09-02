let recorder: MediaRecorder | null = null;
let tabStream: MediaStream | null = null;
let micStream: MediaStream | null = null;
let combinedStream: MediaStream | null = null;
// Bumped once per `startCapture()` call and captured into each call's own
// `mySession` const, so the async `recorder.onstop` closure it schedules
// can tell whether it's still the current recording session by the time
// it actually fires. Needed because `startCapture()` awaits two
// `getUserMedia()` calls before touching module state, and
// `recorder.onstop` fires asynchronously after `stopCapture()` returns -
// either gap gives a fast stop-then-restart room to start a new session
// before the old one's cleanup runs. Without this guard, that stale
// cleanup would null out the new session's live `recorder`/streams out
// from under it and send a spurious `RECORDING_FINISHED` for a session
// that never actually finished. (The `Blob` data itself can no longer be
// misattributed either way - see `myChunks` below - but the module-scope
// `recorder`/stream nulling still needs this guard.)
let generation = 0;

async function startCapture(streamId: string) {
  generation += 1;
  const mySession = generation;

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
  // Per-session, closure-captured - not module-scope - so a superseded
  // session's still-pending trailing `dataavailable` (queued by `.stop()`
  // but not guaranteed to fire before the next `startCapture()` runs)
  // pushes into ITS OWN array, never into a newer session's. A shared
  // module-scope `chunks` reassigned by each `startCapture()` call would
  // let that stale event silently push into the new session's array
  // instead - audio from one recording bleeding into the next, with no
  // exception to reveal it.
  const myChunks: Blob[] = [];
  recorder = new MediaRecorder(combinedStream, { mimeType: 'audio/webm;codecs=opus' });
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) myChunks.push(e.data);
  };
  recorder.onstop = () => {
    // Stale cleanup from a superseded session (a newer `startCapture()`
    // already ran while this recorder's `.stop()` was pending) - the
    // module-scope variables it would touch already belong to that newer
    // session, so bail out rather than clobbering them. (`myChunks` can't
    // be clobbered either way now, but the module-scope nulling below
    // still needs this guard.)
    if (mySession !== generation) return;
    // Only fires after the final `dataavailable` (queued by `.stop()`)
    // has already landed in `myChunks` - building the Blob here, rather
    // than synchronously right after calling `.stop()`, is what keeps
    // that last buffered chunk (up to the 1s timeslice) in the recording
    // instead of silently dropping it.
    const blob = new Blob(myChunks, { type: 'audio/webm' });
    (globalThis as any).__lastRecordingBlob = blob;
    chrome.runtime.sendMessage({ type: 'RECORDING_FINISHED', size: blob.size });
    recorder = null;
    combinedStream = null;
    tabStream = null;
    micStream = null;
    // Fire-and-forget, same as startCapture()/stopCapture() themselves -
    // the onMessage listener below must not block waiting on the upload
    // (which can take as long as the recording itself for a large file).
    // A superseded session's onstop already bailed out above via the
    // `mySession !== generation` guard, so a stale session's audio never
    // reaches here either - nothing extra to guard against for upload.
    if (blob.size > 0) {
      uploadRecording(blob);
    } else {
      chrome.runtime.sendMessage({ type: 'UPLOAD_STATUS', status: 'No audio was captured — nothing to upload.' });
    }
  };
  recorder.start(1000); // 1s timeslices so a crash mid-recording still leaves recent chunks in `myChunks`
}

function stopCapture() {
  // Also guards a repeat `OFFSCREEN_STOP`: `.stop()` synchronously flips
  // `state` to 'inactive' before this function returns, so a second call
  // arriving before `onstop` has fired (and nulled `recorder`) sees
  // `state === 'inactive'` and no-ops instead of calling `.stop()` again,
  // which the spec throws `InvalidStateError` for on an inactive recorder.
  if (!recorder || recorder.state === 'inactive') return;
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

async function uploadRecording(blob: Blob) {
  const { appUrl, apiKey } = await chrome.storage.local.get(['appUrl', 'apiKey']);
  if (!appUrl || !apiKey) {
    chrome.runtime.sendMessage({ type: 'UPLOAD_STATUS', status: 'No App URL or API key set — open Settings.' });
    return;
  }

  chrome.runtime.sendMessage({ type: 'UPLOAD_STATUS', status: 'Requesting upload token…' });

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(`${appUrl}/api/tokens/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: `Meeting ${new Date().toLocaleString('en-US')}.webm` })
    });
  } catch {
    chrome.runtime.sendMessage({ type: 'UPLOAD_STATUS', status: 'Could not reach the app — check your App URL and network connection.' });
    return;
  }

  if (!tokenResponse.ok) {
    const body = await tokenResponse.json().catch(() => ({}));
    chrome.runtime.sendMessage({ type: 'UPLOAD_STATUS', status: body.error || 'Could not start the upload.' });
    return;
  }

  const { token, backendUrl, meeting } = await tokenResponse.json();

  chrome.runtime.sendMessage({ type: 'UPLOAD_STATUS', status: 'Uploading recording…' });

  const form = new FormData();
  form.append('token', token);
  form.append('file', blob, 'recording.webm');

  async function reportFailure(message: string) {
    // Companion to the mint call above: without this, a failed upload
    // would leave the Meeting row stuck at 'processing' until the
    // backend's 30-minute stale-job sweep notices, instead of failing
    // promptly the way the web dashboard's own upload failures already
    // do. See docs/superpowers/plans/2026-09-02-api-key-auth.md Task 6.
    await fetch(`${appUrl}/api/tokens/mark-failed`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ meetingId: meeting.id, message })
    }).catch(() => {});
  }

  try {
    const uploadResponse = await fetch(`${backendUrl}/api/transcribe`, { method: 'POST', body: form });
    if (!uploadResponse.ok) {
      await reportFailure(`Upload failed with status ${uploadResponse.status}.`);
      chrome.runtime.sendMessage({ type: 'UPLOAD_STATUS', status: 'Upload failed — the meeting was saved as failed in your dashboard.' });
      return;
    }
    chrome.runtime.sendMessage({ type: 'UPLOAD_STATUS', status: 'Uploaded — check the dashboard for transcription progress.' });
  } catch {
    await reportFailure('Network error during upload from the Chrome extension.');
    chrome.runtime.sendMessage({ type: 'UPLOAD_STATUS', status: 'Network error during upload — the meeting was saved as failed in your dashboard.' });
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'OFFSCREEN_START') {
    startCapture(message.streamId);
  }
  if (message.type === 'OFFSCREEN_STOP') {
    stopCapture();
  }
});
