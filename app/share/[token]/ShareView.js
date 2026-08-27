'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';

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

export default function ShareView({ meeting }) {
  const [activeTab, setActiveTab] = useState('speakers');
  const [format, setFormat] = useState('txt');

  const lastTranscript = meeting.transcript || '(no speech detected)';
  const speakerNames = meeting.speakerNames || {};
  const currentGroups = useMemo(() => groupUtterances(meeting.utterances || []), [meeting.utterances]);
  const speakerCount = useMemo(() => new Set(currentGroups.map((g) => g.speaker)).size, [currentGroups]);
  const wordCount = lastTranscript.trim() ? lastTranscript.trim().split(/\s+/).length : 0;

  const speakerLabel = (speakerId) => speakerNames[speakerId] || `Speaker ${speakerId + 1}`;

  const metaLine = [
    meeting.originalName,
    meeting.isVideo ? 'video → audio extracted' : 'audio file',
    meeting.durationSeconds ? `${formatTime(meeting.durationSeconds)} duration` : null,
    `${wordCount} words`,
    speakerCount ? `${speakerCount} speaker${speakerCount > 1 ? 's' : ''}` : null
  ].filter(Boolean).join(' · ');

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

  return (
    <>
      <h1 className="mb-5 text-2xl font-bold break-words">{meeting.title}</h1>

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

        <p className="px-4 pt-3 text-xs text-muted-foreground">{metaLine}</p>

        <CardContent className="px-4 pt-4 pb-4">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsContent value="speakers">
              <ScrollArea className="h-[60vh]">
                {currentGroups.length ? (
                  <div className="flex flex-col gap-4 pr-3">
                    {currentGroups.map((g, i) => (
                      <div className="flex flex-wrap items-baseline gap-3.5" key={i}>
                        <span className={`inline-flex shrink-0 min-w-[90px] items-baseline gap-1.5 text-[13px] font-semibold ${SPEAKER_COLORS[g.speaker % SPEAKER_COLORS.length]}`}>
                          <span className="self-center size-2 shrink-0 rounded-full bg-current" />
                          <span>{speakerLabel(g.speaker)}</span>
                          <span className="text-[11.5px] font-normal text-muted-foreground">{formatTime(g.start)}</span>
                        </span>
                        <span className="flex-1 basis-80 text-foreground">{g.transcript}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No speaker segments returned.</p>
                )}
              </ScrollArea>
            </TabsContent>
            <TabsContent value="plain">
              <ScrollArea className="h-[60vh]">
                <pre className="pr-3 text-[15px] leading-relaxed whitespace-pre-wrap">{lastTranscript}</pre>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </>
  );
}
