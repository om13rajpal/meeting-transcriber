'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Copy, Download, Share2, Trash2, X, Loader2, Users, Tag, Plus, Mail, Webhook as WebhookIcon } from 'lucide-react';
import {
  getMeeting,
  updateMeetingTitle,
  updateSpeakerName,
  mergeSpeakers,
  deleteMeeting,
  createShareLink,
  revokeShareLink,
  resendNotifications,
  updateMeetingTags
} from '@/app/actions/meetings';
import { highlightText } from '@/lib/utils';
import AppHeader from '@/components/brand/AppHeader';
import StatusPill from '@/components/brand/StatusPill';
import SpeakerTag from '@/components/brand/SpeakerTag';
import TimeRail from '@/components/brand/TimeRail';
import MetaLine from '@/components/brand/MetaLine';
import NotificationBadges from '@/components/brand/NotificationBadges';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
  PopoverHeader,
  PopoverTitle,
  PopoverDescription
} from '@/components/ui/popover';
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

const MODEL_LABELS = { 'nova-3': 'Nova-3' };
const NOTIFICATION_FORMAT_LABELS = { generic: 'Generic JSON', discord: 'Discord', slack: 'Slack', teams: 'Microsoft Teams' };

function formatCost(costUsd) {
  if (typeof costUsd !== 'number') return null;
  return `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`;
}

