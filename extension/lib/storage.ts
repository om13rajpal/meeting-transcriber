// This extension only ever talks to one deployment - a single-user,
// self-hosted app (see the root CLAUDE.md) - so the App URL is a fixed
// constant, not something the user types in Settings. Update this one
// line (and rebuild) if the app's domain ever changes; that's simpler and
// less error-prone for a solo deployment than a settings field nobody
// needs to touch in practice.
export const APP_URL = 'https://transcriber.omrajpal.in';

export async function getSettings(): Promise<{ apiKey: string; micGranted: boolean }> {
  const result = await chrome.storage.local.get<{ apiKey?: string; micGranted?: boolean }>([
    'apiKey',
    'micGranted'
  ]);
  return { apiKey: result.apiKey || '', micGranted: result.micGranted || false };
}

export async function saveSettings(apiKey: string) {
  await chrome.storage.local.set({ apiKey });
}

// Set by entrypoints/permission/App.tsx itself right after its own
// getUserMedia() call actually succeeds - the one place that can observe a
// real grant. Settings.tsx reads this instead of
// navigator.permissions.query('microphone'), which - per the comment this
// replaces in Settings.tsx - never gets a content-settings entry for an
// extension-origin grant in the first place, so it can never report
// 'granted' for this flow and would otherwise loop the permission tab
// forever even after the user grants access.
export async function setMicGranted(granted: boolean) {
  await chrome.storage.local.set({ micGranted: granted });
}
