import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { setMicGranted } from '../../lib/storage';

// Chrome's own limitation, confirmed against real Chromium extension
// discussions (not guessed): a side panel has no UX affordance to show a
// getUserMedia permission prompt at all - the request just rejects
// immediately as though the user declined, and no per-site entry ever
// appears in chrome://settings/content/microphone, allowed or blocked.
// The documented workaround is exactly this - a real, full browser tab,
// which does have that affordance - opened from Settings.tsx via
// chrome.tabs.create() instead of calling getUserMedia() from the side
// panel itself. The grant this produces applies to the extension's own
// origin (chrome-extension://<id>), which is what the offscreen document
// uses when it later starts a real recording.
type Status = 'checking' | 'granted' | 'denied';

export default function App() {
  const [status, setStatus] = useState<Status>('checking');

  async function requestMic() {
    setStatus('checking');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Only here to trigger/confirm the grant - this tab never records
      // anything itself.
      stream.getTracks().forEach((t) => t.stop());
      // Record the real grant ourselves - this is the only place that can
      // observe it. Settings.tsx reads this flag instead of querying
      // Chrome's permission state, which never reflects an extension-origin
      // mic grant (see the comment there).
      await setMicGranted(true);
      setStatus('granted');
    } catch {
      setStatus('denied');
    }
  }

  useEffect(() => {
    requestMic();
  }, []);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-8 text-center text-foreground">
      <h1 className="text-lg font-medium">Meeting Transcriber</h1>
      {status === 'checking' && (
        <p className="text-sm text-muted-foreground">Requesting microphone access…</p>
      )}
      {status === 'granted' && (
        <>
          <p className="text-sm text-emerald-500">Microphone access granted.</p>
          <p className="text-xs text-muted-foreground">
            You can close this tab and go back to the extension's side panel.
          </p>
        </>
      )}
      {status === 'denied' && (
        <>
          <p className="text-sm text-destructive">Microphone access was denied.</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            Check the microphone icon in this tab's address bar, or
            chrome://settings/content/microphone, then try again.
          </p>
          <Button onClick={requestMic}>Try again</Button>
        </>
      )}
    </div>
  );
}