export default function MeetingDetail({ id, userEmail, avatarUrl, initialMeeting, knownSpeakerNames = [], initialQuery = '' }) {
  const router = useRouter();
  const titleRef = useRef(null);
  const groupRefs = useRef({});
  const hasJumpedRef = useRef(false);

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
  const [resending, setResending] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [tagSaving, setTagSaving] = useState(false);

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

  // Landed here from a dashboard search (?q=... - see Dashboard.js's row
  // click handler): jump straight to the first matching line instead of
  // making the user re-find it in a long transcript. Only runs once per
  // page load (hasJumpedRef), and waits for currentGroups to actually have
  // content, since a freshly-uploaded meeting starts with none while still
  // 'processing'. Declared after currentGroups on purpose - it reads that
  // memo, so declaring it earlier is a temporal-dead-zone crash.
  useEffect(() => {
    if (!initialQuery || hasJumpedRef.current || !currentGroups.length) return;

    const lowerQuery = initialQuery.toLowerCase();
    const matchIndex = currentGroups.findIndex((g) => g.transcript.toLowerCase().includes(lowerQuery));
    if (matchIndex === -1) return;

    hasJumpedRef.current = true;
    setActiveTab('speakers');
    requestAnimationFrame(() => {
      groupRefs.current[matchIndex]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [initialQuery, currentGroups]);

  const speakerLabel = (speakerId) => speakerNames[speakerId] || `Speaker ${speakerId + 1}`;

  const metaParts = [
    meeting.originalName,
    meeting.isVideo ? 'video → audio extracted' : 'audio file',
    meeting.durationSeconds ? `${formatTime(meeting.durationSeconds)} duration` : null,
    `${wordCount} words`,
    speakerCount ? `${speakerCount} speaker${speakerCount > 1 ? 's' : ''}` : null,
    meeting.deepgramModel ? MODEL_LABELS[meeting.deepgramModel] || meeting.deepgramModel : null,
    formatCost(meeting.deepgramCostUsd)
      ? `${formatCost(meeting.deepgramCostUsd)}${meeting.deepgramCostExact ? '' : ' estimated'}`
      : null
  ].filter(Boolean);

  // One flat list of { icon, label, attemptedAt, ok } regardless of channel,
  // so NotificationBadges never has to know email and webhooks are shaped
  // differently server-side.
  const notificationItems = meeting.notifications
    ? [
        ...(meeting.notifications.email
          ? [{ icon: Mail, label: 'Email', attemptedAt: meeting.notifications.email.attemptedAt, ok: meeting.notifications.email.ok }]
          : []),
        ...(meeting.notifications.webhooks || []).map((w) => ({
          icon: WebhookIcon,
          label: NOTIFICATION_FORMAT_LABELS[w.format] || w.format,
          attemptedAt: w.attemptedAt,
          ok: w.ok
        }))
      ]
    : [];

  const shareUrl = typeof window !== 'undefined' && meeting.shareToken ? `${window.location.origin}/share/${meeting.shareToken}` : '';

  async function commitTags(nextTags) {
    setTagSaving(true);
    try {
      const result = await updateMeetingTags(id, nextTags);
      if (result.meeting) {
        setMeeting(result.meeting);
      } else {
        toast.error(result.error || 'Could not update tags.');
      }
    } finally {
      setTagSaving(false);
    }
  }

  function handleAddTag(e) {
    e.preventDefault();
    const trimmed = tagInput.trim();
    setTagInput('');
    if (!trimmed || (meeting.tags || []).includes(trimmed)) return;
    commitTags([...(meeting.tags || []), trimmed]);
  }

  function handleRemoveTag(tag) {
    commitTags((meeting.tags || []).filter((t) => t !== tag));
  }

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

  async function handleResendNotifications() {
    setResending(true);
    try {
      const result = await resendNotifications(id);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setMeeting(result.meeting);
      toast.success('Notifications resent.');
    } finally {
      setResending(false);
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
    <div className="min-h-screen" style={{ background: 'var(--cr-ink-app)' }}>
      <AppHeader
        userEmail={userEmail}
        avatarUrl={avatarUrl}
        left={
          <>
            <span style={{ color: 'var(--cr-rule-strong)' }}>/</span>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              render={<a href="/" />}
              nativeButton={false}
            >
              &larr; Back to meetings
            </Button>
          </>
        }
      />

      <main className="mx-auto px-6 py-8" style={{ maxWidth: 'var(--cr-measure-app)' }}>
        {/* Not uppercase, and a size ceiling well under --cr-type-h2: unlike
            "Past Meetings" (copy this app controls), this title is often a
            raw, unrenamed filename, underscores, extension and all. Shouting
            an arbitrary filename in 30px uppercase display type reads as
            broken, not bold. Big Shoulders still carries the page-title
            weight in mixed case, it just stops fighting the content. */}
        <h1
          ref={titleRef}
          className="font-display -ml-2 mb-5 cursor-text rounded-[var(--cr-radius-md)] border border-transparent px-2 py-1 break-words outline-none transition-colors duration-[var(--cr-dur-hover)] ease-[var(--cr-ease-out)] hover:border-[var(--cr-rule-soft)] hover:bg-[var(--cr-ink-raised)] focus:border-primary focus:bg-[var(--cr-ink-raised)] focus-visible:ring-2 focus-visible:ring-ring/50"
          style={{ fontSize: 'clamp(19px, 2.4vw, 25px)', fontWeight: 'var(--cr-weight-heavy)', lineHeight: 1.25 }}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          role="textbox"
          aria-multiline="false"
          aria-label="Meeting title"
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
            <CardContent className="flex flex-col items-center gap-3">
              <StatusPill status="processing" />
              <p className="text-muted-foreground">
                Transcribing&hellip; this can take a few minutes depending on the recording&apos;s length.
              </p>
              <p className="text-xs text-muted-foreground">This page updates automatically, no need to refresh.</p>
              <Button variant="destructive" size="sm" className="mt-2" onClick={() => setDeleteOpen(true)} disabled={deleting}>
                <Trash2 /> Cancel &amp; delete
              </Button>
            </CardContent>
          </Card>
        ) : meeting.status === 'failed' ? (
          <Card className="border-dashed py-14 text-center shadow-none">
            <CardContent className="flex flex-col items-center gap-3">
              <StatusPill status="failed" />
              <p style={{ color: 'var(--cr-danger)' }}>{meeting.errorMessage || 'Transcription failed.'}</p>
              <p className="text-sm text-muted-foreground">Delete this and try uploading the recording again.</p>
              <NotificationBadges items={notificationItems} onResend={handleResendNotifications} resending={resending} />
              <Button variant="destructive" size="sm" className="mt-2" onClick={() => setDeleteOpen(true)} disabled={deleting}>
                <Trash2 /> Delete
              </Button>
            </CardContent>
          </Card>
        ) : (
        <Card className="gap-0 py-0 shadow-none">
          <CardHeader className="flex-row items-center justify-between gap-3 border-b px-4 py-3" style={{ background: 'var(--cr-ink-raised)' }}>
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

          {/* One toolbar row: everything here is either an action (button),
              a status (badge, detail on hover), or a destination (the share
              popover, anchored to its own trigger so it never pushes the
              transcript down). Nothing here gets its own orphaned row. */}
          <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-3">
            <MetaLine className="pt-1.5">{metaParts.join(' · ')}</MetaLine>
            <div className="flex shrink-0 items-center gap-2">
              <NotificationBadges items={notificationItems} onResend={handleResendNotifications} resending={resending} />
              {speakerCount > 1 && (
                <Button variant="outline" size="sm" onClick={openMergeDialog}>
                  <Users /> Merge speakers
                </Button>
              )}
              <Popover>
                <PopoverTrigger
                  render={
                    <Button variant="outline" size="sm">
                      <Share2 /> Share
                    </Button>
                  }
                />
                <PopoverContent align="end" className="w-80 gap-3">
                  {meeting.shareToken ? (
                    <>
                      <PopoverHeader>
                        <PopoverTitle>Share link</PopoverTitle>
                        <PopoverDescription>Anyone with this link can view a read-only transcript, no account needed.</PopoverDescription>
                      </PopoverHeader>
                      <div className="flex items-center gap-2">
                        <Input readOnly className="h-8 flex-1 font-mono text-xs" value={shareUrl} />
                        <Button variant="outline" size="sm" onClick={handleCopyShareLink}>Copy</Button>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="self-start text-muted-foreground hover:text-destructive"
                        onClick={() => setRevokeOpen(true)}
                      >
                        Revoke link
                      </Button>
                    </>
                  ) : (
                    <>
                      <PopoverHeader>
                        <PopoverTitle>Share this meeting</PopoverTitle>
                        <PopoverDescription>Creates a public, read-only link to the transcript. Anyone with it can view it.</PopoverDescription>
                      </PopoverHeader>
                      <Button size="sm" className="self-start" onClick={handleShare}>Create share link</Button>
                    </>
                  )}
                </PopoverContent>
              </Popover>
              <Button variant="destructive" size="sm" onClick={() => setDeleteOpen(true)} disabled={deleting}>
                <Trash2 /> Delete
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 px-4 pt-3">
            <Tag className="size-3.5 shrink-0 text-muted-foreground" />
            {(meeting.tags || []).map((tag) => (
              <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                {tag}
                <button
                  type="button"
                  onClick={() => handleRemoveTag(tag)}
                  disabled={tagSaving}
                  className="rounded-full p-0.5 transition-transform duration-[var(--cr-dur-press)] ease-[var(--cr-ease-out)] hover:bg-black/10 active:scale-[var(--cr-press-scale)] dark:hover:bg-white/10"
                >
                  <X className="size-2.5" />
                  <span className="sr-only">Remove tag</span>
                </button>
              </Badge>
            ))}
            <form onSubmit={handleAddTag} className="inline-flex items-center">
              <Input
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder="Add tag"
                disabled={tagSaving}
                className="h-6 w-24 border-none bg-transparent px-1.5 text-xs shadow-none focus-visible:ring-0"
              />
              {tagInput.trim() && (
                <Button type="submit" variant="ghost" size="icon-sm" className="size-6" disabled={tagSaving}>
                  <Plus className="size-3.5" />
                  <span className="sr-only">Add tag</span>
                </Button>
              )}
            </form>
          </div>

          <CardContent className="px-4 pt-4 pb-4">
            <Tabs value={activeTab} onValueChange={setActiveTab}>
              <TabsContent value="speakers">
                <ScrollArea className="h-[60vh]">
                  {currentGroups.length ? (
                    <div className="flex flex-col gap-3.5 pr-3">
                      {currentGroups.map((g, i) => (
                        <div key={i} ref={(el) => { groupRefs.current[i] = el; }}>
                          <SpeakerLine
                            group={g}
                            label={speakerLabel(g.speaker)}
                            variant={!speakerNames[g.speaker] ? 'unnamed' : g.speaker === 0 ? 'self' : 'default'}
                            onRename={(name) => commitSpeakerName(g.speaker, name)}
                            knownNamesListId="known-speaker-names"
                            highlightQuery={initialQuery}
                          />
                        </div>
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
                  <pre className="pr-3 font-mono text-[13px] leading-relaxed whitespace-pre-wrap">{highlightText(lastTranscript, initialQuery)}</pre>
                </ScrollArea>
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
        )}
      </main>

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
              If Deepgram split one person&apos;s voice into multiple speakers, merge them here. Choose which
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
                <label
                  key={sid}
                  className="flex cursor-pointer items-center gap-2 rounded-[var(--cr-radius-md)] border px-3 py-2 text-sm transition-colors duration-[var(--cr-dur-hover)] ease-[var(--cr-ease-out)] hover:bg-[var(--cr-ink-hover)]"
                >
                  <Checkbox checked={mergeSources.has(sid)} onCheckedChange={() => toggleMergeSource(sid)} />
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
              Merge{mergeSources.size > 0 ? ` ${mergeSources.size} speaker${mergeSources.size > 1 ? 's' : ''}` : ''}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SpeakerLine({ group, label, variant, onRename, knownNamesListId, highlightQuery }) {
  return (
    <div className="flex gap-[var(--cr-space-3)]">
      <TimeRail>{formatTime(group.start)}</TimeRail>
      <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <SpeakerTag variant={variant}>
          <input
            key={label}
            defaultValue={label}
            list={knownNamesListId}
            className="w-24 bg-transparent uppercase outline-none"
            style={{ fontFamily: 'inherit', fontSize: 'inherit', fontWeight: 'inherit', letterSpacing: 'inherit' }}
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
        </SpeakerTag>
        <span className="flex-1 basis-80 text-[15px] text-foreground">{highlightText(group.transcript, highlightQuery)}</span>
      </div>
    </div>
  );
}
