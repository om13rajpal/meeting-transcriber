// Settings UI: App URL (plain local config file) + API key (OS keychain,
// never plaintext on disk, never re-displayed once saved). This is the
// credential the desktop app uses in later tasks to authenticate with the
// web app's /api/tokens/upload and /api/tokens/mark-failed routes.
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import "./App.css";

interface SettingsResponse {
  app_url: string;
  has_api_key: boolean;
}

function App() {
  const [appUrl, setAppUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<SettingsResponse>("get_settings").then((s) => {
      setAppUrl(s.app_url);
      setHasKey(s.has_api_key);
    });
  }, []);

  async function handleSave() {
    await invoke("save_settings", {
      appUrl: appUrl.trim(),
      apiKey: apiKey.trim(),
    });
    setSaved(true);
    setHasKey(hasKey || Boolean(apiKey.trim()));
    setApiKey("");
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-sm font-medium">Meeting Transcriber Settings</h1>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">App URL</label>
        <Input
          value={appUrl}
          onChange={(e) => setAppUrl(e.target.value)}
          placeholder="https://your-app.vercel.app"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">
          API Key {hasKey && <span className="text-emerald-500">(saved)</span>}
        </label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? "Enter a new key to replace it" : "mtk_..."}
        />
        <p className="text-xs text-muted-foreground">
          Generate one in the app under Settings → API Keys.
        </p>
      </div>
      <Button onClick={handleSave}>{saved ? "Saved" : "Save"}</Button>
    </div>
  );
}

export default App;
