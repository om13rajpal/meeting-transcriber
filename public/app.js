const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const startBtn = document.getElementById('startBtn');
const clearBtn = document.getElementById('clearBtn');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
const statusTimer = document.getElementById('statusTimer');
const errorBox = document.getElementById('errorBox');
const resultBox = document.getElementById('resultBox');
const metaEl = document.getElementById('meta');
const plainView = document.getElementById('plainView');
const speakerView = document.getElementById('speakerView');
const copyBtn = document.getElementById('copyBtn');
const downloadBtn = document.getElementById('downloadBtn');
const formatSelect = document.getElementById('formatSelect');
const tabs = document.querySelectorAll('.tab');

let selectedFile = null;
let timerInterval = null;
let lastTranscript = '';
let activeTabName = 'speakers';
let speakerNames = {};
let currentGroups = [];
let currentUtterances = [];
let currentDuration = 0;

const SPEAKER_COLORS = 6;

function pickFile(file) {
  if (!file) return;
  selectedFile = file;
  fileName.textContent = `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`;
  fileInfo.classList.remove('hidden');
  errorBox.classList.add('hidden');
  resultBox.classList.add('hidden');
}

dropzone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => pickFile(e.target.files[0]));

['dragenter', 'dragover'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach((evt) =>
  dropzone.addEventListener(evt, (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  })
);
dropzone.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  pickFile(file);
});

clearBtn.addEventListener('click', () => {
  selectedFile = null;
  fileInput.value = '';
  fileInfo.classList.add('hidden');
  resultBox.classList.add('hidden');
  errorBox.classList.add('hidden');
  speakerNames = {};
  currentGroups = [];
  currentUtterances = [];
  currentDuration = 0;
});

function startTimer() {
  const start = performance.now();
  statusTimer.textContent = '0:00';
  timerInterval = setInterval(() => {
    const secs = Math.floor((performance.now() - start) / 1000);
    const m = Math.floor(secs / 60);
    const s = String(secs % 60).padStart(2, '0');
    statusTimer.textContent = `${m}:${s}`;
  }, 500);
}

function stopTimer() {
  clearInterval(timerInterval);
}

startBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  startBtn.disabled = true;
  clearBtn.disabled = true;
  errorBox.classList.add('hidden');
  resultBox.classList.add('hidden');
  statusBox.classList.remove('hidden');
  statusText.textContent = 'Uploading and transcribing… this can take a while for long recordings.';
  startTimer();

  try {
    const formData = new FormData();
    formData.append('file', selectedFile);

    const resp = await fetch('/api/transcribe', {
      method: 'POST',
      body: formData
    });

    const data = await resp.json();

    if (!resp.ok) {
      throw new Error(data.error || 'Transcription failed.');
    }

    renderResult(data);
  } catch (err) {
    errorBox.textContent = err.message || 'Something went wrong.';
    errorBox.classList.remove('hidden');
  } finally {
    stopTimer();
    statusBox.classList.add('hidden');
    startBtn.disabled = false;
    clearBtn.disabled = false;
  }
});

function formatTime(sec) {
  if (sec == null) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function renderResult(data) {
  lastTranscript = data.transcript || '(no speech detected)';
  plainView.textContent = lastTranscript;
  speakerNames = {};
  currentUtterances = data.utterances || [];
  currentDuration = data.durationSeconds || 0;
  currentGroups = groupUtterances(currentUtterances);

  const durationText = data.durationSeconds ? `${formatTime(data.durationSeconds)} duration` : '';
  const wordCount = lastTranscript.trim() ? lastTranscript.trim().split(/\s+/).length : 0;
  const speakerCount = new Set(currentGroups.map((g) => g.speaker)).size;

  metaEl.textContent = [
    data.originalName,
    data.isVideo ? 'video → audio extracted' : 'audio file',
    durationText,
    `${wordCount} words`,
    speakerCount ? `${speakerCount} speaker${speakerCount > 1 ? 's' : ''}` : null
  ].filter(Boolean).join(' · ');

  renderSpeakerView();
  resultBox.classList.remove('hidden');
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

function commitSpeakerName(speakerId, rawName) {
  const trimmed = rawName.replace(/\s+/g, ' ').trim();
  if (trimmed && trimmed !== `Speaker ${speakerId + 1}`) {
    speakerNames[speakerId] = trimmed;
  } else {
    delete speakerNames[speakerId];
  }
  renderSpeakerView();
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
