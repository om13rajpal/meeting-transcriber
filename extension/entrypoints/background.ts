type State = {
  activeMeetingTabId: number | null;
  platform: 'meet' | 'teams' | null;
  recording: boolean;
};

let state: State = { activeMeetingTabId: null, platform: null, recording: false };

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'STATE_CHANGED', state }).catch(() => {
    // No listener open (side panel closed) - fine, it reads current
    // state via GET_STATE the next time it opens.
  });
}

async function ensureOffscreenDocument() {
  // Contextually typed against chrome.runtime.ContextFilter['contextTypes']
  // (a template-literal union derived from the ContextType enum in the
  // installed @types/chrome) - no cast needed, the plain string literal
  // already satisfies it.
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    // Same reasoning as above: chrome.offscreen.CreateParameters['reasons']
    // is a template-literal union over the Reason enum, so the literal
    // array is already assignable without an `as` cast.
    reasons: ['USER_MEDIA'],
    justification: 'Records tab audio and microphone for meeting transcription.',
  });
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'MEETING_TAB_DETECTED') {
      state = { ...state, activeMeetingTabId: sender.tab?.id ?? null, platform: message.platform };
      broadcastState();
    }

    if (message.type === 'MEETING_TAB_LEFT') {
      if (state.recording) {
        // Real edge case from the design spec: the tab closed/navigated
        // away mid-capture. tabCapture dies with it - tell the side
        // panel so it can surface "recording stopped, meeting tab was
        // closed" instead of silently uploading a truncated file
        // unlabeled.
        chrome.runtime.sendMessage({ type: 'RECORDING_INTERRUPTED', reason: 'tab_closed' }).catch(() => {});
      }
      state = { activeMeetingTabId: null, platform: null, recording: false };
      broadcastState();
    }

    if (message.type === 'GET_STATE') {
      sendResponse(state);
    }

    if (message.type === 'START_RECORDING') {
      (async () => {
        if (!state.activeMeetingTabId) {
          sendResponse({ error: 'No active meeting tab detected.' });
          return;
        }
        // getMediaStreamId requires the calling context to have a user
        // gesture - it's called here in direct response to a
        // chrome.runtime.sendMessage from the side panel's own button
        // click handler (Task 5), which is a valid extension-surface
        // gesture. Calling it from a bare content-script event would not
        // qualify.
        const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: state.activeMeetingTabId });
        await ensureOffscreenDocument();
        chrome.runtime.sendMessage({ type: 'OFFSCREEN_START', streamId });
        state = { ...state, recording: true };
        broadcastState();
        sendResponse({ ok: true });
      })();
      return true; // keep the message channel open for the async response
    }

    if (message.type === 'STOP_RECORDING') {
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP' });
      state = { ...state, recording: false };
      broadcastState();
      sendResponse({ ok: true });
    }

    // Relay upload-lifecycle events from the offscreen document straight
    // through to the side panel, so it doesn't need its own connection
    // to the offscreen document.
    if (message.type === 'UPLOAD_STATUS') {
      chrome.runtime.sendMessage(message).catch(() => {});
    }
  });

  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
