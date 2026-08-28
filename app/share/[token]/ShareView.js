'use client';

import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';

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

  const metaParts = [
    meeting.originalName,
    meeting.isVideo ? 'video → audio extracted' : 'audio file',
    meeting.durationSeconds ? `${formatTime(meeting.durationSeconds)} duration` : null,
    `${wordCount} words`,
    speakerCount ? `${speakerCount} speaker${speakerCount > 1 ? 's' : ''}` : null
  ].filter(Boolean);

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
      <h1 className="font-display mb-5 break-words uppercase" style={{ fontSize: 'var(--cr-type-h1)', fontWeight: 'var(--cr-weight-heavy)' }}>
        {meeting.title}
      </h1>

      {/* The paper transcript-as-hero treatment from the landing page, the
          same object this product's whole identity is built around. A
          shared read-only link is exactly the moment that motif belongs. */}
      <div
        className="cr-paper-scope overflow-hidden rounded-[var(--cr-radius-card)]"
        style={{ background: 'var(--cr-paper)', color: 'var(--cr-text-on-paper)', boxShadow: 'var(--cr-shadow-sheet)' }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5" style={{ borderBottom: '1px solid var(--cr-paper-rule)' }}>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="bg-[var(--cr-paper-dim)]">
              <TabsTrigger value="speakers">Transcript</TabsTrigger>
              <TabsTrigger value="plain">Plain Text</TabsTrigger>
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleCopy} style={{ borderColor: 'var(--cr-paper-rule)' }}>
              <Copy /> Copy
            </Button>
            <Select value={format} onValueChange={setFormat}>
              <SelectTrigger size="sm" className="w-20" style={{ borderColor: 'var(--cr-paper-rule)' }}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="txt">.txt</SelectItem>
                <SelectItem value="srt">.srt</SelectItem>
                <SelectItem value="vtt">.vtt</SelectItem>
              </SelectContent>
            </Select>
            <Button variant="outline" size="sm" onClick={handleDownload} style={{ borderColor: 'var(--cr-paper-rule)' }}>
              <Download /> Download
            </Button>
          </div>
        </div>

        <div className="font-mono px-5 pt-3" style={{ fontSize: 'var(--cr-type-meta)', color: 'var(--cr-text-paper-mut)' }}>
          {metaParts.join(' · ')}
        </div>

        <div className="px-5 pt-4 pb-5">
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsContent value="speakers">
              <ScrollArea className="h-[55vh]">
                {currentGroups.length ? (
                  <div className="flex flex-col gap-0 pr-3">
                    {currentGroups.map((g, i, arr) => (
                      <div
                        key={i}
                        className="flex gap-[var(--cr-space-3)] font-mono"
                        style={{
                          fontSize: 'var(--cr-type-sm)',
                          lineHeight: 'var(--cr-leading-mono)',
                          padding: '9px 0',
                          borderBottom: i < arr.length - 1 ? '1px dashed var(--cr-paper-rule)' : 'none'
                        }}
                      >
                        <span
                          className="h-fit shrink-0 font-semibold"
                          style={{ background: 'var(--cr-text-on-paper)', color: 'var(--cr-paper)', fontSize: 10.5, padding: '2px 7px', borderRadius: 4 }}
                        >
                          {speakerLabel(g.speaker)}
                        </span>
                        <span className="shrink-0" style={{ color: 'var(--cr-text-paper-mut)' }}>{formatTime(g.start)}</span>
                        <span>{g.transcript}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p style={{ color: 'var(--cr-text-paper-mut)', fontSize: 'var(--cr-type-sm)' }}>No speaker segments returned.</p>
                )}
              </ScrollArea>
            </TabsContent>
            <TabsContent value="plain">
              <ScrollArea className="h-[55vh]">
                <pre className="font-mono pr-3 whitespace-pre-wrap" style={{ fontSize: 'var(--cr-type-sm)', lineHeight: 1.7 }}>{lastTranscript}</pre>
              </ScrollArea>
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </>
  );
}
