import { useEffect, useState, type ChangeEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { APP_URL, getSettings, saveSettings } from '../../lib/storage';

// Declared as `optional_host_permissions` in wxt.config.ts and requested here,
// from a real click. Deliberately the broad pattern rather than just the app's
// own origin: the *backend* URL the upload actually goes to is returned by the
// token-mint call at recording-stop time, not typed by the user here, so a
// per-origin grant would need a second prompt mid-recording - a moment where
// there is no user gesture to request one with, and the recording would be
// lost. One prompt at setup time covers both fetches for good.
const UPLOAD_HOST_PERMISSION = 'https://*/*';

export default function Settings({ onClose }: { onClose: () => void }) {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // True once a microphone grant is still needed, so the UI can offer a
  // direct link into Chrome's own settings as a fallback - a user who
  // clicked "Block" in the tab this opens (see handleSave) needs a way
  // back in, not another paragraph of instructions.
  const [micBlocked, setMicBlocked] = useState(false);

  // chrome://settings pages can't be opened via a plain <a href> (Chrome
  // blocks navigating a regular link to its own settings UI), but
  // chrome.tabs.create() can - this is a normal, permitted extension
  // capability that needs no extra manifest permission, unlike reading other
  // tabs' contents.
  function openMicSettings() {
    chrome.tabs.create({ url: 'chrome://settings/content/microphone' });
  }

  useEffect(() => {
    getSettings().then((s) => {
      setApiKey(s.apiKey);
    });
  }, []);

  async function handleSave() {
    setProblem(null);
    setMicBlocked(false);
    setSaving(true);
    try {
      // chrome.permissions.request() only works from a real user gesture, so
      // it has to be the first thing this click handler does - an `await` on
      // anything else first (a storage write, say) can spend the gesture and
      // make Chrome reject the call outright. Without this grant, both of the
      // offscreen document's upload fetches (mint token at `appUrl`, then the
      // file upload at the backend URL that call returns) are plain
      // cross-origin requests that the backend's routes send no CORS headers
      // for, so both fail.
      let granted = false;
      try {
        granted = await chrome.permissions.request({ origins: [UPLOAD_HOST_PERMISSION] });
      } catch {
        granted = false;
      }
      if (!granted) {
        setProblem('Recording uploads need permission to reach your app - please allow it to enable uploads.');
        return;
      }

      // Confirm the key is real and not revoked before saving anything -
      // without this, a typo'd or stale key only surfaces much later, when
      // an actual recording's upload silently fails past the point the user
      // would think to check. See app/api/tokens/validate/route.js - unlike
      // /api/tokens/upload, it has no side effect (mints no token, creates
      // no Meeting row), so it's cheap to call on every Save.
      try {
        const response = await fetch(`${APP_URL}/api/tokens/validate`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` }
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok || !body.valid) {
          setProblem(body.error || 'That API key was rejected by the app - double check it.');
          return;
        }
      } catch {
        setProblem(`Could not reach ${APP_URL} to check the API key - check your network connection.`);
        return;
      }

      await saveSettings(apiKey);

      // Chrome gives a side panel no UX affordance to show a getUserMedia
      // prompt at all - the call just rejects immediately as though the
      // user declined, and no per-site entry ever appears in
      // chrome://settings/content/microphone, allowed or blocked (confirmed
      // against real Chromium extension bug reports, not assumed - this
      // used to call getUserMedia() directly from here, which is exactly
      // what silently failed). The documented workaround is a real, full
      // browser tab, which does have that affordance -
      // entrypoints/permission/App.tsx requests it there instead; the grant
      // it produces applies to this extension's own origin, which is what
      // the offscreen document's later getUserMedia() call during an actual
      // recording relies on.
      //
      // Reading `micGranted` from storage rather than
      // navigator.permissions.query('microphone') - that query reads from
      // the exact content-settings store the comment above says never gets
      // an entry for this grant, so it can never report 'granted' here and
      // would otherwise reopen the permission tab forever even after the
      // user grants access. permission/App.tsx sets this flag itself right
      // after its own getUserMedia() call actually succeeds.
      const { micGranted } = await getSettings();

      if (!micGranted) {
        setMicBlocked(true);
        setProblem(
          'Saved. One more step: a new tab just opened to ask for microphone access - grant it there, then come back and click Save again.'
        );
        chrome.tabs.create({ url: chrome.runtime.getURL('permission.html') });
        return;
      }

      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">Settings</h2>
        {/* The only way out of this view used to be a fully successful
            save (see handleSave's onClose() call below) - closing the
            side panel and reopening it was the only escape otherwise. */}
        <Button variant="ghost" size="sm" onClick={onClose}>Back</Button>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">API Key</label>
        <Input type="password" value={apiKey} onChange={(e: ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value.trim())} placeholder="mtk_..." />
        <p className="text-xs text-muted-foreground">Generate one in the app under Settings → API Keys.</p>
      </div>
      <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
      <p className="text-xs text-muted-foreground">
        Saving asks Chrome for network access to your app and for microphone access, both needed before a recording can be captured and uploaded.
      </p>
      {problem && <p className="text-xs text-destructive">{problem}</p>}
      {micBlocked && (
        <>
          <Button variant="outline" onClick={openMicSettings}>
            Open Chrome microphone settings
          </Button>
          <p className="text-xs text-muted-foreground">
            Only needed if the new tab's own prompt was denied - use this to reset it.
          </p>
        </>
      )}
    </div>
  );
}
