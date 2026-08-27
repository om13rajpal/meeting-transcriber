'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { UploadCloud, Search, Trash2, FileAudio, FileVideo, LogOut, Loader2, AlertCircle, Webhook, Plus, X, RotateCw } from 'lucide-react';
import { logout } from '@/app/actions/auth';
import { createUploadToken } from '@/app/actions/transcribe';
import { deleteMeeting, markMeetingFailed } from '@/app/actions/meetings';
import { searchMeetings } from '@/app/actions/search';
import { getWebhooks, saveWebhooks } from '@/app/actions/settings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  // Pin the locale explicitly: this renders on the server (Node's locale)
  // then hydrates on the client (the browser's locale) - if they differ,
  // `undefined` here produces different text in each environment and
  // React throws a hydration mismatch. Pinning the locale alone isn't
  // quite enough, though: depending on the exact ICU/CLDR data bundled
  // with each runtime, `toLocaleString` can put a regular space or a
  // narrow no-break space (U+202F) before "AM"/"PM" - invisible to the
  // eye, but a genuine character-for-character mismatch to React. Collapse
  // every space-like character to a normal space so server and client
  // produce byte-identical output regardless of which ICU version ran.
  return date
    .toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })
    .replace(/[  -   　]/g, ' ');
}

function formatCost(costUsd) {
  if (typeof costUsd !== 'number') return null;
  return `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`;
}

function initialsFor(email) {
  return (email || '?').slice(0, 2).toUpperCase();
}

const WEBHOOK_FORMATS = [
  { value: 'generic', label: 'Generic JSON' },
  { value: 'discord', label: 'Discord' },
  { value: 'slack', label: 'Slack' },
  { value: 'teams', label: 'Microsoft Teams' }
];
const EMPTY_WEBHOOK = { url: '', format: 'generic' };

// fetch() has no upload progress event, which is exactly what made a large,
// slow, or stalled upload indistinguishable from a working one - the user
// just sees a spinner with no way to tell it apart from something actually
// stuck. XMLHttpRequest still has upload.onprogress, so this wraps it in a
// promise with a fetch-like { ok, status, json } result to minimize the
// blast radius of the swap. Also returns the live xhr so the caller can
// abort() it from a Cancel button.
function uploadWithProgress(url, formData, onProgress) {
  const xhr = new XMLHttpRequest();
  const promise = new Promise((resolve, reject) => {
    xhr.open('POST', url);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let json = {};
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        // Non-JSON response body; fall through with an empty object like
        // the existing fetch(...).json().catch(() => ({})) pattern did.
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, json });
    };
    xhr.onerror = () => reject(new Error('Could not reach the transcription backend.'));
    xhr.onabort = () => reject(Object.assign(new Error('Upload cancelled.'), { cancelled: true }));
    xhr.send(formData);
  });
  return { xhr, promise };
}

