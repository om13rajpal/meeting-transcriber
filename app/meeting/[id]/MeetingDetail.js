'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Copy, Download, Share2, Trash2, Link2, X, Loader2, AlertCircle, Users } from 'lucide-react';
import {
  getMeeting,
  updateMeetingTitle,
  updateSpeakerName,
  mergeSpeakers,
  deleteMeeting,
  createShareLink,
  revokeShareLink
} from '@/app/actions/meetings';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose
} from '@/components/ui/dialog';

const SPEAKER_COLORS = ['text-sky-400', 'text-emerald-400', 'text-amber-400', 'text-pink-400', 'text-violet-400', 'text-cyan-400'];

function formatTime(sec) {
  if (sec == null) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function groupUtterances(utterances) {
  const groups = [];
  utterances.forEach((u) => {
    const last = groups[groups.length - 1];
    if (last && last.speaker === u.speaker) {
      last.transcript += ` ${u.transcript}`;
      last.end = u.end;
    } else {
      groups.push({ speaker: u.speaker, start: u.start, end: u.end, transcript: u.transcript });
    }
  });
  return groups;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function srtTimestamp(sec) {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)},${String(ms).padStart(3, '0')}`;
}

function vttTimestamp(sec) {
  return srtTimestamp(sec).replace(',', '.');
}

export default function MeetingDetail({ id, initialMeeting, knownSpeakerNames = [] }) {
  const router = useRouter();
  const titleRef = useRef(null);

  const [meeting, setMeeting] = useState(initialMeeting);
  const [activeTab, setActiveTab] = useState('speakers');
  const [format, setFormat] = useState('txt');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTarget, setMergeTarget] = useState(null);
  const [mergeSources, setMergeSources] = useState(new Set());
  const [merging, setMerging] = useState(false);

  // The backend responds before transcription finishes, so a freshly
  // uploaded meeting (or one still processing on reload, since status lives
  // in the database) needs to poll until the job resolves.
  useEffect(() => {
    if (meeting.status !== 'processing') return undefined;

    const interval = window.setInterval(async () => {
      const result = await getMeeting(id);
      if (result.meeting) {
        setMeeting(result.meeting);
        if (result.meeting.status === 'complete') toast.success('Transcription finished.');
        else if (result.meeting.status === 'failed') {
          toast.error(`Transcription failed: ${result.meeting.errorMessage || 'unknown error'}`);
        }
      }
    }, 4000);

    return () => window.clearInterval(interval);
  }, [id, meeting.status]);

  const lastTranscript = meeting.transcript || '(no speech detected)';
  const speakerNames = meeting.speakerNames || {};
  const currentGroups = useMemo(() => groupUtterances(meeting.utterances || []), [meeting.utterances]);
  const speakerIds = useMemo(
    () => Array.from(new Set(currentGroups.map((g) => g.speaker))).sort((a, b) => a - b),
    [currentGroups]
  );
  const speakerCount = speakerIds.length;
  const wordCount = lastTranscript.trim() ? lastTranscript.trim().split(/\s+/).length : 0;

  const speakerLabel = (speakerId) => speakerNames[speakerId] || `Speaker ${speakerId + 1}`;

  const metaLine = [
    meeting.originalName,
    meeting.isVideo ? 'video → audio extracted' : 'audio file',
    meeting.durationSeconds ? `${formatTime(meeting.durationSeconds)} duration` : null,
    `${wordCount} words`,
    speakerCount ? `${speakerCount} speaker${speakerCount > 1 ? 's' : ''}` : null
  ].filter(Boolean).join(' · ');

  async function commitTitle() {
    const trimmed = (titleRef.current?.textContent || '').replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed === meeting.title) {
      if (titleRef.current) titleRef.current.textContent = meeting.title;
      return;
    }

    const result = await updateMeetingTitle(id, trimmed);
    if (result.meeting) {
      setMeeting(result.meeting);
    } else if (titleRef.current) {
      titleRef.current.textContent = meeting.title;
      toast.error(result.error || 'Could not rename this meeting.');
    }
  }

  async function commitSpeakerName(speakerId, rawName) {
    const trimmed = rawName.replace(/\s+/g, ' ').trim();
    const value = trimmed && trimmed !== `Speaker ${speakerId + 1}` ? trimmed : '';
    const result = await updateSpeakerName(id, speakerId, value);
    if (result.meeting) {
      setMeeting(result.meeting);
    }
  }

  function selectAllTextIn(el) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function buildSpeakerText() {
    return currentGroups
      .map((g) => `${speakerLabel(g.speaker)} (${formatTime(g.start)}): ${g.transcript}`)
      .join('\n\n');
  }

  function getActiveText() {
    return activeTab === 'speakers' && currentGroups.length ? buildSpeakerText() : lastTranscript;
  }

  function subtitleCues() {
    const utterances = meeting.utterances || [];
    if (utterances.length) {
      return utterances.map((u) => ({
        start: u.start,
        end: u.end,
        text: `${speakerLabel(u.speaker)}: ${u.transcript}`
      }));
    }
    if (lastTranscript) {
      return [{ start: 0, end: meeting.durationSeconds || 1, text: lastTranscript }];
    }
    return [];
  }

  function buildSrt() {
    return subtitleCues()
      .map((c, i) => `${i + 1}\n${srtTimestamp(c.start)} --> ${srtTimestamp(c.end)}\n${c.text}`)
      .join('\n\n');
  }

  function buildVtt() {
    const cues = subtitleCues()
      .map((c) => `${vttTimestamp(c.start)} --> ${vttTimestamp(c.end)}\n${c.text}`)
      .join('\n\n');
    return `WEBVTT\n\n${cues}`;
  }

  function buildDownload(fmt) {
    const base = activeTab === 'speakers' ? 'transcript-by-speaker' : 'transcript';
    if (fmt === 'srt') return { content: buildSrt(), filename: `${base}.srt`, mime: 'text/plain' };
    if (fmt === 'vtt') return { content: buildVtt(), filename: `${base}.vtt`, mime: 'text/vtt' };
    return { content: getActiveText(), filename: `${base}.txt`, mime: 'text/plain' };
  }

  function handleCopy() {
    navigator.clipboard.writeText(getActiveText());
    toast.success('Copied to clipboard.');
  }

  function handleDownload() {
    const { content, filename, mime } = buildDownload(format);
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleShare() {
    const result = await createShareLink(id);
    if (result.shareToken) {
      setMeeting((prev) => ({ ...prev, shareToken: result.shareToken }));
    } else {
      toast.error(result.error || 'Could not create a share link.');
    }
  }

  function handleCopyShareLink() {
    const url = `${window.location.origin}/share/${meeting.shareToken}`;
    navigator.clipboard.writeText(url);
    toast.success('Share link copied.');
  }

  async function confirmRevokeShare() {
    setRevokeOpen(false);
    const result = await revokeShareLink(id);
    if (result.ok) {
      setMeeting((prev) => ({ ...prev, shareToken: null }));
      toast.success('Share link revoked.');
    } else {
      toast.error(result.error || 'Could not revoke the share link.');
    }
  }

  function openMergeDialog() {
    setMergeTarget(speakerIds[0] ?? null);
    setMergeSources(new Set());
    setMergeOpen(true);
  }

  function toggleMergeSource(speakerId) {
    setMergeSources((prev) => {
      const next = new Set(prev);
      if (next.has(speakerId)) next.delete(speakerId);
      else next.add(speakerId);
      return next;
    });
  }

  async function confirmMerge() {
    if (mergeTarget == null || mergeSources.size === 0) return;
    setMerging(true);
    const result = await mergeSpeakers(id, Array.from(mergeSources), mergeTarget);
    setMerging(false);
    if (result.meeting) {
      setMeeting(result.meeting);
      setMergeOpen(false);
      toast.success('Speakers merged.');
    } else {
      toast.error(result.error || 'Could not merge speakers.');
    }
  }

  async function confirmDelete() {
    setDeleteOpen(false);
    setDeleting(true);
    const result = await deleteMeeting(id);
    if (result.ok) {
      router.push('/');
    } else {
      setDeleting(false);
      toast.error(result.error || 'Could not delete this meeting.');
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <Button
        variant="ghost"
        size="sm"
        className="mb-4 -ml-2 text-muted-foreground"
        render={<a href="/" />}
        nativeButton={false}
      >
        &larr; Back to meetings
      </Button>

      <h1
        ref={titleRef}
        className="-ml-2 mb-5 cursor-text rounded-lg border border-transparent px-2 py-1 text-2xl font-bold break-words outline-none hover:border-border hover:bg-accent/40 focus:border-primary focus:bg-accent/40"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        title="Click to rename"
        onFocus={(e) => selectAllTextIn(e.target)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.target.blur();
          }
        }}
        onBlur={commitTitle}
      >
        {meeting.title}
      </h1>

      {meeting.status === 'processing' ? (
        <Card className="border-dashed py-14 text-center shadow-none">
          <CardContent className="flex flex-col items-center gap-3 text-muted-foreground">
            <Loader2 className="size-6 animate-spin" />
            <p>Transcribing&hellip; this can take a few minutes depending on the recording's length.</p>
            <p className="text-xs">This page updates automatically, no need to refresh.</p>
            <Button variant="destructive" size="sm" className="mt-2" onClick={() => setDeleteOpen(true)} disabled={deleting}>
              <Trash2 /> Cancel &amp; delete
            </Button>
          </CardContent>
        </Card>
      ) : meeting.status === 'failed' ? (
        <Card className="border-dashed py-14 text-center shadow-none">
          <CardContent className="flex flex-col items-center gap-3">
            <AlertCircle className="size-6 text-destructive" />
            <p className="text-destructive">{meeting.errorMessage || 'Transcription failed.'}</p>
            <p className="text-sm text-muted-foreground">Delete this and try uploading the recording again.</p>
            <Button variant="destructive" size="sm" className="mt-2" onClick={() => setDeleteOpen(true)} disabled={deleting}>
              <Trash2 /> Delete
            </Button>
          </CardContent>
        </Card>
      ) : (
      <Card className="gap-0 py-0 shadow-none">
        <CardHeader className="flex-row items-center justify-between gap-3 border-b bg-muted/30 px-4 py-3">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList>
              <TabsTrigger value="speakers">Transcript</TabsTrigger>
              <TabsTrigger value="plain">Plain Text</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleCopy}>
              <Copy /> Copy
            </Button>
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger size="sm" className="w-20">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="txt">.txt</SelectItem>
                <SelectItem value="srt">.srt</SelectItem>
                <SelectItem value="vtt">.vtt</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={handleDownload}>
              <Download /> Download
            </Button>
          </div>
        </CardHeader>

        <div className="flex items-center justify-between gap-3 px-4 pt-3">
          <p className="text-xs text-muted-foreground">{metaLine}</p>
          <div className="flex shrink-0 gap-2">
            {speakerCount > 1 && (
              <Button variant="outline" size="sm" onClick={openMergeDialog}>
                <Users /> Merge speakers
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={handleShare}>
              <Share2 /> Share
            </Button>
            <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} disabled={deleting}>
              <Trash2 /> Delete
            </Button>
          </div>
        </div>

        {meeting.shareToken && (
          <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border bg-muted/30 p-2.5">
            <Link2 className="ml-1 size-4 shrink-0 text-muted-foreground" />
            <Input
              readOnly
              className="h-8 flex-1 text-muted-foreground"
              value={typeof window !== 'undefined' ? `${window.location.origin}/share/${meeting.shareToken}` : ''}
            />
            <Button variant="outline" size="sm" onClick={handleCopyShareLink}>Copy link</Button>
            <Button variant="ghost" size="icon-sm" onClick={() => setRevokeOpen(true)}>
              <X />
              <span className="sr-only">Revoke</span>
            </Button>
          </div>
        )}

        <CardContent className="px-4 pt-4 pb-4">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsContent value="speakers">
              <ScrollArea className="h-[60vh]">
                {currentGroups.length ? (
                  <div className="flex flex-col gap-4 pr-3">
                    {currentGroups.map((g, i) => (
                      <SpeakerLine
                        key={i}
                        group={g}
                        label={speakerLabel(g.speaker)}
                        colorClass={SPEAKER_COLORS[g.speaker % SPEAKER_COLORS.length]}
                        onRename={(name) => commitSpeakerName(g.speaker, name)}
                        knownNamesListId="known-speaker-names"
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No speaker segments returned.</p>
                )}
              </ScrollArea>
              <datalist id="known-speaker-names">
                {knownSpeakerNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </TabsContent>
            <TabsContent value="plain">
              <ScrollArea className="h-[60vh]">
                <pre className="pr-3 text-[15px] leading-relaxed whitespace-pre-wrap">{lastTranscript}</pre>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      )}

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
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

      <Dialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke this share link?</DialogTitle>
            <DialogDescription>Anyone with the old link will lose access.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button variant="destructive" onClick={confirmRevokeShare}>Revoke</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={mergeOpen} onOpenChange={setMergeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Merge speakers</DialogTitle>
            <DialogDescription>
              If Deepgram split one person's voice into multiple speakers, merge them here. Choose which
              speaker to keep, then check the others to fold into it.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="merge-keep-as">Keep as</Label>
              <Select
                value={mergeTarget != null ? String(mergeTarget) : ''}
                onValueChange={(v) => {
                  const next = Number(v);
                  setMergeTarget(next);
                  setMergeSources((prev) => {
                    if (!prev.has(next)) return prev;
                    const copy = new Set(prev);
                    copy.delete(next);
                    return copy;
                  });
                }}
              >
                <SelectTrigger id="merge-keep-as" className="w-full">
                  <SelectValue>{(value) => (value != null ? speakerLabel(Number(value)) : '')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {speakerIds.map((sid) => (
                    <SelectItem key={sid} value={String(sid)}>{speakerLabel(sid)}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label>Merge into it</Label>
              {speakerIds.filter((sid) => sid !== mergeTarget).map((sid) => (
                <label key={sid} className="flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-accent/40">
                  <input
                    type="checkbox"
                    checked={mergeSources.has(sid)}
                    onChange={() => toggleMergeSource(sid)}
                    className="size-4 accent-primary"
                  />
                  {speakerLabel(sid)}
                </label>
              ))}
              {speakerIds.filter((sid) => sid !== mergeTarget).length === 0 && (
                <p className="text-sm text-muted-foreground">No other speakers to merge.</p>
              )}
            </div>
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
            <Button onClick={confirmMerge} disabled={merging || mergeSources.size === 0}>
              {merging && <Loader2 className="animate-spin" />}
              Merge
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function SpeakerLine({ group, label, colorClass, onRename, knownNamesListId }) {
  return (
    <div className="flex flex-wrap items-baseline gap-3.5">
      <span className={`inline-flex shrink-0 min-w-[90px] items-baseline gap-1.5 text-[13px] font-semibold ${colorClass}`}>
        <span className="self-center size-2 shrink-0 rounded-full bg-current" />
        <input
          key={label}
          defaultValue={label}
          list={knownNamesListId}
          className={`w-24 rounded border border-transparent bg-transparent px-1 -mx-1 text-[13px] font-semibold outline-none hover:border-border hover:bg-accent/40 focus:border-primary focus:bg-accent/40 ${colorClass}`}
          spellCheck={false}
          title="Click to rename this speaker (suggestions from names you've used before)"
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.target.blur();
            }
          }}
          onBlur={(e) => onRename(e.target.value)}
        />
        <span className="text-[11.5px] font-normal text-muted-foreground">{formatTime(group.start)}</span>
      </span>
      <span className="flex-1 basis-80 text-foreground">{group.transcript}</span>
    </div>
  );
}
