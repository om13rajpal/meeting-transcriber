// Settings UI: just the API key (OS keychain, never plaintext on disk,
// never re-displayed once saved). The App URL is a fixed constant on the
// Rust side (APP_URL in lib.rs) - this is a single-user, self-hosted app
// pointed at one deployment, so there's nothing for the user to type or
// mistype there. This is the credential the desktop app uses to
// authenticate with the web app's /api/tokens/upload,
// /api/tokens/mark-failed, and /api/tokens/validate routes.
import { useEffect, useState, type ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import "./App.css";

interface SettingsResponse {
  has_api_key: boolean;
}

function App() {
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    invoke<SettingsResponse>("get_settings").then((s) => {
      setHasKey(s.has_api_key);
    });
  }, []);

  async function handleSave() {
    setError(null);
    setSaving(true);
    try {
      // save_settings validates the key against the app (see
      // validate_api_key() in lib.rs) before writing it to the keychain,
      // and rejects with a message on an invalid/revoked key or an
      // unreachable app - both surface here instead of only failing
      // silently much later, during an actual recording's upload.
      await invoke("save_settings", { apiKey });
      setSaved(true);
      setHasKey(hasKey || Boolean(apiKey));
      setApiKey("");
      setTimeout(() => setSaved(false), 2000);
    } catch (e: unknown) {
      setError(typeof e === "string" ? e : "Could not save the API key.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-sm font-medium">Meeting Transcriber Settings</h1>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">
          API Key {hasKey && <span className="text-emerald-500">(saved)</span>}
        </label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value.trim())}
          placeholder={hasKey ? "Enter a new key to replace it" : "mtk_..."}
        />
        <p className="text-xs text-muted-foreground">
          Generate one in the app under Settings → API Keys.
        </p>
      </div>
      <Button onClick={handleSave} disabled={saving}>
        {saving ? "Saving..." : saved ? "Saved" : "Save"}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export default App;
