import { APP_URL, setMicGranted } from '../../lib/storage';

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

// The last recording that failed to upload, kept only so the bytes aren't
// thrown away the instant the network is down. Still an in-memory-only
// safety net - it lives in the offscreen document's heap, so reloading the
// extension, restarting Chrome, or the offscreen document being torn down
// all discard it (a real "kept on disk" flow would need IndexedDB, a much
// bigger piece of work this doesn't attempt) - but the side panel can now
// actually trigger a retry against it (see the RETRY_UPLOAD handler below),
// which it couldn't before: this used to be write-only, nothing ever read
// it back. `hasRetainedRecording` in chrome.storage.session is what lets
// the side panel know whether a retry is even possible without it having
// its own access to this offscreen-document-local variable.
function retainFailedRecording(blob: Blob) {
  (globalThis as any).__lastFailedRecordingBlob = blob;
  chrome.storage.session.set({ hasRetainedRecording: true });
}

function clearRetainedRecording() {
  (globalThis as any).__lastFailedRecordingBlob = undefined;
  chrome.storage.session.set({ hasRetainedRecording: false });
}

// Broadcasts status live to the side panel AND persists it, so reopening
// the panel after it was closed (extremely likely during a real meeting -
// nobody keeps the side panel open and focused for the whole call) shows
// the last real outcome instead of nothing. Before this fix, UPLOAD_STATUS
// was a pure fire-and-forget broadcast: if no side panel was open at the
// exact moment it fired, the message was silently dropped forever, with no
// way to ever learn what happened to that recording.
function postUploadStatus(status: string) {
  chrome.storage.session.set({ lastUploadStatus: status });
  chrome.runtime.sendMessage({ type: 'UPLOAD_STATUS', status }).catch(() => {});
}

// Appended to every upload-failure status so the message is honest about what
// is and isn't still recoverable.
const IN_MEMORY_NOTE = ' The recording is still in memory in this browser session only - reloading the extension or restarting Chrome discards it.';

async function startCapture(streamId: string) {
  generation += 1;
  const mySession = generation;

  // Clears any stale status from a previous recording's outcome - without
  // this, reopening the side panel mid-recording could show a leftover
  // "Uploaded" or "Failed" message that actually describes a completely
  // different, older recording. Deliberately does NOT touch
  // hasRetainedRecording/the retained blob itself - an earlier failed
  // recording's retry chance shouldn't be lost just because a new,
  // unrelated recording started.
  chrome.storage.session.set({ lastUploadStatus: null }).catch(() => {});

  // Held as locals until both succeed: if the mic prompt is denied after the
  // tab capture already opened, the tab capture has to be released here or it
  // stays live (with Chrome's capture indicator showing) for a recording that
  // never started.
  let myTabStream: MediaStream | null = null;
  let myMicStream: MediaStream | null = null;
  try {
    myTabStream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } } as any
    });
    myMicStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    myTabStream?.getTracks().forEach((t) => t.stop());
    myMicStream?.getTracks().forEach((t) => t.stop());
    throw error;
  }

  tabStream = myTabStream;
  micStream = myMicStream;

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
  // ---------------------------------------------------------------------
  // LOAD-BEARING: everything from here down to `recorder.start()` must stay
  // synchronous. It's the only stretch where this session's module-scope
  // `recorder`/`combinedStream` are set up, and it runs to completion in one
  // task precisely because nothing awaits inside it. Insert an `await`
  // anywhere in this block and a concurrent `startCapture()` call gets a
  // chance to interleave, reassigning that shared state mid-setup - which is
  // the exact class of bug the `generation` guard and per-session `myChunks`
  // above already had to be added for, twice. Don't.
  // ---------------------------------------------------------------------
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
    chrome.runtime.sendMessage({ type: 'RECORDING_FINISHED', size: blob.size });
    recorder = null;
    combinedStream = null;
    tabStream = null;
    micStream = null;
    // This session's own AudioContext, closure-captured like `myChunks` for
    // the same reason (a module-scope one would be the *next* session's by
    // now). Each recording created a fresh context; without this close() they
    // accumulate, one live audio graph per recording, for the whole browser
    // session. Safe here: the recorder has already stopped, so nothing is
    // reading from the graph any more.
    audioContext.close().catch(() => {});
    // Fire-and-forget, same as startCapture()/stopCapture() themselves -
    // the onMessage listener below must not block waiting on the upload
    // (which can take as long as the recording itself for a large file).
    // A superseded session's onstop already bailed out above via the
    // `mySession !== generation` guard, so a stale session's audio never
    // reaches here either - nothing extra to guard against for upload.
    if (blob.size > 0) {
      uploadRecording(blob);
    } else {
      postUploadStatus('No audio was captured - nothing to upload.');
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

function captureErrorMessage(error: unknown) {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return 'Microphone access was blocked. Open Settings and click Save to grant it, then try again.';
  }
  const detail = error instanceof Error && error.message ? error.message : 'unknown error';
  return `Could not start capturing audio (${detail}).`;
}

