'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { UploadCloud, Search, Trash2, FileAudio, FileVideo, LogOut, Loader2, AlertCircle } from 'lucide-react';
import { logout } from '@/app/actions/auth';
import { createUploadToken } from '@/app/actions/transcribe';
import { deleteMeeting, markMeetingFailed } from '@/app/actions/meetings';
import { searchMeetings } from '@/app/actions/search';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
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
  // React throws a hydration mismatch.
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function formatElapsed(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function initialsFor(email) {
  return (email || '?').slice(0, 2).toUpperCase();
}

export default function Dashboard({ userEmail, initialMeetings }) {
  const router = useRouter();
  const fileInputRef = useRef(null);
  const searchDebounceRef = useRef(null);
  const statusTimerRef = useRef(null);

  const [meetings, setMeetings] = useState(initialMeetings);
  const [selectedFile, setSelectedFile] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState(null);
  const [, startLogoutTransition] = useTransition();

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

  // Warns before an accidental reload/close while the file is still being
  // sent to the backend. Nothing can make the raw byte transfer itself
  // resumable (the browser is what's streaming it), so the best available
  // protection is stopping the user from losing it by accident.
  useEffect(() => {
    if (!uploading) return undefined;

    function handleBeforeUnload(e) {
      e.preventDefault();
      e.returnValue = '';
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [uploading]);

  function selectFile(file) {
    if (!file) return;
    setSelectedFile(file);
  }

  function handleDrop(e) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) selectFile(file);
  }

  function resetSelection() {
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleTranscribe() {
    if (!selectedFile) return;

    setUploading(true);
    const start = Date.now();
    setElapsed(0);
    statusTimerRef.current = window.setInterval(() => {
      setElapsed(Date.now() - start);
    }, 1000);

    let meetingId = null;

    try {
      // Mints the token and creates the Meeting row (status 'processing')
      // immediately, before any bytes are sent - so it shows up below right
      // away and a reload during the raw transfer itself (which can take
      // real time for a large recording) leaves a durable row behind
      // instead of the job vanishing with no trace. The file itself then
      // goes straight from this browser to the transcription backend,
      // never through Vercel's serverless functions, which cap request
      // bodies at ~4.5MB.
      const tokenResult = await createUploadToken(selectedFile.name);
      if (tokenResult.error) {
        toast.error(tokenResult.error);
        return;
      }

      if (tokenResult.meeting) {
        meetingId = tokenResult.meeting.id;
        setMeetings((prev) => [tokenResult.meeting, ...prev]);
      }

      const formData = new FormData();
      formData.append('file', selectedFile);
      formData.append('token', tokenResult.token);

      const uploadResponse = await fetch(`${tokenResult.backendUrl}/api/transcribe`, {
        method: 'POST',
        body: formData
      });
      const result = await uploadResponse.json().catch(() => ({}));

      if (!uploadResponse.ok) {
        const message = result.error || 'Something went wrong. Please try again.';
        toast.error(message);
        // The upload itself failed, so the row this dashboard already added
        // would otherwise sit at 'processing' until the backend's 30-minute
        // stale-job sweep notices. Fail it now instead, since the browser
        // already knows.
        if (meetingId) await markMeetingFailed(meetingId, message);
        const refreshed = await searchMeetings(searchQuery);
        setMeetings(refreshed);
        return;
      }

      // The backend responds as soon as the job is created, before ffmpeg or
      // Deepgram have run - transcription continues in the background, so
      // the polling effect above picks it up from there. This also means
      // the upload step itself feels much faster, since the user isn't
      // stuck waiting for the whole pipeline before getting any feedback.
      resetSelection();
      toast.success('Upload received. Transcribing in the background.');
      const refreshed = await searchMeetings(searchQuery);
      setMeetings(refreshed);
    } catch (err) {
      toast.error('Something went wrong. Please try again.');
      if (meetingId) {
        await markMeetingFailed(meetingId, 'Something went wrong during upload. Please try again.');
        const refreshed = await searchMeetings(searchQuery);
        setMeetings(refreshed);
      }
    } finally {
      window.clearInterval(statusTimerRef.current);
      setUploading(false);
    }
  }

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

  const showEmptyState = !uploading && !searching && meetings.length === 0 && !searchQuery.trim();
  const showNoResultsState = !uploading && !searching && meetings.length === 0 && searchQuery.trim();

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

        {!selectedFile ? (
          <Card
            className={`cursor-pointer border-2 border-dashed py-14 text-center shadow-none transition-colors ${dragOver ? 'border-primary bg-accent/40' : 'border-border hover:border-primary/60'}`}
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
              <p className="font-medium">Drop your recording here</p>
              <p className="text-sm text-muted-foreground">MP4 or MP3 &middot; or click to browse</p>
            </CardContent>
          </Card>
        ) : (
          <Card className="shadow-none">
            <CardContent className="flex items-center gap-3">
              {selectedFile.type.startsWith('video') ? (
                <FileVideo className="size-5 shrink-0 text-muted-foreground" />
              ) : (
                <FileAudio className="size-5 shrink-0 text-muted-foreground" />
              )}
              <span className="flex-1 truncate text-sm">
                {selectedFile.name} <span className="text-muted-foreground">({formatBytes(selectedFile.size)})</span>
              </span>
              <Button variant="outline" size="sm" onClick={resetSelection} disabled={uploading}>
                Clear
              </Button>
              <Button size="sm" onClick={handleTranscribe} disabled={uploading}>
                {uploading && <Loader2 className="animate-spin" />}
                Transcribe
              </Button>
            </CardContent>
          </Card>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,video/*"
          hidden
          onChange={(e) => selectFile(e.target.files && e.target.files[0])}
        />

        {uploading && (
          <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Uploading &amp; transcribing&hellip; {formatElapsed(elapsed)}
          </p>
        )}

        <div className="mt-10 mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-muted-foreground">Past Meetings</h2>
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
    </div>
  );
}
