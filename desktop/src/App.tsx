// Settings UI: API key (OS keychain, never plaintext on disk, never
// re-displayed once saved) plus a native "Recent Recordings" status list
// fed by GET /api/tokens/meetings - see
// docs/superpowers/specs/2026-09-05-desktop-native-recordings-view-design.md
// for why this replaced the old embedded-website "Open Dashboard" window:
// the desktop app now answers "did it work?" on its own, and only sends
// you to the browser to actually read a transcript.
import { useEffect, useState, type ChangeEvent, type ComponentType, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertTriangle,
  ArrowUpRight,
  CheckCircle2,
  Clock3,
  History,
  Inbox,
  KeyRound,
  Loader2,
  RefreshCw,
  Settings2,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import appIcon from "@/assets/app-icon.png";
import "./App.css";

interface SettingsResponse {
  has_api_key: boolean;
  label: string | null;
  error: string | null;
  unreachable: boolean;
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
type Tone = "success" | "warning" | "destructive";

const TONE_CLASSES: Record<Tone, string> = {
  success: "bg-emerald-500/10 text-emerald-500 ring-emerald-500/15",
  warning: "bg-amber-500/10 text-amber-500 ring-amber-500/15",
  destructive: "bg-destructive/10 text-destructive ring-destructive/15",
};

function StatusBanner({
  tone,
  icon: Icon,
  children,
}: {
  tone: Tone;
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex items-start gap-2 rounded-lg px-3 py-2 text-xs leading-relaxed ring-1", TONE_CLASSES[tone])}>
      <Icon className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

// Shared shape for "nothing to show yet" states across both sections (no key
// set, a load error, an empty list) - one visual language instead of three
// slightly different ad-hoc ones.
function EmptyState({
  icon: Icon,
  spin = false,
  title,
  description,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  spin?: boolean;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <Icon className={cn("size-5", spin && "animate-spin")} />
      </div>
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

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
    <div className="flex flex-col gap-4 p-4">
      <Card className="overflow-hidden ring-1 ring-border/80">
        <div aria-hidden className="h-px bg-gradient-to-r from-primary/60 via-primary/10 to-transparent" />
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-primary/25 to-primary/5 text-primary ring-1 ring-primary/15">
              <KeyRound className="size-4" />
            </div>
            <div className="flex flex-col gap-0.5">
              <CardTitle>API Key</CardTitle>
              <CardDescription>Connects this app to your Meeting Transcriber account</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="api-key" className="text-xs font-medium text-muted-foreground">
              API Key
            </label>
            <Input
              id="api-key"
              type="password"
              value={apiKey}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value.trim())}
              placeholder={current?.has_api_key ? "Enter a new key to replace it" : "mtk_..."}
            />
            <p className="text-xs text-muted-foreground">
              Generate one on the website under Settings → API Keys.
            </p>
          </div>
          <Button
            onClick={handleSave}
            disabled={saving || !apiKey}
            className="bg-gradient-to-b from-primary to-[color-mix(in_oklch,var(--primary),black_12%)] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.12)] hover:from-primary/90"
          >
            {saving ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Saving…
              </>
            ) : (
              "Save"
            )}
          </Button>

          {saveError && (
            <StatusBanner tone="destructive" icon={XCircle}>
              {saveError}
            </StatusBanner>
          )}
          {!saveError && current?.has_api_key && current.label && (
            <StatusBanner tone="success" icon={CheckCircle2}>
              Connected as <span className="font-medium">{current.label}</span>
            </StatusBanner>
          )}
          {!saveError && current?.has_api_key && current.error && current.unreachable && (
            <StatusBanner tone="warning" icon={AlertTriangle}>
              Could not verify your API key right now ({current.error}) - it may still be valid.
            </StatusBanner>
          )}
          {!saveError && current?.has_api_key && current.error && !current.unreachable && (
            <StatusBanner tone="destructive" icon={XCircle}>
              This API key was rejected: {current.error}. Add a new one above.
            </StatusBanner>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function statusMeta(status: MeetingSummary["status"]) {
  if (status === "complete") {
    return { icon: CheckCircle2, className: "text-emerald-500", label: "Complete" };
  }
  if (status === "failed") {
    return { icon: XCircle, className: "text-destructive", label: "Failed" };
  }
  return { icon: Loader2, className: "text-amber-500 animate-spin", label: "Processing" };
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
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setRefreshing(true);
    try {
      const result = await invoke<MeetingSummary[]>("fetch_recent_meetings");
      setMeetings(result);
      setLoadError(null);
    } catch (e: unknown) {
      setLoadError(typeof e === "string" ? e : "Could not load recent recordings.");
    } finally {
      setRefreshing(false);
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
    // Refreshes immediately on un-hiding the window too, rather than
    // waiting for the next 10s tick - otherwise re-showing the window
    // right after it was hidden could display up to 10s of stale data.
    function handleVisibilityChange() {
      if (document.visibilityState === "visible") load();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasApiKey]);

  if (!hasApiKey) {
    return (
      <EmptyState
        icon={KeyRound}
        title="No API key yet"
        description="Add one in Settings to see your recordings here."
        action={
          <Button variant="outline" size="sm" onClick={onGoToSettings}>
            Go to Settings
          </Button>
        }
      />
    );
  }

  if (loadError) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Couldn't load recordings"
        description={loadError}
        action={
          <Button variant="outline" size="sm" onClick={load}>
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        }
      />
    );
  }

  if (meetings === null) {
    return <EmptyState icon={Loader2} spin title="Loading recordings…" />;
  }

  if (meetings.length === 0) {
    return (
      <EmptyState
        icon={Inbox}
        title="No recordings yet"
        description="Start a recording from the tray menu and it'll show up here."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between px-0.5">
        <h2 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {meetings.length} recording{meetings.length === 1 ? "" : "s"}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={load}
          aria-label="Refresh recordings"
          disabled={refreshing}
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} />
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        {meetings.map((meeting) => {
          const { icon: StatusIcon, className, label } = statusMeta(meeting.status);
          return (
            <button
              key={meeting.id}
              onClick={() => openUrl(meeting.meeting_url)}
              className="group flex w-full items-start gap-3 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent"
            >
              <div className="mt-0.5 shrink-0" title={label}>
                <StatusIcon className={cn("size-4", className)} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{meeting.title}</p>
                <p className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                  <Clock3 className="size-3" />
                  {relativeTime(meeting.created_at)}
                </p>
                {meeting.status === "failed" && meeting.error_message && (
                  <p className="mt-1 text-xs text-destructive">{meeting.error_message}</p>
                )}
              </div>
              <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

function NavButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: ComponentType<{ className?: string }>;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm ring-1 ring-border"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      <Icon className="size-3.5" />
      {children}
    </button>
  );
}

function App() {
  const [section, setSection] = useState<Section>("settings");
  const [hasApiKey, setHasApiKey] = useState(false);

  useEffect(() => {
    // Deliberately the fast local-only check, not get_settings() - that
    // one does a live network validate now, and gating the Recordings
    // section on it created a real race right after launch: clicking
    // Recordings before that network call resolved would wrongly show
    // "add an API key first" even with one already saved.
    invoke<boolean>("has_api_key_stored").then(setHasApiKey);
    const unlisten = listen<Section>("navigate", (event) => setSection(event.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-background">
      {/* A flat black window read as an empty placeholder rather than a
          designed surface - this is the same soft radial wash the website
          uses behind hero sections, just toned down for a small utility
          window. Purely decorative (aria-hidden, pointer-events-none), sits
          behind everything else via z-index, not layout. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-0 h-72 opacity-25"
        style={{
          background: "radial-gradient(60% 100% at 50% 0%, var(--primary), transparent 70%)",
        }}
      />

      <header className="relative z-10 flex items-center gap-2.5 px-4 py-3.5">
        <div className="relative flex size-7 shrink-0 items-center justify-center">
          <div
            aria-hidden
            className="absolute inset-0 rounded-lg bg-primary/25 blur-md"
          />
          <img src={appIcon} alt="" className="relative size-7 rounded-lg shadow-sm" />
        </div>
        <span className="text-sm font-semibold tracking-tight">Meeting Transcriber</span>
      </header>

      <nav className="relative z-10 flex gap-1 rounded-lg bg-muted/50 p-1 mx-4 mb-3 ring-1 ring-border/60">
        <NavButton active={section === "settings"} onClick={() => setSection("settings")} icon={Settings2}>
          Settings
        </NavButton>
        <NavButton active={section === "recordings"} onClick={() => setSection("recordings")} icon={History}>
          Recent Recordings
        </NavButton>
      </nav>

      <main className="relative z-10 flex-1 overflow-y-auto">
        {section === "settings" ? (
          <SettingsSection onSaved={() => setHasApiKey(true)} />
        ) : (
          <RecordingsSection hasApiKey={hasApiKey} onGoToSettings={() => setSection("settings")} />
        )}
      </main>

      <footer className="relative z-10 flex items-center justify-center border-t border-border/60 py-2.5">
        <p className="text-[11px] text-muted-foreground/70">Meeting Transcriber · Desktop</p>
      </footer>
    </div>
  );
}

export default App;