async function uploadRecording(blob: Blob) {
  const { apiKey } = await chrome.storage.local.get(['apiKey']);
  if (!apiKey) {
    retainFailedRecording(blob);
    postUploadStatus('No API key set - open Settings.' + IN_MEMORY_NOTE);
    return;
  }

  postUploadStatus('Requesting upload token...');

  let tokenResponse: Response;
  try {
    tokenResponse = await fetch(`${APP_URL}/api/tokens/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName: `Meeting ${new Date().toLocaleString('en-US')}.webm` })
    });
  } catch {
    retainFailedRecording(blob);
    postUploadStatus(`Could not reach ${APP_URL} - check your network connection.` + IN_MEMORY_NOTE);
    return;
  }

  if (!tokenResponse.ok) {
    const body = await tokenResponse.json().catch(() => ({}));
    retainFailedRecording(blob);
    postUploadStatus((body.error || 'Could not start the upload.') + IN_MEMORY_NOTE);
    return;
  }

  // Same treatment the error branch above already got: a 2xx that isn't valid
  // JSON (a proxy's HTML error page, a truncated response) would otherwise
  // reject here with nothing catching it, leaving the panel stuck on
  // "Requesting upload token..." forever.
  let token: string;
  let backendUrl: string;
  let meeting: { id?: string } | undefined;
  try {
    ({ token, backendUrl, meeting } = await tokenResponse.json());
  } catch {
    retainFailedRecording(blob);
    postUploadStatus('The app returned an unreadable response to the upload-token request.' + IN_MEMORY_NOTE);
    return;
  }

  postUploadStatus('Uploading recording...');

  const form = new FormData();
  form.append('token', token);
  form.append('file', blob, 'recording.webm');

  async function reportFailure(message: string) {
    // Companion to the mint call above: without this, a failed upload
    // would leave the Meeting row stuck at 'processing' until the
    // backend's 30-minute stale-job sweep notices, instead of failing
    // promptly the way the web dashboard's own upload failures already
    // do. See docs/superpowers/plans/2026-09-02-api-key-auth.md Task 6.
    await fetch(`${APP_URL}/api/tokens/mark-failed`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      // Optional-chained so a malformed (but parseable) mint response can't
      // turn this best-effort call into a TypeError that escapes as an
      // unhandled rejection.
      body: JSON.stringify({ meetingId: meeting?.id, message })
    }).catch(() => {});
  }

  try {
    const uploadResponse = await fetch(`${backendUrl}/api/transcribe`, { method: 'POST', body: form });
    if (!uploadResponse.ok) {
      await reportFailure(`Upload failed with status ${uploadResponse.status}.`);
      retainFailedRecording(blob);
      postUploadStatus('Upload failed - the meeting was saved as failed in your dashboard.' + IN_MEMORY_NOTE);
      return;
    }
    clearRetainedRecording();
    postUploadStatus('Uploaded - check the dashboard for transcription progress.');
  } catch {
    await reportFailure('Network error during upload from the Chrome extension.');
    retainFailedRecording(blob);
    postUploadStatus('Network error during upload - the meeting was saved as failed in your dashboard.' + IN_MEMORY_NOTE);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'OFFSCREEN_START') {
    // Acknowledged back to the background script rather than started
    // fire-and-forget: it holds off marking the session `recording: true`
    // until this resolves, so a denied mic prompt or a dead tab surfaces in
    // the side panel instead of the UI claiming a recording that isn't
    // happening. Both getUserMedia calls (inside startCapture) reject into
    // this catch.
    (async () => {
      try {
        await startCapture(message.streamId);
        sendResponse({ ok: true });
      } catch (error) {
        console.error('[offscreen] could not start capture', error);
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          // The stored grant (see permission/App.tsx, read by
          // Settings.tsx) is now known-stale - a real recording attempt
          // just proved the OS/browser no longer honors it. Reset it so
          // this error message's own remediation ("open Settings and
          // click Save") actually reopens the permission tab next time,
          // instead of Settings trusting the old flag and closing
          // immediately with nothing fixed.
          await setMicGranted(false).catch(() => {});
        }
        sendResponse({ error: captureErrorMessage(error) });
      }
    })();
    return true; // keep the message channel open for the async response
  }
  if (message.type === 'OFFSCREEN_STOP') {
    stopCapture();
  }
  if (message.type === 'RETRY_UPLOAD') {
    const blob = (globalThis as any).__lastFailedRecordingBlob as Blob | undefined;
    if (!blob) {
      // Only reachable if the offscreen document was recreated since the
      // failure (Chrome tore it down, the extension reloaded) - the
      // storage flag says a retry should be possible, but the actual
      // bytes lived only in the old document's memory and are gone.
      clearRetainedRecording();
      postUploadStatus('Nothing to retry - the recording is no longer available (the extension may have reloaded).');
      return;
    }
    uploadRecording(blob);
  }
});
