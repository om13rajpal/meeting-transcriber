const fs = require('fs');
const fsp = fs.promises;
const { execFile } = require('child_process');

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;

const DEEPGRAM_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024; // Deepgram's hard limit per request
const DEEPGRAM_TIMEOUT_MS = 20 * 60 * 1000; // generous ceiling for very long recordings
const DEEPGRAM_MAX_RETRIES = 3;
const FFMPEG_MAX_BUFFER_BYTES = 1024 * 1024 * 20;

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: FFMPEG_MAX_BUFFER_BYTES }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.toString() || err.message));
      resolve(stdout.toString());
    });
  });
}

async function probeStreams(filePath, streamType) {
  try {
    const out = await execFileP('ffprobe', [
      '-v', 'error',
      '-select_streams', streamType,
      '-show_entries', 'stream=index',
      '-of', 'csv=p=0',
      filePath
    ]);
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

// Ask ffprobe rather than trusting the file extension (handles mislabeled
// files, audio-only .mp4s, and video files with no audio track).
const hasVideoStream = (filePath) => probeStreams(filePath, 'v');
const hasAudioStream = (filePath) => probeStreams(filePath, 'a');

// Always normalize to mono 16kHz mp3, whether the source was video or audio.
// This gives Deepgram one consistent, well-supported input regardless of the
// original container/codec, and shrinks large uncompressed uploads before
// they're sent over the network.
async function normalizeAudio(inputPath) {
  const outputPath = `${inputPath}.norm.mp3`;
  await execFileP('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-codec:a', 'libmp3lame',
    '-b:a', '64k',
    '-loglevel', 'error',
    '-nostats',
    outputPath
  ]);
  return outputPath;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries transient failures (429 rate limits, 5xx, network drops, timeouts)
// with exponential backoff; never retries 4xx client errors like bad audio
// or a rejected API key.
async function transcribeWithRetry(url, headers, body) {
  let lastError;

  for (let attempt = 0; attempt <= DEEPGRAM_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), DEEPGRAM_TIMEOUT_MS);

    try {
      const resp = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
      clearTimeout(timeoutId);

      if (resp.ok) return resp;

      const isRetryable = resp.status === 429 || resp.status >= 500;
      if (isRetryable && attempt < DEEPGRAM_MAX_RETRIES) {
        const retryAfter = Number(resp.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
        await sleep(delay);
        continue;
      }

      const errText = await resp.text().catch(() => '');
      throw new Error(`Deepgram API error (${resp.status}): ${errText}`);
    } catch (err) {
      clearTimeout(timeoutId);

      if (err.name === 'AbortError') {
        lastError = Object.assign(new Error('Deepgram did not respond in time. Please try again.'), { clientSafe: true });
      } else if (err.name === 'TypeError') {
        lastError = Object.assign(new Error('Could not reach Deepgram. Check your internet connection and try again.'), { clientSafe: true });
      } else {
        lastError = err;
      }

      const isNetworkFailure = err.name === 'AbortError' || err.name === 'TypeError';
      if (isNetworkFailure && attempt < DEEPGRAM_MAX_RETRIES) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }

      throw lastError;
    }
  }

  throw lastError;
}

// Runs the full uploaded-file -> transcript pipeline: probe for
// video/audio streams, normalize to mono 16kHz mp3, guard against
// Deepgram's payload size limit, call Deepgram, and parse the response.
// Always cleans up the uploaded and normalized temp files, even on failure.
async function transcribeFile(uploadedPath) {
  let normalizedPath = null;

  try {
    if (!DEEPGRAM_API_KEY) {
      throw new Error('Server is missing DEEPGRAM_API_KEY. Add it to .env and restart the server.');
    }

    const isVideo = await hasVideoStream(uploadedPath);

    if (!(await hasAudioStream(uploadedPath))) {
      throw Object.assign(new Error('This file has no audio track to transcribe.'), { clientSafe: true });
    }

    normalizedPath = await normalizeAudio(uploadedPath);

    const { size } = await fsp.stat(normalizedPath);
    if (size > DEEPGRAM_MAX_PAYLOAD_BYTES) {
      throw Object.assign(new Error('This recording is too long to transcribe in one request (exceeds Deepgram’s size limit).'), { clientSafe: true });
    }

    const audioBuffer = await fsp.readFile(normalizedPath);

    const dgUrl = `https://api.deepgram.com/v1/listen?${new URLSearchParams({
      model: 'nova-3',
      language: 'multi',
      smart_format: 'true',
      punctuate: 'true',
      diarize: 'true',
      utterances: 'true',
      mip_opt_out: 'true'
    })}`;

    const dgResp = await transcribeWithRetry(
      dgUrl,
      { Authorization: `Token ${DEEPGRAM_API_KEY}`, 'Content-Type': 'audio/mpeg' },
      audioBuffer
    );

    const data = await dgResp.json();
    const alt = data?.results?.channels?.[0]?.alternatives?.[0];
    const transcript = alt?.transcript || '';
    const utterances = (data?.results?.utterances || []).map((u) => ({
      speaker: u.speaker,
      start: u.start,
      end: u.end,
      transcript: u.transcript
    }));

    return {
      isVideo,
      durationSeconds: data?.metadata?.duration ?? null,
      transcript,
      utterances
    };
  } finally {
    await Promise.allSettled([
      fsp.unlink(uploadedPath),
      normalizedPath ? fsp.unlink(normalizedPath) : Promise.resolve()
    ]);
  }
}

module.exports = { transcribeFile };
