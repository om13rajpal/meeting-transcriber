import { useEffect, useState } from 'react';
import { APP_URL } from '../../lib/storage';

interface MeetingSummary {
  id: string;
  title: string;
  status: 'processing' | 'complete' | 'failed';
  createdAt: string;
  errorMessage: string | null;
}

function statusColor(status: MeetingSummary['status']) {
  if (status === 'complete') return 'text-emerald-500';
  if (status === 'failed') return 'text-destructive';
  return 'text-muted-foreground';
}

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

// Mirrors the desktop app's own "Recent Recordings" view (same GET
// /api/tokens/meetings endpoint, same reasoning: this extension can answer
// "did it work?" on its own instead of making you go check the website
// after every recording). Fetched directly from here, not relayed through
// the background script - unlike the offscreen document (see
// entrypoints/offscreen/main.ts), a side panel is a normal extension page
// with full chrome.storage/fetch access.
export default function RecentRecordings({ refreshSignal }: { refreshSignal: number }) {
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const { apiKey } = await chrome.storage.local.get<{ apiKey?: string }>(['apiKey']);
    if (!apiKey) {
      setMeetings(null);
      setError(null);
      return;
    }
    try {
      const response = await fetch(`${APP_URL}/api/tokens/meetings`, {
        headers: { Authorization: `Bearer ${apiKey}` }
      });
      if (!response.ok) {
        setError('Could not load recent recordings.');
        return;
      }
      const body = await response.json();
      setMeetings(body.meetings || []);
      setError(null);
    } catch {
      setError('Could not reach the app to load recent recordings.');
    }
  }

  useEffect(() => {
    load();
    // Same polling shape as the desktop app's Recordings section: a 10s
    // tick while visible, plus an immediate refresh on becoming visible so
    // reopening the panel doesn't show up to 10s of stale data.
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') load();
    }, 10000);
    function handleVisibilityChange() {
      if (document.visibilityState === 'visible') load();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refreshes immediately whenever the caller's own upload-status changes
  // (a recording just went from "Uploading..." to "Uploaded") instead of
  // waiting for the next 10s poll tick to notice.
  useEffect(() => {
    if (refreshSignal > 0) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  function openMeeting(id: string) {
    chrome.tabs.create({ url: `${APP_URL}/meeting/${id}` });
  }

  if (!meetings && !error) return null;

  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-xs font-medium text-muted-foreground">Recent Recordings</h2>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {meetings && meetings.length === 0 && !error && (
        <p className="text-xs text-muted-foreground">No recordings yet.</p>
      )}
      {meetings && meetings.length > 0 && (
        <div className="flex flex-col gap-1.5">
          {meetings.slice(0, 8).map((meeting) => (
            <button
              key={meeting.id}
              onClick={() => openMeeting(meeting.id)}
              className="flex flex-col items-start gap-0.5 rounded border border-border p-2 text-left text-xs hover:bg-accent"
            >
              <span className="w-full truncate font-medium">{meeting.title}</span>
              <span className={statusColor(meeting.status)}>
                {meeting.status} · {relativeTime(meeting.createdAt)}
              </span>
              {meeting.status === 'failed' && meeting.errorMessage && (
                <span className="text-destructive">{meeting.errorMessage}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
