// Public, read-only view of a shared meeting: loaded by the unguessable
// share token in the URL, no auth, no editing (no PATCH exposed here).

const meetingTitleEl = document.getElementById('meetingTitle');
const notFoundBox = document.getElementById('notFoundBox');
const notFoundText = document.getElementById('notFoundText');
const resultBox = document.getElementById('resultBox');
const metaEl = document.getElementById('meta');
const plainView = document.getElementById('plainView');
const speakerView = document.getElementById('speakerView');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const formatSelect = document.getElementById('formatSelect');
const tabs = document.querySelectorAll('.tab');

let lastTranscript = '';
let activeTabName = 'speakers';
let speakerNames = {};
let currentGroups = [];
let currentUtterances = [];
let currentDuration = 0;

const SPEAKER_COLORS = 6;

function pathShareToken() {
  const match = window.location.pathname.match(/^\/share\/([^/]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

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

function speakerLabel(id) {
  return speakerNames[id] || `Speaker ${id + 1}`;
}

function showNotFound(message) {
  notFoundText.textContent = message;
  notFoundBox.classList.remove('hidden');
  resultBox.classList.add('hidden');
  meetingTitleEl.classList.add('hidden');
}

function applyMeeting(meeting) {
  lastTranscript = meeting.transcript || '(no speech detected)';
  speakerNames = meeting.speakerNames || {};
  currentUtterances = meeting.utterances || [];
  currentDuration = meeting.durationSeconds || 0;
  currentGroups = groupUtterances(currentUtterances);

  plainView.textContent = lastTranscript;
  meetingTitleEl.textContent = meeting.title || meeting.originalName || 'Untitled recording';
  meetingTitleEl.classList.remove('hidden');

  const durationText = meeting.durationSeconds ? `${formatTime(meeting.durationSeconds)} duration` : '';
  const wordCount = lastTranscript.trim() ? lastTranscript.trim().split(/\s+/).length : 0;
  const speakerCount = new Set(currentGroups.map((g) => g.speaker)).size;

  metaEl.textContent = [
    meeting.originalName,
    meeting.isVideo ? 'video → audio extracted' : 'audio file',
    durationText,
    `${wordCount} words`,
    speakerCount ? `${speakerCount} speaker${speakerCount > 1 ? 's' : ''}` : null
  ].filter(Boolean).join(' · ');

  renderSpeakerView();
  resultBox.classList.remove('hidden');
  notFoundBox.classList.add('hidden');
}

async function loadMeeting() {
  const token = pathShareToken();
  if (!token) {
    showNotFound('This link is invalid or has been revoked.');
    return;
  }

  try {
    const resp = await fetch(`/api/share/${encodeURIComponent(token)}`);
    if (!resp.ok) {
      showNotFound('This link is invalid or has been revoked.');
      return;
    }
    const data = await resp.json();
    applyMeeting(data.meeting);
  } catch (err) {
    showNotFound('Something went wrong loading this meeting.');
  }
}

function renderSpeakerView() {
  speakerView.innerHTML = '';

  if (!currentGroups.length) {
    speakerView.textContent = 'No speaker segments returned.';
    return;
  }

  currentGroups.forEach((g) => {
    const row = document.createElement('div');
    row.className = 'speaker-line';

    const tag = document.createElement('span');
    tag.className = `speaker-tag speaker-color-${g.speaker % SPEAKER_COLORS}`;

    const dot = document.createElement('span');
    dot.className = 'speaker-dot';

    const nameEl = document.createElement('span');
    nameEl.className = 'speaker-name';
    nameEl.textContent = speakerLabel(g.speaker);

    const time = document.createElement('span');
    time.className = 'speaker-time';
    time.textContent = formatTime(g.start);

    tag.append(dot, nameEl, time);

    const textEl = document.createElement('span');
    textEl.className = 'speaker-text';
    textEl.textContent = g.transcript;

    row.append(tag, textEl);
    speakerView.appendChild(row);
  });
}

function buildSpeakerText() {
  return currentGroups
    .map((g) => `${speakerLabel(g.speaker)} (${formatTime(g.start)}): ${g.transcript}`)
    .join('\n\n');
}

function getActiveText() {
  return activeTabName === 'speakers' && currentGroups.length ? buildSpeakerText() : lastTranscript;
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    activeTabName = tab.dataset.tab;
    plainView.classList.toggle('hidden', activeTabName !== 'plain');
    speakerView.classList.toggle('hidden', activeTabName !== 'speakers');
  });
});

copyBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(getActiveText());
  copyBtn.textContent = 'Copied!';
  setTimeout(() => (copyBtn.textContent = 'Copy'), 1200);
});

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

function subtitleCues() {
  if (currentUtterances.length) {
    return currentUtterances.map((u) => ({
      start: u.start,
      end: u.end,
      text: `${speakerLabel(u.speaker)}: ${u.transcript}`
    }));
  }
  if (lastTranscript) {
    return [{ start: 0, end: currentDuration || 1, text: lastTranscript }];
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

function buildDownload(format) {
  const base = activeTabName === 'speakers' ? 'transcript-by-speaker' : 'transcript';
  if (format === 'srt') return { content: buildSrt(), filename: `${base}.srt`, mime: 'text/plain' };
  if (format === 'vtt') return { content: buildVtt(), filename: `${base}.vtt`, mime: 'text/vtt' };
  return { content: getActiveText(), filename: `${base}.txt`, mime: 'text/plain' };
}

downloadBtn.addEventListener('click', () => {
  const { content, filename, mime } = buildDownload(formatSelect.value);
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});

loadMeeting();
