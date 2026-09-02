import { useEffect, useState, type ChangeEvent } from 'react';
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
        <Input value={appUrl} onChange={(e: ChangeEvent<HTMLInputElement>) => setAppUrl(e.target.value)} placeholder="https://your-app.vercel.app" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">API Key</label>
        <Input type="password" value={apiKey} onChange={(e: ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value)} placeholder="mtk_..." />
        <p className="text-xs text-muted-foreground">Generate one in the app under Settings → API Keys.</p>
      </div>
      <Button onClick={handleSave}>Save</Button>
    </div>
  );
}
