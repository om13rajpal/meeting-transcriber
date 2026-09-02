type State = {
  activeMeetingTabId: number | null;
  platform: 'meet' | 'teams' | null;
  recording: boolean;
};

type StoredState = { backgroundState?: State };

const IDLE_STATE: State = { activeMeetingTabId: null, platform: null, recording: false };

let state: State = { ...IDLE_STATE };

// MV3 terminates this service worker after ~30 seconds of inactivity, and
// nothing messages it while a recording is in progress - so it WILL be evicted
// during any real recording, and plain module state would come back as
// IDLE_STATE while the offscreen document is still happily recording. That
// leaves the side panel showing "No call detected" with no way to stop the
// still-running capture, and re-enables "Start recording" so a second,
// concurrent session can be started on top of the first.
//
// chrome.storage.session, not .local, on purpose: this describes a recording
// happening *right now*, and restoring `recording: true` after a browser
// restart would be actively wrong - session storage is cleared for us.
async function persistState() {
  await chrome.storage.session.set({ backgroundState: state });
}

async function setState(next: State) {
  state = next;
  await persistState();
  broadcastState();
}

// Memoized as a promise rather than a boolean flag so two messages arriving
// back-to-back on a freshly-woken worker both wait for the *same* restore to
// finish, instead of the second one racing ahead with un-restored state.
let restoreOnce: Promise<void> | null = null;

function ensureStateRestored() {
  if (!restoreOnce) {
    restoreOnce = (async () => {
      const stored = await chrome.storage.session.get<StoredState>('backgroundState');
      const saved = stored.backgroundState;
      if (!saved) return;
      state = { ...IDLE_STATE, ...saved };

      // Storage can itself be stale - it says what was true when the worker
      // was last alive, not what is true now. The offscreen document is the
      // thing that would actually be recording, so if it's gone (crashed, or
      // never recreated), correct the restored state rather than trusting it
      // blindly and offering a "Stop recording" button for nothing.
      if (state.recording && !(await hasOffscreenDocument())) {
        state = { ...state, recording: false };
        await persistState();
      }
    })();
  }
  return restoreOnce;
}

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'STATE_CHANGED', state }).catch(() => {
    // No listener open (side panel closed) - fine, it reads current
    // state via GET_STATE the next time it opens.
  });
}

async function hasOffscreenDocument() {
  // Contextually typed against chrome.runtime.ContextFilter['contextTypes']
  // (a template-literal union derived from the ContextType enum in the
  // installed @types/chrome) - no cast needed, the plain string literal
  // already satisfies it.
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return existing.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    // Same reasoning as above: chrome.offscreen.CreateParameters['reasons']
    // is a template-literal union over the Reason enum, so the literal
    // array is already assignable without an `as` cast.
    reasons: ['USER_MEDIA'],
    justification: 'Records tab audio and microphone for meeting transcription.',
  });
}

function startErrorMessage(error: unknown) {
  const detail = error instanceof Error && error.message ? error.message : 'unknown error';
  // getMediaStreamId's most likely failure is a missing activeTab grant, which
  // the user fixes by invoking the extension from the meeting tab itself -
  // worth saying out loud, since the raw error text doesn't suggest it.
  return `Could not start recording (${detail}). If the meeting tab wasn't the active tab the last time you clicked this extension's toolbar icon, click it again from that tab and retry.`;
}

