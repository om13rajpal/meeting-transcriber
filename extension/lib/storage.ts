export async function getSettings(): Promise<{ appUrl: string; apiKey: string }> {
  const result = await chrome.storage.local.get<{ appUrl?: string; apiKey?: string }>(['appUrl', 'apiKey']);
  return { appUrl: result.appUrl || '', apiKey: result.apiKey || '' };
}

export async function saveSettings(appUrl: string, apiKey: string) {
  await chrome.storage.local.set({ appUrl, apiKey });
}
