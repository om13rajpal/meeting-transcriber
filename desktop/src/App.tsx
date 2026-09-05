// Settings UI: API key (OS keychain, never plaintext on disk, never
// re-displayed once saved) plus a native "Recent Recordings" status list
// fed by GET /api/tokens/meetings - see
// docs/superpowers/specs/2026-09-05-desktop-native-recordings-view-design.md
// for why this replaced the old embedded-website "Open Dashboard" window:
// the desktop app now answers "did it work?" on its own, and only sends
// you to the browser to actually read a transcript.
import { useEffect, useState, type ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import "./App.css";

interface SettingsResponse {
  has_api_key: boolean;
  label: string | null;
  error: string | null;
}

interface MeetingSummary {
  id: string;
  title: string;
  status: "processing" | "complete" | "failed";
  created_at: string;
  error_message: string | null;
  meeting_url: string;
}

type Section = "settings" | "recordings";

function SettingsSection({ onSaved }: { onSaved: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [current, setCurrent] = useState<SettingsResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function refresh() {
    invoke<SettingsResponse>("get_settings").then(setCurrent);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    try {
      // save_settings validates the key against the app (see
      // validate_api_key() in lib.rs) before writing it to the keychain,
      // and rejects with a message on an invalid/revoked key or an
      // unreachable app - both surface here instead of only failing
      // silently much later, during an actual recording's upload.
      await invoke("save_settings", { apiKey });
      setApiKey("");
      refresh();
      onSaved();
    } catch (e: unknown) {
      setSaveError(typeof e === "string" ? e : "Could not save the API key.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-sm font-medium">Meeting Transcriber Settings</h1>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">API Key</label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value.trim())}
          placeholder={current?.has_api_key ? "Enter a new key to replace it" : "mtk_..."}
        />
        <p className="text-xs text-muted-foreground">
          Generate one in the app under Settings → API Keys.
        </p>
      </div>
      <Button onClick={handleSave} disabled={saving}>
        {saving ? "Saving..." : "Save"}
      </Button>
      {saveError && <p className="text-xs text-destructive">{saveError}</p>}
      {current?.has_api_key && current.label && (
        <p className="text-xs text-emerald-500">Connected as: {current.label}</p>
      )}
      {current?.has_api_key && current.error && (
        <p className="text-xs text-destructive">
          This API key was rejected: {current.error}. Add a new one above.
        </p>
      )}
    </div>
  );
}

function statusColor(status: MeetingSummary["status"]) {
  if (status === "complete") return "text-emerald-500";
  if (status === "failed") return "text-destructive";
  return "text-muted-foreground";
}

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function RecordingsSection({
  hasApiKey,
  onGoToSettings,
}: {
  hasApiKey: boolean;
  onGoToSettings: () => void;
}) {
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const result = await invoke<MeetingSummary[]>("fetch_recent_meetings");
      setMeetings(result);
      setLoadError(null);
    } catch (e: unknown) {
      setLoadError(typeof e === "string" ? e : "Could not load recent recordings.");
    }
  }

  useEffect(() => {
    if (!hasApiKey) return;
    load();
    // Polls only while this section is actually visible - a hidden tray
    // window has no reason to keep hitting the backend every 10s.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasApiKey]);

  if (!hasApiKey) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-muted-foreground">Add an API key in Settings first.</p>
        <Button variant="outline" onClick={onGoToSettings}>
          Go to Settings
        </Button>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-destructive">{loadError}</p>
        <Button variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  if (meetings === null) {
    return (
      <div className="p-4">
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (meetings.length === 0) {
    return (
      <div className="p-4">
        <p className="text-xs text-muted-foreground">No recordings yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4">
      {meetings.map((meeting) => (
        <button
          key={meeting.id}
          onClick={() => openUrl(meeting.meeting_url)}
          className="flex flex-col items-start gap-0.5 rounded border border-border p-2 text-left hover:bg-accent"
        >
          <span className="text-xs font-medium">{meeting.title}</span>
          <span className={`text-xs ${statusColor(meeting.status)}`}>
            {meeting.status} · {relativeTime(meeting.created_at)}
          </span>
          {meeting.status === "failed" && meeting.error_message && (
            <span className="text-xs text-destructive">{meeting.error_message}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function App() {
  const [section, setSection] = useState<Section>("settings");
  const [hasApiKey, setHasApiKey] = useState(false);

  useEffect(() => {
    invoke<SettingsResponse>("get_settings").then((s) => setHasApiKey(s.has_api_key));
    const unlisten = listen<Section>("navigate", (event) => setSection(event.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return (
    <div className="flex flex-col">
      <div className="flex border-b border-border">
        <button
          className={`flex-1 p-2 text-xs ${section === "settings" ? "font-medium" : "text-muted-foreground"}`}
          onClick={() => setSection("settings")}
        >
          Settings
        </button>
        <button
          className={`flex-1 p-2 text-xs ${section === "recordings" ? "font-medium" : "text-muted-foreground"}`}
          onClick={() => setSection("recordings")}
        >
          Recent Recordings
        </button>
      </div>
      {section === "settings" ? (
        <SettingsSection onSaved={() => setHasApiKey(true)} />
      ) : (
        <RecordingsSection hasApiKey={hasApiKey} onGoToSettings={() => setSection("settings")} />
      )}
    </div>
  );
}

export default App;
