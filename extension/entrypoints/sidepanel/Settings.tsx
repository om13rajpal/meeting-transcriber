import { useEffect, useState, type ChangeEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { getSettings, saveSettings } from '../../lib/storage';

// Declared as `optional_host_permissions` in wxt.config.ts and requested here,
// from a real click. Deliberately the broad pattern rather than just the app's
// own origin: the *backend* URL the upload actually goes to is returned by the
// token-mint call at recording-stop time, not typed by the user here, so a
// per-origin grant would need a second prompt mid-recording - a moment where
// there is no user gesture to request one with, and the recording would be
// lost. One prompt at setup time covers both fetches for good.
const UPLOAD_HOST_PERMISSION = 'https://*/*';

export default function Settings({ onClose }: { onClose: () => void }) {
  const [appUrl, setAppUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    getSettings().then((s) => {
      setAppUrl(s.appUrl);
      setApiKey(s.apiKey);
    });
  }, []);

  async function handleSave() {
    setProblem(null);
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

      await saveSettings(appUrl.trim(), apiKey.trim());

      // Prime the microphone permission from here, the one visible surface
      // this extension has. Recording itself runs in an offscreen document,
      // which has no visible UI, and Chrome cannot show a permission prompt
      // from one - its getUserMedia({ audio: true }) just rejects with
      // NotAllowedError. Granting once here persists for the extension's
      // origin in this profile, so the offscreen document's later calls
      // succeed silently. The track itself isn't wanted for anything, so it's
      // stopped the moment the prompt resolves.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
      } catch {
        // Settings are already saved at this point (they're valid regardless);
        // staying on this screen is just how the message gets seen. Clicking
        // Save again retries, which is why this isn't a one-shot flow.
        setProblem(
          'Saved, but microphone access was blocked - recordings will fail until you allow it. Click Save again to retry, or allow the microphone for this extension in Chrome site settings.'
        );
        return;
      }

      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <h2 className="text-sm font-medium">Settings</h2>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">App URL</label>
        <Input value={appUrl} onChange={(e: ChangeEvent<HTMLInputElement>) => setAppUrl(e.target.value)} placeholder="https://your-app.vercel.app" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">API Key</label>
        <Input type="password" value={apiKey} onChange={(e: ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value)} placeholder="mtk_..." />
        <p className="text-xs text-muted-foreground">Generate one in the app under Settings → API Keys.</p>
      </div>
      <Button onClick={handleSave} disabled={saving}>{saving ? 'Saving...' : 'Save'}</Button>
      <p className="text-xs text-muted-foreground">
        Saving asks Chrome for network access to your app and for microphone access, both needed before a recording can be captured and uploaded.
      </p>
      {problem && <p className="text-xs text-destructive">{problem}</p>}
    </div>
  );
}
