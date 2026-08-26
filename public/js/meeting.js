// Meeting detail page: loads a saved meeting from the server and renders the
// same transcript viewer as the old upload flow, but speaker renames PATCH
// back to the server instead of only living in local JS state.

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
const deleteBtn = document.getElementById('deleteBtn');
const shareBtn = document.getElementById('shareBtn');
const sharePanel = document.getElementById('sharePanel');
const shareUrlInput = document.getElementById('shareUrlInput');
const copyShareBtn = document.getElementById('copyShareBtn');
const revokeShareBtn = document.getElementById('revokeShareBtn');
const tabs = document.querySelectorAll('.tab');

let meetingId = '';
let lastTitle = '';
let lastTranscript = '';
let activeTabName = 'speakers';
let speakerNames = {};
let currentGroups = [];
let currentUtterances = [];
let currentDuration = 0;

const SPEAKER_COLORS = 6;

function pathMeetingId() {
  const match = window.location.pathname.match(/^\/meeting\/([^/]+)/);
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
  lastTitle = meeting.title || meeting.originalName || 'Untitled recording';
  meetingTitleEl.textContent = lastTitle;
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
  showShareState(meeting.shareToken);
  resultBox.classList.remove('hidden');
  notFoundBox.classList.add('hidden');
}

function selectAllTextIn(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

meetingTitleEl.addEventListener('focus', () => selectAllTextIn(meetingTitleEl));
meetingTitleEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    meetingTitleEl.blur();
  }
});
meetingTitleEl.addEventListener('blur', async () => {
  const trimmed = meetingTitleEl.textContent.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    // Don't allow saving an empty title; restore the last known-good value.
    meetingTitleEl.textContent = lastTitle;
    return;
  }
  if (trimmed === lastTitle) return;

  try {
    const resp = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: trimmed })
    });
    if (!resp.ok) {
      meetingTitleEl.textContent = lastTitle;
      return;
    }
    const data = await resp.json();
    lastTitle = data.meeting.title;
    meetingTitleEl.textContent = lastTitle;
  } catch (err) {
    meetingTitleEl.textContent = lastTitle;
  }
});

function shareUrlFor(token) {
  return `${window.location.origin}/share/${token}`;
}

function showShareState(token) {
  if (token) {
    shareUrlInput.value = shareUrlFor(token);
    sharePanel.classList.remove('hidden');
  } else {
    sharePanel.classList.add('hidden');
    shareUrlInput.value = '';
  }
}

async function loadMeeting() {
  meetingId = pathMeetingId();
  if (!meetingId) {
    showNotFound('Meeting not found.');
    return;
  }

  try {
    const resp = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}`);
    if (resp.status === 404) {
      showNotFound('Meeting not found.');
      return;
    }
    if (!resp.ok) {
      showNotFound('Something went wrong loading this meeting.');
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
    nameEl.contentEditable = 'true';
    nameEl.spellcheck = false;
    nameEl.title = 'Click to rename this speaker';
    nameEl.textContent = speakerLabel(g.speaker);
    nameEl.addEventListener('focus', selectAllText);
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        nameEl.blur();
      }
    });
    nameEl.addEventListener('blur', () => commitSpeakerName(g.speaker, nameEl.textContent));

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

function selectAllText(e) {
  const range = document.createRange();
  range.selectNodeContents(e.target);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

async function commitSpeakerName(speakerId, rawName) {
  const trimmed = rawName.replace(/\s+/g, ' ').trim();
  // Empty string tells the server to remove any override for this speaker
  // (falls back to the default "Speaker N" label), matching the PATCH contract.
  const value = trimmed && trimmed !== `Speaker ${speakerId + 1}` ? trimmed : '';

  try {
    const resp = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speakerNames: { [speakerId]: value } })
    });
    if (!resp.ok) {
      // Fall back to re-rendering with the last known-good server state so
      // the UI doesn't show a rename that didn't actually persist.
      renderSpeakerView();
      return;
    }
    const data = await resp.json();
    speakerNames = data.meeting.speakerNames || {};
    renderSpeakerView();
  } catch (err) {
    renderSpeakerView();
  }
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

// Falls back to a single cue spanning the whole clip when diarization returned no utterances.
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

shareBtn.addEventListener('click', async () => {
  shareBtn.disabled = true;
  try {
    const resp = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/share`, { method: 'POST' });
    if (resp.ok) {
      const data = await resp.json();
      showShareState(data.shareToken);
    }
  } finally {
    shareBtn.disabled = false;
  }
});

copyShareBtn.addEventListener('click', async () => {
  await navigator.clipboard.writeText(shareUrlInput.value);
  copyShareBtn.textContent = 'Copied!';
  setTimeout(() => (copyShareBtn.textContent = 'Copy link'), 1200);
});

revokeShareBtn.addEventListener('click', async () => {
  if (!confirm('Revoke this share link? Anyone with the old link will lose access.')) return;
  revokeShareBtn.disabled = true;
  try {
    const resp = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}/share`, { method: 'DELETE' });
    if (resp.ok) {
      showShareState(null);
    }
  } finally {
    revokeShareBtn.disabled = false;
  }
});

deleteBtn.addEventListener('click', async () => {
  if (!confirm('Delete this meeting? This cannot be undone.')) return;
  deleteBtn.disabled = true;
  try {
    const resp = await fetch(`/api/meetings/${encodeURIComponent(meetingId)}`, { method: 'DELETE' });
    if (resp.ok) {
      window.location.href = '/';
      return;
    }
    deleteBtn.disabled = false;
  } catch (err) {
    deleteBtn.disabled = false;
  }
});

loadMeeting();
