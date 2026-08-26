(() => {
  'use strict';

  const dropzone = document.getElementById('dropzone');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const fileNameEl = document.getElementById('fileName');
  const clearBtn = document.getElementById('clearBtn');
  const transcribeBtn = document.getElementById('transcribeBtn');
  const statusBox = document.getElementById('statusBox');
  const statusText = document.getElementById('statusText');
  const errorBox = document.getElementById('errorBox');
  const meetingListEl = document.getElementById('meetingList');
  const emptyStateEl = document.getElementById('emptyState');
  const noResultsStateEl = document.getElementById('noResultsState');
  const loadingStateEl = document.getElementById('loadingState');
  const userEmailEl = document.getElementById('userEmail');
  const logoutBtn = document.getElementById('logoutBtn');
  const searchInput = document.getElementById('searchInput');

  let selectedFile = null;
  let statusTimer = null;
  let statusStart = null;
  let searchDebounceTimer = null;

  // ---- Auth chrome ----

  async function loadUser() {
    try {
      const res = await fetch('/api/auth/me', { credentials: 'same-origin' });
      if (!res.ok) {
        window.location.href = '/login.html';
        return;
      }
      const data = await res.json();
      userEmailEl.textContent = data.email || '';
    } catch (err) {
      // Network hiccup on load isn't fatal, leave the email blank rather
      // than bouncing the user for a transient failure.
    }
  }

  logoutBtn.addEventListener('click', async () => {
    logoutBtn.disabled = true;
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (err) {
      // Fall through to redirect regardless, worst case the session
      // outlives this request and the next page load re-establishes it.
    }
    window.location.href = '/login.html';
  });

  // ---- Upload flow ----

  function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.remove('hidden');
  }

  function clearError() {
    errorBox.textContent = '';
    errorBox.classList.add('hidden');
  }

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

  function selectFile(file) {
    if (!file) return;
    selectedFile = file;
    fileNameEl.textContent = `${file.name} (${formatBytes(file.size)})`;
    fileInfo.classList.remove('hidden');
    dropzone.classList.add('hidden');
    clearError();
  }

  function resetSelection() {
    selectedFile = null;
    fileInput.value = '';
    fileInfo.classList.add('hidden');
    dropzone.classList.remove('hidden');
  }

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) selectFile(file);
  });

  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (file) selectFile(file);
  });

  clearBtn.addEventListener('click', () => {
    resetSelection();
    clearError();
  });

  function formatElapsed(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
  }

  function startStatus() {
    statusStart = Date.now();
    statusBox.classList.remove('hidden');
    statusText.textContent = `Uploading & transcribing… ${formatElapsed(0)}`;
    statusTimer = window.setInterval(() => {
      statusText.textContent = `Uploading & transcribing… ${formatElapsed(Date.now() - statusStart)}`;
    }, 1000);
  }

  function stopStatus() {
    if (statusTimer) {
      window.clearInterval(statusTimer);
      statusTimer = null;
    }
    statusBox.classList.add('hidden');
  }

  transcribeBtn.addEventListener('click', async () => {
    if (!selectedFile) return;

    clearError();
    transcribeBtn.disabled = true;
    clearBtn.disabled = true;
    startStatus();

    const formData = new FormData();
    formData.append('file', selectedFile);

    try {
      const res = await fetch('/api/transcribe', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || 'Could not transcribe this file. Please try again.');
      }

      resetSelection();
      await loadMeetings(searchInput.value);
    } catch (err) {
      showError(err.message || 'Something went wrong. Please try again.');
    } finally {
      stopStatus();
      transcribeBtn.disabled = false;
      clearBtn.disabled = false;
    }
  });

  // ---- Meeting list ----

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
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function buildMeetingRow(meeting) {
    const row = document.createElement('div');
    row.className = 'meeting-row';
    row.addEventListener('click', () => {
      window.location.href = `/meeting/${meeting.id}`;
    });

    const main = document.createElement('div');
    main.className = 'meeting-row-main';

    const title = document.createElement('div');
    title.className = 'meeting-row-title';
    title.textContent = meeting.title || meeting.originalName || 'Untitled recording';

    const metaParts = [meeting.isVideo ? 'Video' : 'Audio'];
    const duration = formatDuration(meeting.durationSeconds);
    if (duration) metaParts.push(duration);
    const date = formatDate(meeting.createdAt);
    if (date) metaParts.push(date);

    const meta = document.createElement('div');
    meta.className = 'meeting-row-meta';
    meta.textContent = metaParts.join(' · ');

    const preview = document.createElement('div');
    preview.className = 'meeting-row-preview';
    preview.textContent = meeting.preview || '';

    main.appendChild(title);
    main.appendChild(meta);
    main.appendChild(preview);

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn small ghost meeting-row-delete';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDelete(meeting.id, row);
    });

    row.appendChild(main);
    row.appendChild(deleteBtn);
    return row;
  }

  async function handleDelete(id, row) {
    const confirmed = window.confirm('Delete this meeting? This cannot be undone.');
    if (!confirmed) return;

    try {
      const res = await fetch(`/api/meetings/${id}`, {
        method: 'DELETE',
        credentials: 'same-origin'
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.error || 'Could not delete this meeting.');
      }
      row.remove();
      if (!meetingListEl.children.length) {
        meetingListEl.classList.add('hidden');
        if (searchInput.value.trim()) {
          noResultsStateEl.classList.remove('hidden');
        } else {
          emptyStateEl.classList.remove('hidden');
        }
      }
    } catch (err) {
      showError(err.message || 'Could not delete this meeting.');
    }
  }

  async function loadMeetings(query) {
    const q = (query || '').trim();

    loadingStateEl.classList.remove('hidden');
    meetingListEl.classList.add('hidden');
    emptyStateEl.classList.add('hidden');
    noResultsStateEl.classList.add('hidden');

    try {
      const url = q ? `/api/meetings?q=${encodeURIComponent(q)}` : '/api/meetings';
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) {
        throw new Error('Could not load your meetings.');
      }
      const meetings = await res.json();

      meetingListEl.textContent = '';
      if (!meetings.length) {
        if (q) {
          noResultsStateEl.classList.remove('hidden');
        } else {
          emptyStateEl.classList.remove('hidden');
        }
      } else {
        meetings.forEach((meeting) => {
          meetingListEl.appendChild(buildMeetingRow(meeting));
        });
        meetingListEl.classList.remove('hidden');
      }
    } catch (err) {
      showError(err.message || 'Could not load your meetings.');
    } finally {
      loadingStateEl.classList.add('hidden');
    }
  }

  searchInput.addEventListener('input', () => {
    window.clearTimeout(searchDebounceTimer);
    searchDebounceTimer = window.setTimeout(() => {
      loadMeetings(searchInput.value);
    }, 300);
  });

  loadUser();
  loadMeetings();
})();
