# Chrome Extension Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Chrome extension that captures a Google Meet or Teams-web tab's audio plus the user's microphone, and uploads the finished recording into the existing transcription pipeline via a side-panel UI.

**Architecture:** A WXT-built MV3 extension. A content script on `meet.google.com`/`teams.microsoft.com` call pages only detects that a call is active and reports it — it does **not** own the record button, since `chrome.tabCapture` requires a genuine extension-surface user gesture. The actual "Start/Stop Recording" control lives in the extension's own Side Panel (React + the web app's existing shadcn/Base UI + Tailwind v4 components). Recording itself happens in an MV3 offscreen document (required because service workers can't touch `MediaStream`/DOM), which also owns the upload to the backend once the API-key infrastructure from the companion plan exists.

**Tech Stack:** WXT (Vite-based MV3 framework), React 19, the existing shadcn/ui (Base UI) + Tailwind v4 components copied from this repo's `components/ui/`, `chrome.tabCapture` + `chrome.offscreen` + `chrome.sidePanel` + `chrome.storage` APIs.

**Spec:** `docs/superpowers/specs/2026-09-02-desktop-extension-capture-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-02-api-key-auth.md` must be done first — this extension mints upload tokens via `POST {appUrl}/api/tokens/upload` with a Bearer API key.

## Global Constraints

- No automated test framework in this repo, and MV3 native capture APIs (`tabCapture`, `offscreen`) cannot be meaningfully driven by any browser-automation tool anyway — every task ends with a real manual verification (load the unpacked extension, actually join/simulate a call), per `CLAUDE.md`'s testing philosophy and the design spec's own Testing Strategy section.
- Starting `tabCapture` requires a real user gesture from an extension-owned surface (side panel or popup) — never try to trigger it from a content script's injected button on the Meet/Teams page itself; that gesture context does not qualify.
- The API key is stored in `chrome.storage.local`, not an OS keychain — MV3 extensions have no keychain access. This is an accepted, explicitly-scoped limitation (see the design spec's Security section): the key only grants "mint one upload token," not general account access.
- Both the app's own deployed URL (`appUrl`, for minting tokens) and the resulting `backendUrl` (returned by that mint call, for the actual upload) are user-configured in the extension's own settings, never hardcoded — this is a self-hosted, single-user app with no fixed public domain baked into the code.
- Follow the design spec's error-handling rules: a `Meeting` row already exists (created at mint time) before any recording starts, so a failure after that point should always leave a `'failed'` row with a clear reason, never a silently vanished job.

---

### Task 1: Scaffold the WXT project with React + Tailwind v4 + shadcn components

**Files:**
- Create: `extension/` (new top-level directory, sibling to `backend/`)
- Create: `extension/wxt.config.ts`
- Create: `extension/package.json`
- Create: `extension/tsconfig.json`
- Create: `extension/entrypoints/sidepanel/{index.html,main.tsx,App.tsx}`
- Create: `extension/components/ui/` (copy of this repo's `components/ui/button.jsx`, `card.jsx`, `input.jsx`, `badge.jsx`, `tabs.jsx` at minimum — the set this plan's UI tasks use)
- Create: `extension/lib/utils.ts` (the `cn()` helper, copied from this repo's `lib/utils.js`)

**Interfaces:**
- Produces: a buildable WXT project (`npm run dev` opens a Chrome instance with the extension loaded; `npm run build` produces `extension/.output/chrome-mv3/`).

- [ ] **Step 1: Scaffold with the WXT CLI**

```bash
cd "/Volumes/Crucial X9/meeting transcriber"
npx wxt@latest init extension --template react
cd extension
npm install
```

- [ ] **Step 2: Add Tailwind v4**

```bash
npm install tailwindcss @tailwindcss/vite
```

In `extension/wxt.config.ts`, add the Tailwind Vite plugin to the `vite` config block (WXT exposes a `vite` option that receives a real Vite config — consult WXT's current "Tailwind CSS" guide at `wxt.dev` if the exact key has moved since this plan was written, but the underlying mechanism is the standard `@tailwindcss/vite` plugin):

```ts
import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()]
  }),
  manifest: {
    name: 'Meeting Transcriber Capture',
    permissions: ['tabCapture', 'offscreen', 'storage', 'sidePanel', 'activeTab'],
    host_permissions: ['https://meet.google.com/*', 'https://teams.microsoft.com/*']
  }
});
```

Create `extension/entrypoints/sidepanel/style.css` with:

```css
@import "tailwindcss";
```

and import it from `main.tsx` (Step 3 below).

- [ ] **Step 3: Copy the design-system pieces this plan needs**

Copy these files from the repo root into `extension/`, adjusting only the import paths (`@/lib/utils` → `../../lib/utils` or configure the same `@/` alias in `extension/tsconfig.json` and `wxt.config.ts`'s `alias` option to keep them byte-identical):

- `components/ui/button.jsx` → `extension/components/ui/button.jsx`
- `components/ui/card.jsx` → `extension/components/ui/card.jsx`
- `components/ui/input.jsx` → `extension/components/ui/input.jsx`
- `components/ui/badge.jsx` → `extension/components/ui/badge.jsx`
- `lib/utils.js` → `extension/lib/utils.js`

Write `extension/entrypoints/sidepanel/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

Write a placeholder `extension/entrypoints/sidepanel/App.tsx` (replaced fully in Task 5):

```tsx
export default function App() {
  return <div className="p-4 text-sm">Meeting Transcriber</div>;
}
```

- [ ] **Step 4: Verify it builds and loads**

```bash
cd extension && npm run dev
```

Expected: Chrome opens with the extension loaded unpacked. Click the extension's toolbar icon — confirm the side panel opens and renders "Meeting Transcriber" styled with Tailwind (check dev tools computed styles show real Tailwind utility classes applied, not unstyled text), proving the Tailwind v4 + shadcn pipeline works end to end before building real functionality on top of it.

- [ ] **Step 5: Commit**

```bash
cd "/Volumes/Crucial X9/meeting transcriber"
git add extension/
git commit -m "$(cat <<'EOF'
Scaffold Chrome extension with WXT, React, Tailwind v4

Reuses the web app's shadcn/ui (Base UI) components directly, copied
into the extension's own source per shadcn's normal pattern, which
sidesteps MV3 CSP restrictions on external component packages.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Content script — detect an active Meet/Teams call

**Files:**
- Create: `extension/entrypoints/meeting-detector.content.ts`

**Interfaces:**
- Produces: sends a runtime message `{ type: 'MEETING_TAB_DETECTED', platform: 'meet' | 'teams', tabId }` to the background script when a call page is detected, and `{ type: 'MEETING_TAB_LEFT' }` when it's no longer on one. Does **not** capture anything itself and does **not** own any clickable UI — see Global Constraints on why the record action must live in the side panel.

- [ ] **Step 1: Write the content script**

```ts
// WXT auto-generates the manifest content_scripts entry from this
// file's `matches` config - one file covers both platforms since the
// detection logic (and the message it sends) is identical, only the
// `platform` label differs.
export default defineContentScript({
  matches: ['https://meet.google.com/*', 'https://teams.microsoft.com/*'],
  main() {
    const platform = location.hostname.includes('meet.google.com') ? 'meet' : 'teams';

    // A call page for both platforms always has a real meeting-code-shaped
    // path (Meet: /xxx-xxxx-xxx, Teams web: /v2/?meetingjoin or similar
    // under /l/meetup-join/). Rather than pattern-matching every possible
    // URL shape (which shifts over time - see the design spec's note on
    // DOM-scraping fragility), treat "matched by the manifest at all" as
    // good enough: both host permissions above are scoped to
    // meet.google.com/teams.microsoft.com specifically, and the landing/
    // pre-join pages on both are rare enough visits that a false positive
    // just means the side panel offers "Record" a little early, which is
    // harmless - the user still has to click Start themselves.
    chrome.runtime.sendMessage({ type: 'MEETING_TAB_DETECTED', platform });

    window.addEventListener('beforeunload', () => {
      chrome.runtime.sendMessage({ type: 'MEETING_TAB_LEFT' });
    });
  }
});
```

- [ ] **Step 2: Verify detection fires**

In `extension/entrypoints/background.ts` (created properly in Task 3, but stub it now just for this check):

```ts
export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message) => {
    console.log('[background] received', message);
  });
});
```

Run `npm run dev`, navigate to `meet.google.com` (any page under that domain, e.g. start a real or empty meeting), open the extension's service worker console (`chrome://extensions` → the extension → "service worker" link → Console). Expected: `[background] received {type: 'MEETING_TAB_DETECTED', platform: 'meet'}` logged. Repeat for `teams.microsoft.com`.

- [ ] **Step 3: Commit**

```bash
git add extension/entrypoints/meeting-detector.content.ts extension/entrypoints/background.ts
git commit -m "$(cat <<'EOF'
Add content script to detect Meet/Teams call pages

Detection only - the actual record control lives in the side panel,
since chrome.tabCapture requires a user gesture from an extension-
owned surface, not a content-script-injected page button.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Background service worker — track state, drive `tabCapture`, own the offscreen document

**Files:**
- Modify: `extension/entrypoints/background.ts`

**Interfaces:**
- Consumes: `MEETING_TAB_DETECTED` / `MEETING_TAB_LEFT` messages from the content script (Task 2); `START_RECORDING` / `STOP_RECORDING` messages from the side panel (Task 5).
- Produces: maintains `{ activeMeetingTabId: number | null, platform: string | null, recording: boolean }` in memory, exposed to the side panel via a `GET_STATE` message + a broadcast `STATE_CHANGED` message on every transition; creates/tears down the offscreen document; forwards `{ streamId, tabId }` to it to start capture.

- [ ] **Step 1: Write the background script**

```ts
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
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] as chrome.runtime.ContextType[] });
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'] as chrome.offscreen.Reason[],
    justification: 'Records tab audio and microphone for meeting transcription.'
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
```

- [ ] **Step 2: Verify state tracking manually**

`npm run dev`, open the side panel, open the service worker console. Navigate a tab to `meet.google.com`, confirm `STATE_CHANGED` fires with `activeMeetingTabId` set. Close that tab, confirm `MEETING_TAB_LEFT` fires and state resets. (The `START_RECORDING`/`OFFSCREEN_*` half of this is verified together with Task 4, since it needs the real offscreen document to respond to.)

- [ ] **Step 3: Commit**

```bash
git add extension/entrypoints/background.ts
git commit -m "$(cat <<'EOF'
Add background service worker: state tracking + tabCapture orchestration

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Offscreen document — capture tab audio + mic, record, hold the finished file

**Files:**
- Create: `extension/entrypoints/offscreen/index.html`
- Create: `extension/entrypoints/offscreen/main.ts`

**Interfaces:**
- Consumes: `OFFSCREEN_START { streamId }` / `OFFSCREEN_STOP` messages from the background script.
- Produces: on stop, holds the recorded audio as a `Blob` in memory and sends `{ type: 'RECORDING_FINISHED', hasAudio: true }` to the background script (the side panel then triggers the upload — see Task 6 — by calling a `GET_RECORDED_BLOB`-style flow is unnecessary since the upload itself is also done from this offscreen document, which is the one context already holding the `Blob` and already has full network access).

- [ ] **Step 1: Write the offscreen document**

`extension/entrypoints/offscreen/index.html`:

```html
<!doctype html>
<html>
  <body>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
```

`extension/entrypoints/offscreen/main.ts`:

```ts
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
```

- [ ] **Step 2: Verify a real recording round-trip**

`npm run dev`, join a real (or empty, just to have tab audio playing something — e.g. play a YouTube video in the "meeting" tab as a stand-in for remote participant audio during this isolated test) Meet call in one tab, open the side panel, and manually drive the flow from the service-worker console for this step since the side panel UI doesn't exist until Task 5:

```js
chrome.runtime.sendMessage({ type: 'START_RECORDING' });
// wait ~10 seconds, speak into your mic and let the tab's audio play
chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
```

Then, in the offscreen document's own console (`chrome://extensions` → the extension → inspect the offscreen document), run `console.log(__lastRecordingBlob.size)`. Expected: a non-zero byte size proportional to ~10 seconds of audio (roughly tens of KB for Opus at this bitrate) — confirms both tab audio and mic are actually being captured and encoded, not silently failing to an empty blob.

- [ ] **Step 3: Commit**

```bash
git add extension/entrypoints/offscreen/
git commit -m "$(cat <<'EOF'
Add offscreen document: tab + mic audio capture via tabCapture

Mixes both sources into one recorded track via the Web Audio API,
matching how a single microphone recording already reaches Deepgram's
diarization in the existing upload flow.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Side panel UI — settings, meeting detection, start/stop, status

**Files:**
- Modify: `extension/entrypoints/sidepanel/App.tsx`
- Create: `extension/entrypoints/sidepanel/Settings.tsx`
- Create: `extension/lib/storage.ts`

**Interfaces:**
- Consumes: `GET_STATE`/`STATE_CHANGED`/`RECORDING_INTERRUPTED`/`RECORDING_FINISHED`/`UPLOAD_STATUS` messages (from Tasks 3–4, and `UPLOAD_STATUS` from Task 6).
- Produces: `chrome.storage.local` keys `appUrl` and `apiKey`, read by Task 6's upload logic.

- [ ] **Step 1: Storage helper**

```ts
// extension/lib/storage.ts
export async function getSettings(): Promise<{ appUrl: string; apiKey: string }> {
  const result = await chrome.storage.local.get(['appUrl', 'apiKey']);
  return { appUrl: result.appUrl || '', apiKey: result.apiKey || '' };
}

export async function saveSettings(appUrl: string, apiKey: string) {
  await chrome.storage.local.set({ appUrl, apiKey });
}
```

- [ ] **Step 2: Settings panel**

```tsx
// extension/entrypoints/sidepanel/Settings.tsx
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { getSettings, saveSettings } from '../../lib/storage';

export default function Settings({ onClose }: { onClose: () => void }) {
  const [appUrl, setAppUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  useEffect(() => {
    getSettings().then((s) => {
      setAppUrl(s.appUrl);
      setApiKey(s.apiKey);
    });
  }, []);

  async function handleSave() {
    await saveSettings(appUrl.trim(), apiKey.trim());
    onClose();
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-medium">Settings</h2>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">App URL</label>
        <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://your-app.vercel.app" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">API Key</label>
        <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="mtk_..." />
        <p className="text-xs text-muted-foreground">Generate one in the app under Settings → API Keys.</p>
      </div>
      <Button onClick={handleSave}>Save</Button>
    </div>
  );
}
```

- [ ] **Step 3: Main panel**

```tsx
// extension/entrypoints/sidepanel/App.tsx
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { Badge } from '../../components/ui/badge';
import Settings from './Settings';

type State = { activeMeetingTabId: number | null; platform: 'meet' | 'teams' | null; recording: boolean };

export default function App() {
  const [state, setState] = useState<State>({ activeMeetingTabId: null, platform: null, recording: false });
  const [showSettings, setShowSettings] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);

  useEffect(() => {
    chrome.runtime.sendMessage({ type: 'GET_STATE' }, (s) => s && setState(s));
    const listener = (message: any) => {
      if (message.type === 'STATE_CHANGED') setState(message.state);
      if (message.type === 'RECORDING_INTERRUPTED') setInterrupted(true);
      if (message.type === 'UPLOAD_STATUS') setUploadStatus(message.status);
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, []);

  function handleStart() {
    setInterrupted(false);
    setUploadStatus(null);
    chrome.runtime.sendMessage({ type: 'START_RECORDING' });
  }

  function handleStop() {
    chrome.runtime.sendMessage({ type: 'STOP_RECORDING' });
  }

  if (showSettings) return <Settings onClose={() => setShowSettings(false)} />;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h1 className="text-sm font-medium">Meeting Transcriber</h1>
        <Button variant="ghost" size="sm" onClick={() => setShowSettings(true)}>Settings</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">
            {state.activeMeetingTabId ? `${state.platform === 'meet' ? 'Google Meet' : 'Teams'} call detected` : 'No call detected'}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {interrupted && <Badge variant="destructive">Recording stopped — meeting tab was closed</Badge>}
          {state.recording ? (
            <Button variant="destructive" onClick={handleStop}>Stop recording</Button>
          ) : (
            <Button onClick={handleStart} disabled={!state.activeMeetingTabId}>Start recording</Button>
          )}
          {uploadStatus && <p className="text-xs text-muted-foreground">{uploadStatus}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
```

- [ ] **Step 4: Manual verification**

`npm run dev`, open the side panel, enter a placeholder App URL/API key in Settings and confirm they persist after closing and reopening the panel (`chrome.storage.local` round-trip). Join a real Meet call, confirm the card updates to "Google Meet call detected" and "Start recording" becomes enabled. Click it, confirm it flips to "Stop recording". Click stop. Close the meeting tab while recording is active in a second pass, confirm the "Recording stopped — meeting tab was closed" badge appears.

- [ ] **Step 5: Commit**

```bash
git add extension/entrypoints/sidepanel/ extension/lib/storage.ts
git commit -m "$(cat <<'EOF'
Add side panel UI: settings, meeting detection, start/stop controls

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Upload the finished recording

**Files:**
- Modify: `extension/entrypoints/offscreen/main.ts`

**Interfaces:**
- Consumes: `mtk_`-prefixed API key + `appUrl` from `chrome.storage.local` (Task 5); the recorded `Blob` (Task 4); `POST {appUrl}/api/tokens/upload` (from the companion API-key plan).
- Produces: `UPLOAD_STATUS` messages (`'uploading'`, `'complete'`, or an error string) broadcast to the side panel.

- [ ] **Step 1: Add the upload flow to the offscreen document**

Append to `extension/entrypoints/offscreen/main.ts`:

```ts
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
```

Update the `OFFSCREEN_STOP` handler to call it:

```ts
  if (message.type === 'OFFSCREEN_STOP') {
    const blob = stopCapture();
    if (blob && blob.size > 0) {
      chrome.runtime.sendMessage({ type: 'RECORDING_FINISHED', size: blob.size });
      uploadRecording(blob);
    } else {
      chrome.runtime.sendMessage({ type: 'UPLOAD_STATUS', status: 'No audio was captured — nothing to upload.' });
    }
  }
```

- [ ] **Step 2: End-to-end manual verification**

Prerequisite: complete `docs/superpowers/plans/2026-09-02-api-key-auth.md` first and have a real API key from `/settings`. Set the real App URL + key in the extension's Settings. Join a real Meet call, record ~15 seconds of real speech (yours, plus whatever's playing in the tab), stop. Confirm the side panel shows "Requesting upload token…" → "Uploading recording…" → "Uploaded — check the dashboard...". Open the actual web dashboard, confirm a new "Transcribing..." row appeared and, after processing, reaches `'complete'` with a real transcript matching what was said.

Also verify a failure path: temporarily set a wrong API key, record, stop — confirm the side panel shows the "Could not start the upload" message rather than hanging silently.

- [ ] **Step 3: Commit**

```bash
git add extension/entrypoints/offscreen/main.ts
git commit -m "$(cat <<'EOF'
Upload finished recordings through the existing transcription pipeline

Mints an upload token via the API-key Route Handler, then uploads to
the backend exactly like the web dashboard already does - no new
transcription logic anywhere in this extension.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Done when

- Joining a real Meet or Teams-web call, clicking "Start recording" in the side panel, talking for a bit, and clicking "Stop" results in a real transcribed meeting appearing in the existing web dashboard — the same success criterion as a manual file upload, just triggered from the extension instead.
- Closing the meeting tab mid-recording surfaces a clear "interrupted" state rather than silently losing the recording or uploading a broken file.
