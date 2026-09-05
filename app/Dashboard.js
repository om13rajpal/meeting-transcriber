'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { UploadCloud, Search, Trash2, FileAudio, FileVideo, Loader2, X, RotateCw, Tag } from 'lucide-react';
import { createUploadToken } from '@/app/actions/transcribe';
import { deleteMeeting, deleteMeetings, addTagToMeetings, markMeetingFailed, retryMeeting, cancelMeeting } from '@/app/actions/meetings';
import { searchMeetings } from '@/app/actions/search';
import { highlightText, cn } from '@/lib/utils';
import AppHeader from '@/components/brand/AppHeader';
import StatusPill from '@/components/brand/StatusPill';
import MetaLine from '@/components/brand/MetaLine';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription
} from '@/components/ui/empty';
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
    .replace(/[  -   　]/g, ' ');
}

function formatCost(costUsd) {
  if (typeof costUsd !== 'number') return null;
  return `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`;
}

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

export default function Dashboard({ userEmail, avatarUrl, initialMeetings, usageSummary }) {
  const router = useRouter();
  const fileInputRef = useRef(null);
  const searchDebounceRef = useRef(null);

  const [meetings, setMeetings] = useState(initialMeetings);
  const [files, setFiles] = useState([]);
  const [dragOver, setDragOver] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState(null);
  // Meeting ids with a Retry/Cancel request currently in flight - just
  // disables the button against a double-click, not a loading spinner.
  const [actioningIds, setActioningIds] = useState(new Set());
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkTagOpen, setBulkTagOpen] = useState(false);
  const [bulkTagValue, setBulkTagValue] = useState('');
  const [bulkTagSaving, setBulkTagSaving] = useState(false);

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
    const ids = pendingDeleteIds;
    setPendingDeleteIds(null);
    if (!ids || !ids.length) return;

    const result = ids.length === 1 ? await deleteMeeting(ids[0]) : await deleteMeetings(ids);
    if (result.error) {
      toast.error(result.error);
      return;
    }
    const idSet = new Set(ids);
    setMeetings((prev) => prev.filter((m) => !idSet.has(m.id)));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      ids.forEach((id) => next.delete(id));
      return next;
    });
  }

  async function handleRetry(id) {
    setActioningIds((prev) => new Set(prev).add(id));
    const result = await retryMeeting(id);
    setActioningIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (result.error) {
      toast.error(result.error);
      return;
    }
    // Optimistic: the backend responds 202 and keeps working in the
    // background, same as a fresh upload - flip this row to 'processing'
    // locally right away so the existing 4s poll-while-processing effect
    // picks it up, instead of waiting for the next unrelated refresh.
    setMeetings((prev) => prev.map((m) => (m.id === id ? { ...m, status: 'processing', errorMessage: null } : m)));
  }

  async function handleCancel(id) {
    setActioningIds((prev) => new Set(prev).add(id));
    const result = await cancelMeeting(id);
    setActioningIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    if (result.error) {
      toast.error(result.error);
      return;
    }
    const refreshed = await searchMeetings(searchQuery);
    setMeetings(refreshed);
  }

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  function openBulkTagDialog() {
    setBulkTagValue('');
    setBulkTagOpen(true);
  }

  async function handleBulkAddTag() {
    const trimmed = bulkTagValue.trim();
    if (!trimmed) return;

    setBulkTagSaving(true);
    try {
      const result = await addTagToMeetings(Array.from(selectedIds), trimmed);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setBulkTagOpen(false);
      clearSelection();
      toast.success(`Tag added to ${result.count} meeting${result.count === 1 ? '' : 's'}.`);
      const refreshed = await searchMeetings(searchQuery);
      setMeetings(refreshed);
    } finally {
      setBulkTagSaving(false);
    }
  }

  function handleSearchChange(value) {
    setSearchQuery(value);
    clearSelection();
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

  const showEmptyState = files.length === 0 && !searching && meetings.length === 0 && !searchQuery.trim();
  const showNoResultsState = files.length === 0 && !searching && meetings.length === 0 && searchQuery.trim();

  return (
    <div className="min-h-screen" style={{ background: 'var(--cr-ink-app)' }}>
      <AppHeader userEmail={userEmail} avatarUrl={avatarUrl} />

      <main className="mx-auto px-6 py-8" style={{ maxWidth: 'var(--cr-measure-app)' }}>
        <h2 className="mb-3 font-mono uppercase text-[var(--cr-text-muted)]" style={{ fontSize: 'var(--cr-type-mono)', letterSpacing: 'var(--cr-tracking-eyebrow)' }}>
          New Transcription
        </h2>

        <Card
          className={cn(
            'cursor-pointer border-2 border-dashed py-10 text-center shadow-none transition-colors duration-[var(--cr-dur-hover)] ease-[var(--cr-ease-out)]',
            dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/60'
          )}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          <CardContent className="flex flex-col items-center gap-2">
            <UploadCloud className="mb-1 size-8" style={{ color: 'var(--cr-text-tertiary)' }} />
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
                      // Constant motion, so linear is correct (not ease-out).
                      // Animates transform, never width, so it never
                      // triggers layout on a value that changes many times
                      // a second.
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full origin-left rounded-full bg-primary transition-transform duration-150 ease-linear"
                          style={{ transform: `scaleX(${f.progress / 100})` }}
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
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" onClick={() => removeFile(f.key)}>
                              <X />
                              <span className="sr-only">Remove</span>
                            </Button>
                          }
                        />
                        <TooltipContent>Remove from this list</TooltipContent>
                      </Tooltip>
                    </>
                  ) : (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground" onClick={() => removeFile(f.key)}>
                            <X />
                            <span className="sr-only">Remove</span>
                          </Button>
                        }
                      />
                      <TooltipContent>Remove from this list</TooltipContent>
                    </Tooltip>
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

        <div className="mt-10 mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display uppercase" style={{ fontSize: 'var(--cr-type-h2)', fontWeight: 'var(--cr-weight-heavy)' }}>
              Past Meetings
            </h2>
            {usageSummary && usageSummary.count > 0 && (
              <MetaLine className="mt-1">
                This month: {usageSummary.minutes} min transcribed &middot;{' '}
                <span style={{ color: 'var(--cr-text-tertiary)' }}>~{formatCost(usageSummary.costUsd)}</span> estimated
              </MetaLine>
            )}
          </div>
          <div className="relative w-full sm:w-56">
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
            {/* Skeletons mirror the real row grid (checkbox, title, two mono
                meta lines) rather than generic slabs, so the loading state
                reads as "this list, arriving" not "something unrelated". */}
            {[0, 1].map((i) => (
              <div key={i} className="flex items-center gap-4 px-4 py-4" style={{ borderBottom: '1px solid var(--cr-rule-soft)' }}>
                <Skeleton className="size-4 shrink-0 rounded-[4px]" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="mb-2 h-4 w-48" />
                  <Skeleton className="h-3 w-72" />
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <Skeleton className="h-4 w-20 rounded-full" />
                  <Skeleton className="h-3 w-28" />
                </div>
              </div>
            ))}
          </div>
        )}

        {selectedIds.size > 0 && (
          // Neutral raised surface, not yellow. Highlighter yellow on this
          // screen is reserved for the search <mark> and the Transcribing
          // status, nothing else.
          <div
            className="mb-2 flex items-center justify-between gap-3 rounded-[var(--cr-radius-md)] px-3 py-2 text-sm"
            style={{ background: 'var(--cr-ink-raised)', border: '1px solid var(--cr-rule-soft)' }}
          >
            <span className="font-mono" style={{ fontSize: 'var(--cr-type-sm)' }}>{selectedIds.size} selected</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={openBulkTagDialog}>
                <Tag /> Add tag
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setPendingDeleteIds(Array.from(selectedIds))}>
                <Trash2 /> Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={clearSelection}>Clear</Button>
            </div>
          </div>
        )}

        {!searching && meetings.length > 0 && (
          <div className="flex flex-col gap-2">
            {meetings.map((meeting) => (
              <Card
                key={meeting.id}
                className="cursor-pointer shadow-none transition-colors duration-[var(--cr-dur-hover)] ease-[var(--cr-ease-out)] hover:border-primary/50"
                onClick={() => {
                  const q = searchQuery.trim();
                  router.push(q ? `/meeting/${meeting.id}?q=${encodeURIComponent(q)}` : `/meeting/${meeting.id}`);
                }}
              >
                <CardContent className="flex items-center gap-4">
                  <Checkbox
                    checked={selectedIds.has(meeting.id)}
                    onClick={(e) => e.stopPropagation()}
                    onCheckedChange={() => toggleSelect(meeting.id)}
                    aria-label={`Select ${meeting.title}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{meeting.title}</div>
                    <MetaLine className="mt-0.5">
                      {[
                        meeting.isVideo ? 'Video' : 'Audio',
                        formatDuration(meeting.durationSeconds),
                        formatDate(meeting.createdAt)
                      ].filter(Boolean).join(' · ')}
                    </MetaLine>
                    {meeting.status === 'processing' ? (
                      <div className="mt-1.5">
                        <StatusPill status="processing" />
                      </div>
                    ) : meeting.status === 'failed' ? (
                      <div className="mt-1.5 flex items-center gap-1.5 truncate">
                        <StatusPill status="failed" />
                        <span className="truncate text-sm" style={{ color: 'var(--cr-danger)' }}>
                          {meeting.errorMessage || 'Transcription failed.'}
                        </span>
                      </div>
                    ) : (
                      <div className="mt-1 truncate text-sm text-muted-foreground">{highlightText(meeting.preview, searchQuery)}</div>
                    )}
                    {meeting.tags?.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {meeting.tags.map((tag) => (
                          <Badge key={tag} variant="secondary">{tag}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                  {meeting.status === 'processing' && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0 text-muted-foreground hover:text-destructive"
                            disabled={actioningIds.has(meeting.id)}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleCancel(meeting.id);
                            }}
                          >
                            <X />
                            <span className="sr-only">Cancel</span>
                          </Button>
                        }
                      />
                      <TooltipContent>Cancel transcription</TooltipContent>
                    </Tooltip>
                  )}
                  {meeting.status === 'failed' && (
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="shrink-0 text-muted-foreground hover:text-foreground"
                            disabled={actioningIds.has(meeting.id)}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRetry(meeting.id);
                            }}
                          >
                            <RotateCw />
                            <span className="sr-only">Retry</span>
                          </Button>
                        }
                      />
                      <TooltipContent>Retry transcription</TooltipContent>
                    </Tooltip>
                  )}
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="shrink-0 text-muted-foreground hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            setPendingDeleteIds([meeting.id]);
                          }}
                        >
                          <Trash2 />
                          <span className="sr-only">Delete</span>
                        </Button>
                      }
                    />
                    <TooltipContent>Delete meeting</TooltipContent>
                  </Tooltip>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {showEmptyState && (
          <Empty className="py-14" style={{ border: '1px dashed var(--cr-rule-soft)', borderRadius: 'var(--cr-radius-xl)' }}>
            <EmptyHeader>
              <EmptyTitle>No meetings yet</EmptyTitle>
              <EmptyDescription>Upload a recording above to get your first transcript.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {showNoResultsState && (
          <Empty className="py-14" style={{ border: '1px dashed var(--cr-rule-soft)', borderRadius: 'var(--cr-radius-xl)' }}>
            <EmptyHeader>
              <EmptyTitle>Nothing matches &ldquo;{searchQuery.trim()}&rdquo;</EmptyTitle>
              <EmptyDescription>Try a different word, or check a tag you may have misspelled.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
      </main>

      <Dialog open={pendingDeleteIds !== null} onOpenChange={(open) => !open && setPendingDeleteIds(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {(pendingDeleteIds?.length || 0) > 1 ? `Delete ${pendingDeleteIds.length} meetings?` : 'Delete this meeting?'}
            </DialogTitle>
            <DialogDescription>This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" onClick={confirmDelete}>Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkTagOpen} onOpenChange={setBulkTagOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add tag to {selectedIds.size} meeting{selectedIds.size === 1 ? '' : 's'}</DialogTitle>
          </DialogHeader>
          <Input
            value={bulkTagValue}
            onChange={(e) => setBulkTagValue(e.target.value)}
            placeholder="Tag name"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleBulkAddTag();
              }
            }}
          />
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={handleBulkAddTag} disabled={bulkTagSaving || !bulkTagValue.trim()}>
              {bulkTagSaving && <Loader2 className="animate-spin" />}
              Add
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