export default function Dashboard({ userEmail, initialMeetings, usageSummary }) {
  const router = useRouter();
  const fileInputRef = useRef(null);
  const searchDebounceRef = useRef(null);

  const [meetings, setMeetings] = useState(initialMeetings);
  const [files, setFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [, startLogoutTransition] = useTransition();
  const [webhookOpen, setWebhookOpen] = useState(false);
  const [webhookLoading, setWebhookLoading] = useState(false);
  const [webhookSaving, setWebhookSaving] = useState(false);
  const [webhooks, setWebhooks] = useState([]);

  // Polls while any meeting is still 'processing', so a job kicked off by
  // this tab (or one still running when the page was reloaded, since status
  // lives in the database, not component state) always resolves to
  // 'complete'/'failed' without the user having to refresh manually. Runs
  // on every meetings/searchQuery change but only does anything when a
  // processing row actually exists.
  useEffect(() => {
    if (!meetings.some((m) => m.status === 'processing')) return undefined;

    const interval = window.setInterval(async () => {
      const refreshed = await searchMeetings(searchQuery);
      setMeetings((prev) => {
        const wasProcessing = new Set(prev.filter((m) => m.status === 'processing').map((m) => m.id));
        for (const m of refreshed) {
          if (!wasProcessing.has(m.id)) continue;
          if (m.status === 'complete') toast.success(`"${m.title}" finished transcribing.`);
          else if (m.status === 'failed') toast.error(`"${m.title}" failed: ${m.errorMessage || 'unknown error'}`);
        }
        return refreshed;
      });
    }, 4000);

    return () => window.clearInterval(interval);
  }, [meetings, searchQuery]);

  // Warns before an accidental reload/close while any file is still being
  // sent to the backend. Nothing can make the raw byte transfer itself
  // resumable (the browser is what's streaming it), so the best available
  // protection is stopping the user from losing it by accident.
  useEffect(() => {
    if (!files.some((f) => f.status === 'uploading')) return undefined;

    function handleBeforeUnload(e) {
      e.preventDefault();
      e.returnValue = '';
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [files]);

  function updateFileEntry(key, patch) {
    setFiles((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  }

  function selectFiles(fileList) {
    const newEntries = Array.from(fileList || []).map((file, i) => ({
      key: `${Date.now()}-${i}-${file.name}-${file.size}`,
      file,
      status: 'pending',
      progress: 0,
      error: null,
      xhr: null
    }));
    if (newEntries.length) setFiles((prev) => [...prev, ...newEntries]);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    selectFiles(e.dataTransfer.files);
  }

  function removeFile(key) {
    setFiles((prev) => prev.filter((f) => f.key !== key));
  }

  function cancelFile(key) {
    setFiles((prev) => {
      prev.find((f) => f.key === key)?.xhr?.abort();
      return prev;
    });
  }

  function clearFinished() {
    setFiles((prev) => prev.filter((f) => f.status === 'pending' || f.status === 'uploading'));
  }

  // Uploads one file independently of the others - each entry tracks its
  // own progress/status/xhr, so several recordings can be in flight at
  // once, each becoming its own 'processing' Meeting row as soon as its
  // token is minted.
  async function uploadOneFile(key, file) {
    let meetingId = null;
    updateFileEntry(key, { status: 'uploading', progress: 0, error: null });

    try {
      const tokenResult = await createUploadToken(file.name);
      if (tokenResult.error) {
        updateFileEntry(key, { status: 'error', error: tokenResult.error });
        return;
      }

      if (tokenResult.meeting) {
        meetingId = tokenResult.meeting.id;
        setMeetings((prev) => [tokenResult.meeting, ...prev]);
      }

      const formData = new FormData();
      formData.append('file', file);
      formData.append('token', tokenResult.token);

      const { xhr, promise } = uploadWithProgress(
        `${tokenResult.backendUrl}/api/transcribe`,
        formData,
        (fraction) => updateFileEntry(key, { progress: Math.round(fraction * 100) })
      );
      updateFileEntry(key, { xhr });

      const uploadResponse = await promise;
      const result = uploadResponse.json;

      if (!uploadResponse.ok) {
        const message = result.error || 'Something went wrong. Please try again.';
        // The upload itself failed, so the row already added above would
        // otherwise sit at 'processing' until the backend's 30-minute
        // stale-job sweep notices. Fail it now instead, since the browser
        // already knows.
        if (meetingId) await markMeetingFailed(meetingId, message);
        updateFileEntry(key, { status: 'error', error: message });
        const refreshed = await searchMeetings(searchQuery);
        setMeetings(refreshed);
        return;
      }

      // The backend responds as soon as the job is created, before ffmpeg or
      // Deepgram have run - transcription continues in the background, so
      // the polling effect above picks it up from there.
      updateFileEntry(key, { status: 'done', progress: 100 });
      const refreshed = await searchMeetings(searchQuery);
      setMeetings(refreshed);
    } catch (err) {
      const cancelled = Boolean(err?.cancelled);
      const message = cancelled ? 'Cancelled.' : 'Something went wrong during upload. Please try again.';
      updateFileEntry(key, { status: cancelled ? 'cancelled' : 'error', error: message });
      if (meetingId) {
        await markMeetingFailed(meetingId, message);
        const refreshed = await searchMeetings(searchQuery);
        setMeetings(refreshed);
      }
    }
  }

  function handleTranscribeAll() {
    files.filter((f) => f.status === 'pending').forEach((f) => uploadOneFile(f.key, f.file));
  }

  function retryFile(key) {
    const entry = files.find((f) => f.key === key);
    if (entry) uploadOneFile(key, entry.file);
  }

  const pendingCount = files.filter((f) => f.status === 'pending').length;
  const hasFinished = files.some((f) => f.status === 'done' || f.status === 'error' || f.status === 'cancelled');

  async function confirmDelete() {
    const id = pendingDeleteId;
    setPendingDeleteId(null);
    const result = await deleteMeeting(id);
    if (result.error) {
      toast.error(result.error);
      return;
    }
    setMeetings((prev) => prev.filter((m) => m.id !== id));
  }

  function handleSearchChange(value) {
    setSearchQuery(value);
    window.clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = window.setTimeout(async () => {
      setSearching(true);
      try {
        const results = await searchMeetings(value);
        setMeetings(results);
      } finally {
        setSearching(false);
      }
    }, 300);
  }

  function handleLogout() {
    startLogoutTransition(() => {
      logout();
    });
  }

  async function openWebhookDialog() {
    setWebhookOpen(true);
    setWebhookLoading(true);
    try {
      const result = await getWebhooks();
      setWebhooks(result.webhooks.length ? result.webhooks : [{ ...EMPTY_WEBHOOK }]);
    } finally {
      setWebhookLoading(false);
    }
  }

  function updateWebhookField(index, field, value) {
    setWebhooks((prev) => prev.map((w, i) => (i === index ? { ...w, [field]: value } : w)));
  }

  function addWebhookRow() {
    setWebhooks((prev) => [...prev, { ...EMPTY_WEBHOOK }]);
  }

  function removeWebhookRow(index) {
    setWebhooks((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSaveWebhooks() {
    setWebhookSaving(true);
    try {
      const result = await saveWebhooks(webhooks);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setWebhookOpen(false);
      toast.success('Webhooks saved.');
    } finally {
      setWebhookSaving(false);
    }
  }

  const showEmptyState = files.length === 0 && !searching && meetings.length === 0 && !searchQuery.trim();
  const showNoResultsState = files.length === 0 && !searching && meetings.length === 0 && searchQuery.trim();

  return (
    <div className="min-h-screen">
      <header className="border-b">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-6 py-4">
          <span className="text-base font-semibold">Meeting Transcriber</span>
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-2 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
              <Avatar className="size-8">
                <AvatarFallback className="text-xs">{initialsFor(userEmail)}</AvatarFallback>
              </Avatar>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuLabel className="font-normal text-muted-foreground">{userEmail}</DropdownMenuLabel>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={openWebhookDialog}>
                <Webhook />
                Webhook
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={handleLogout} variant="destructive">
                <LogOut />
                Log out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-8">
        <h2 className="mb-3 text-sm font-semibold text-muted-foreground">New Transcription</h2>

        <Card
          className={`cursor-pointer border-2 border-dashed py-10 text-center shadow-none transition-colors ${dragOver ? 'border-primary bg-accent/40' : 'border-border hover:border-primary/60'}`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <CardContent className="flex flex-col items-center gap-2">
            <UploadCloud className="mb-1 size-8 text-primary" />
            <p className="font-medium">Drop your recordings here</p>
            <p className="text-sm text-muted-foreground">MP4 or MP3 &middot; multiple files at once &middot; or click to browse</p>
          </CardContent>
        </Card>
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,video/*"
          multiple
          hidden
          onChange={(e) => {
            selectFiles(e.target.files);
            e.target.value = '';
          }}
        />

        {files.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {files.map((f) => (
              <Card key={f.key} className="shadow-none">
                <CardContent className="flex items-center gap-3">
                  {f.file.type.startsWith('video') ? (
                    <FileVideo className="size-5 shrink-0 text-muted-foreground" />
                  ) : (
                    <FileAudio className="size-5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="truncate">{f.file.name}</span>
                      <span className="shrink-0 text-muted-foreground">({formatBytes(f.file.size)})</span>
                    </div>
                    {f.status === 'uploading' && (
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-primary transition-[width] duration-300"
                          style={{ width: `${f.progress}%` }}
                        />
                      </div>
                    )}
                    {f.status === 'error' && (
                      <div className="mt-0.5 truncate text-xs text-destructive">{f.error}</div>
                    )}
                    {f.status === 'cancelled' && (
                      <div className="mt-0.5 text-xs text-muted-foreground">Cancelled.</div>
                    )}
                    {f.status === 'done' && (
                      <div className="mt-0.5 text-xs text-muted-foreground">Uploaded &middot; transcribing in the background.</div>
                    )}
                  </div>
                  {f.status === 'uploading' ? (
                    <Button variant="outline" size="sm" className="shrink-0" onClick={() => cancelFile(f.key)}>
                      Cancel
                    </Button>
                  ) : f.status === 'error' || f.status === 'cancelled' ? (
                    <>
                      <Button variant="outline" size="sm" className="shrink-0" onClick={() => retryFile(f.key)}>
                        <RotateCw /> Retry
                      </Button>
                      <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" onClick={() => removeFile(f.key)}>
                        <X />
                        <span className="sr-only">Remove</span>
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" onClick={() => removeFile(f.key)}>
                      <X />
                      <span className="sr-only">Remove</span>
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
            <div className="flex justify-end gap-2">
              {hasFinished && (
                <Button variant="outline" size="sm" onClick={clearFinished}>Clear finished</Button>
              )}
              <Button size="sm" onClick={handleTranscribeAll} disabled={pendingCount === 0}>
                Transcribe{pendingCount > 1 ? ` all (${pendingCount})` : ''}
              </Button>
            </div>
          </div>
        )}

        <div className="mt-10 mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-muted-foreground">Past Meetings</h2>
            {usageSummary && usageSummary.count > 0 && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                This month: {usageSummary.minutes} min transcribed &middot; ~{formatCost(usageSummary.costUsd)} estimated
              </p>
            )}
          </div>
          <div className="relative w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              placeholder="Search meetings&hellip;"
              aria-label="Search meetings"
              className="pl-8"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
            />
          </div>
        </div>

        {searching && (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
          </div>
        )}

        {!searching && meetings.length > 0 && (
          <div className="flex flex-col gap-2">
            {meetings.map((meeting) => (
              <Card
                key={meeting.id}
                className="cursor-pointer shadow-none transition-colors hover:border-primary/50"
                onClick={() => router.push(`/meeting/${meeting.id}`)}
              >
                <CardContent className="flex items-center justify-between gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{meeting.title}</div>
                    <div className="text-xs text-muted-foreground">
                      {[
                        meeting.isVideo ? 'Video' : 'Audio',
                        formatDuration(meeting.durationSeconds),
                        formatDate(meeting.createdAt)
                      ].filter(Boolean).join(' · ')}
                    </div>
                    {meeting.status === 'processing' ? (
                      <div className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                        <Loader2 className="size-3.5 animate-spin" />
                        Transcribing&hellip;
                      </div>
                    ) : meeting.status === 'failed' ? (
                      <div className="mt-1 flex items-center gap-1.5 truncate text-sm text-destructive">
                        <AlertCircle className="size-3.5 shrink-0" />
                        <span className="truncate">{meeting.errorMessage || 'Transcription failed.'}</span>
                      </div>
                    ) : (
                      <div className="mt-1 truncate text-sm text-muted-foreground">{meeting.preview}</div>
                    )}
                    {meeting.tags?.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {meeting.tags.map((tag) => (
                          <Badge key={tag} variant="secondary">{tag}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPendingDeleteId(meeting.id);
                    }}
                  >
                    <Trash2 />
                    <span className="sr-only">Delete</span>
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {showEmptyState && (
          <Card className="border-dashed py-14 text-center shadow-none">
            <CardContent className="text-muted-foreground">
              No meetings yet. Upload a recording above to get started.
            </CardContent>
          </Card>
        )}
        {showNoResultsState && (
          <Card className="border-dashed py-14 text-center shadow-none">
            <CardContent className="text-muted-foreground">No meetings match your search.</CardContent>
          </Card>
        )}
      </main>

      <Dialog open={pendingDeleteId !== null} onOpenChange={(open) => !open && setPendingDeleteId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this meeting?</DialogTitle>
            <DialogDescription>This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" onClick={confirmDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={webhookOpen} onOpenChange={setWebhookOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Webhooks</DialogTitle>
            <DialogDescription>
              When a meeting finishes or fails, the transcript is sent to each URL below. Pick a format
              to match where it's going &mdash; Discord and Slack post a readable message, Microsoft Teams
              posts a card (via a Workflows webhook), and Generic JSON sends the full raw data for your
              own automation.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            {webhooks.map((webhook, index) => (
              <div key={index} className="flex items-center gap-2">
                <Input
                  type="url"
                  placeholder="https://..."
                  value={webhook.url}
                  onChange={(e) => updateWebhookField(index, 'url', e.target.value)}
                  disabled={webhookLoading}
                  className="flex-1"
                />
                <Select
                  value={webhook.format}
                  onValueChange={(value) => updateWebhookField(index, 'format', value)}
                  disabled={webhookLoading}
                >
                  <SelectTrigger className="w-40 shrink-0">
                    <SelectValue>
                      {(value) => WEBHOOK_FORMATS.find((f) => f.value === value)?.label || value}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {WEBHOOK_FORMATS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="shrink-0 text-muted-foreground hover:text-destructive"
                  onClick={() => removeWebhookRow(index)}
                  disabled={webhookLoading}
                >
                  <X />
                  <span className="sr-only">Remove</span>
                </Button>
              </div>
            ))}
            <Button variant="outline" size="sm" className="self-start" onClick={addWebhookRow} disabled={webhookLoading}>
              <Plus /> Add webhook
            </Button>
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={handleSaveWebhooks} disabled={webhookLoading || webhookSaving}>
              {webhookSaving && <Loader2 className="animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
