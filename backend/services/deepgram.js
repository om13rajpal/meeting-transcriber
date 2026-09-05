const fs = require('fs');
const { execFile } = require('child_process');

const fsp = fs.promises;

const DEEPGRAM_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024 * 1024; // Deepgram's hard limit per request
const DEEPGRAM_TIMEOUT_MS = 20 * 60 * 1000; // generous ceiling for very long recordings
const DEEPGRAM_MAX_RETRIES = 3;
const FFMPEG_MAX_BUFFER_BYTES = 1024 * 1024 * 20;

const DEEPGRAM_MODEL = 'nova-3';
// Nova-3 batch, multilingual transcription (~$0.0051/min) plus the
// diarization add-on ($0.0020/min) on Deepgram's pay-as-you-go pricing -
// the one combined rate that actually applies here, since this app always
// requests language=multi and diarize=true (see the request params below).
// This is only ever a fallback shown the moment a meeting finishes, before
// Deepgram's own billing data for that request has had time to appear -
// see fetchExactCost() below, which replaces it with the real billed
// amount once available. Configurable via env so a pricing change doesn't
// need a code deploy.
const DEEPGRAM_RATE_PER_MINUTE_USD = Number(process.env.DEEPGRAM_RATE_PER_MINUTE_USD) || 0.0071;
const DEEPGRAM_MANAGEMENT_TIMEOUT_MS = 10 * 1000;

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
// Always cleans up the normalized intermediate file, even on failure - but
// deliberately leaves `uploadedPath` itself alone regardless of outcome.
// That file's lifecycle (delete on success, keep on failure for Retry,
// delete on an explicit Cancel) is the caller's call (see server.js's
// runTranscriptionJob and Meeting.pendingFilePath), not this function's.
async function transcribeFile(uploadedPath) {
  let normalizedPath = null;

  try {
    const apiKey = process.env.DEEPGRAM_API_KEY;
    if (!apiKey) {
      throw new Error('Server is missing DEEPGRAM_API_KEY.');
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
      { Authorization: `Token ${apiKey}`, 'Content-Type': 'audio/mpeg' },
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

    const durationSeconds = data?.metadata?.duration ?? null;
    const costUsd = durationSeconds != null
      ? Number(((durationSeconds / 60) * DEEPGRAM_RATE_PER_MINUTE_USD).toFixed(4))
      : null;

    return {
      isVideo,
      durationSeconds,
      transcript,
      utterances,
      model: DEEPGRAM_MODEL,
      costUsd,
      requestId: data?.metadata?.request_id ?? null
    };
  } finally {
    if (normalizedPath) {
      await fsp.unlink(normalizedPath).catch(() => {});
    }
  }
}

// Looks up the actual amount Deepgram billed for one request, via their
// Management API (not the /v1/listen endpoint used to transcribe) - this
// is the real number from Deepgram's own billing pipeline, not our
// DEEPGRAM_RATE_PER_MINUTE_USD estimate. Their billing data isn't
// necessarily indexed the instant a transcription finishes, so this can
// legitimately 404/return nothing for a while after a job completes -
// that's not an error, it just means "not ready yet, try again later" (see
// sweepPendingCosts() in server.js, which calls this on a recurring
// interval until it succeeds). Requires DEEPGRAM_PROJECT_ID, which isn't
// needed for transcription itself - if it's not set, this quietly no-ops
// and the estimate from transcribeFile() is simply left in place forever.
async function fetchExactCost(requestId) {
  const apiKey = process.env.DEEPGRAM_API_KEY;
  const projectId = process.env.DEEPGRAM_PROJECT_ID;
  if (!apiKey || !projectId || !requestId) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEEPGRAM_MANAGEMENT_TIMEOUT_MS);

  try {
    const resp = await fetch(
      `https://api.deepgram.com/v1/projects/${projectId}/requests/${requestId}`,
      { headers: { Authorization: `Token ${apiKey}` }, signal: controller.signal }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    const usd = data?.response?.details?.usd;
    return typeof usd === 'number' ? usd : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { transcribeFile, fetchExactCost };