async function startRecording() {
  try {
    if (state.recording) {
      // Belt-and-braces against a double start: persisted state (above) should
      // already keep the side panel's Start button disabled mid-recording, but
      // a second concurrent session would orphan the first one's tab/mic
      // capture with nothing left to ever send it an OFFSCREEN_STOP.
      return { error: 'Already recording.' };
    }
    if (!state.activeMeetingTabId) {
      return { error: 'No active meeting tab detected.' };
    }

    // getMediaStreamId needs two things: a user gesture (this runs in direct
    // response to the side panel's own button click, a valid extension-surface
    // gesture - a content script's own event would not qualify) and an
    // activeTab grant covering the target tab, which the user gets by clicking
    // the extension's toolbar icon while that tab is active. See the `action`
    // entry in wxt.config.ts for why that grant path has to exist at all.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: state.activeMeetingTabId });

    await ensureOffscreenDocument();

    // Request/response, not fire-and-forget: the offscreen document's
    // getUserMedia calls fail well after this message is delivered (mic
    // denied, tab gone), and flipping state to `recording: true` before it
    // confirms is exactly how the UI ends up claiming a recording started when
    // nothing is being captured at all.
    const ack = await chrome.runtime.sendMessage({ type: 'OFFSCREEN_START', streamId });
    if (!ack?.ok) {
      return { error: ack?.error || 'The recorder did not start.' };
    }

    await setState({ ...state, recording: true });
    return { ok: true };
  } catch (error) {
    // Without this catch the whole start path fails silently: the async
    // handler's promise rejects, sendResponse is never called, and the side
    // panel sits there looking like the click did nothing.
    console.error('[background] could not start recording', error);
    return { error: startErrorMessage(error) };
  }
}

async function stopRecording() {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
  await setState({ ...state, recording: false });
}

async function handleMeetingTabGone() {
  if (state.recording) {
    // Real edge case from the design spec: the tab closed/navigated away
    // mid-capture. The tab's audio dies with it, but the offscreen document's
    // MediaRecorder does NOT - without this stop it keeps running forever,
    // holding the microphone open, with no UI left that believes a recording
    // exists to stop it. OFFSCREEN_STOP runs the normal onstop -> Blob ->
    // upload path, so the partial recording still reaches the dashboard
    // instead of being silently lost. Must happen before the state reset
    // below, since that's what makes the panel forget the recording.
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' }).catch(() => {});
    // Tell the side panel so it can surface "recording stopped, meeting tab
    // was closed" instead of a truncated file appearing unexplained.
    chrome.runtime.sendMessage({ type: 'RECORDING_INTERRUPTED', reason: 'tab_closed' }).catch(() => {});
  }
  await setState({ ...IDLE_STATE });
}

async function handleMessage(message: any, sender: chrome.runtime.MessageSender) {
  await ensureStateRestored();

  if (message.type === 'MEETING_TAB_DETECTED') {
    await setState({ ...state, activeMeetingTabId: sender.tab?.id ?? null, platform: message.platform });
    return;
  }

  if (message.type === 'MEETING_TAB_LEFT') {
    // Only the tab that owns the current recording may tear it down - a second
    // Meet/Teams tab closing is none of this recording's business, and acting
    // on it would stop a capture running on a completely different tab.
    if (sender.tab?.id !== state.activeMeetingTabId) return;
    await handleMeetingTabGone();
    return;
  }

  if (message.type === 'GET_STATE') {
    return state;
  }

  if (message.type === 'START_RECORDING') {
    return startRecording();
  }

  if (message.type === 'STOP_RECORDING') {
    await stopRecording();
    return { ok: true };
  }

  // Relay upload-lifecycle events from the offscreen document straight
  // through to the side panel, so it doesn't need its own connection
  // to the offscreen document.
  if (message.type === 'UPLOAD_STATUS') {
    chrome.runtime.sendMessage(message).catch(() => {});
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handleMessage(message, sender).then(sendResponse, (error) => {
      console.error('[background] message handler failed', error);
      sendResponse({ error: 'The extension hit an unexpected error.' });
    });
    return true; // every branch of handleMessage is async (state is restored from storage first)
  });

  // A second, more reliable signal for "the meeting tab is gone" than the
  // content script's beforeunload, which doesn't fire on every tab-close path
  // (force-quit, tab crash). Additive, not a replacement: whichever arrives
  // first resets state, and the tab-id check makes the loser a no-op rather
  // than a double stop. Needs no "tabs" permission - onRemoved only exposes
  // the id, not any of the tab's sensitive properties.
  chrome.tabs.onRemoved.addListener((tabId) => {
    void (async () => {
      await ensureStateRestored();
      if (tabId !== state.activeMeetingTabId) return;
      await handleMeetingTabGone();
    })();
  });

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
