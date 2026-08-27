require('dotenv').config();

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { connectToDatabase } = require('./db');
const Meeting = require('./models/Meeting');
const UploadToken = require('./models/UploadToken');
const { transcribeFile, fetchExactCost } = require('./services/deepgram');
const { sendMeetingEmail } = require('./services/email');
const { sendMeetingWebhook } = require('./services/webhook');

const PORT = process.env.PORT || 10000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

// A meeting stuck in 'processing' past this long almost certainly means the
// backend process died or restarted mid-job (a crash, a Render deploy, an
// out-of-memory kill) rather than a genuinely slow transcription - ffmpeg
// and Deepgram are fast relative to this. Generous enough not to false
// positive on a real large file, short enough that a user isn't staring at
// "Transcribing..." for hours with no way to know it's actually dead.
const STALE_PROCESSING_MS = 30 * 60 * 1000;
const STALE_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Deepgram's own billing data for a request isn't necessarily indexed the
// instant transcription finishes, so the exact cost (see fetchExactCost())
// is fetched on a recurring sweep rather than once right after completion.
// Reuses the stale-job sweep's cadence; gives up after this long so a
// request Deepgram's billing pipeline never indexes (or a wrong/missing
// DEEPGRAM_PROJECT_ID) doesn't get retried forever.
const COST_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const COST_SWEEP_LOOKBACK_MS = 6 * 60 * 60 * 1000;

// Comma-separated list of origins allowed to call this backend directly
// from the browser (the Vercel-hosted frontend, plus localhost for dev).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const generatedName = `${crypto.randomUUID()}${path.extname(file.originalname) || ''}`;
    // multer only populates req.file after the field finishes streaming, so
    // if the client disconnects mid-upload (e.g. a page reload), req.file
    // stays undefined even though diskStorage already wrote a partial file
    // to disk. Stash the path here, before streaming starts, so the error
    // handler below can still find and clean it up.
    req.pendingUploadPath = path.join(UPLOAD_DIR, generatedName);
    cb(null, generatedName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

// Sends the completion/failure email + webhooks, then records whether each
// one actually succeeded back onto the meeting - this is what makes
// delivery status visible on the meeting page (and resendable there)
// instead of the notification being a total black box, which is exactly
// what made an earlier silent webhook failure impossible to self-diagnose.
// A second save() (the first already persisted status/errorMessage) rather
// than delaying that first save until after this - notifications can take
// up to WEBHOOK_TIMEOUT_MS each, and the dashboard/meeting page polling
// should see 'complete'/'failed' as soon as it's true, not after every
// notification attempt finishes.
async function sendNotifications(meeting) {
  try {
    const [emailOk, webhookResults] = await Promise.all([
      sendMeetingEmail(meeting.userEmail, meeting),
      sendMeetingWebhook(meeting.userWebhooks, meeting)
    ]);

    const now = new Date();
    meeting.emailLastAttemptAt = now;
    meeting.emailLastAttemptOk = emailOk;

    const byUrl = new Map(webhookResults.map((r) => [r.url, r]));
    meeting.userWebhooks.forEach((w) => {
      const result = byUrl.get(w.url);
      if (result) {
        w.lastAttemptAt = now;
        w.lastAttemptOk = result.ok;
        w.lastAttemptStatus = result.status;
      }
    });
    if (meeting.userWebhooks.length) meeting.markModified('userWebhooks');

    await meeting.save();
  } catch (error) {
    console.error('sendNotifications failed:', error);
  }
}

// Marks any 'processing' meeting older than STALE_PROCESSING_MS as failed.
// Runs once at startup (to clean up whatever was left mid-job by a previous
// crash or deploy, since nothing else ever revisits those rows) and on a
// recurring interval (to catch a job that hangs without the process itself
// restarting). This is the only thing that can ever un-stick a 'processing'
// row if the request handler running it never gets to its own catch block.
async function sweepStaleJobs() {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  try {
    // find() + individual updates rather than updateMany(), since sending
    // the failure email needs each meeting's userEmail - fine at this
    // app's scale (stale jobs are rare; this isn't a hot path).
    const staleMeetings = await Meeting.find({ status: 'processing', createdAt: { $lt: cutoff } });
    if (!staleMeetings.length) return;

    for (const meeting of staleMeetings) {
      meeting.status = 'failed';
      meeting.errorMessage = 'Transcription did not finish in time. Please try uploading again.';
      await meeting.save();
      await sendNotifications(meeting);
    }
    console.log(`Marked ${staleMeetings.length} stale processing job(s) as failed.`);
  } catch (error) {
    console.error('Stale job sweep failed:', error);
  }
}

// Upgrades deepgramCostUsd from the completion-time estimate to Deepgram's
// actual billed amount, for every 'complete' meeting whose exact cost
// hasn't been fetched yet. No-ops entirely if DEEPGRAM_PROJECT_ID isn't
// configured (fetchExactCost() returns null for every meeting, so nothing
// ever updates) - the estimate is left in place, which is still a real,
// clearly-labeled number, just not Deepgram's own billing figure.
async function sweepPendingCosts() {
  if (!process.env.DEEPGRAM_PROJECT_ID) return;

  const cutoff = new Date(Date.now() - COST_SWEEP_LOOKBACK_MS);
  try {
    const pending = await Meeting.find({
      status: 'complete',
      deepgramCostExact: { $ne: true },
      deepgramRequestId: { $exists: true, $ne: null },
      createdAt: { $gte: cutoff }
    }).select('deepgramRequestId');
    if (!pending.length) return;

    for (const meeting of pending) {
      const exactUsd = await fetchExactCost(meeting.deepgramRequestId);
      if (exactUsd != null) {
        await Meeting.updateOne({ _id: meeting._id }, { deepgramCostUsd: exactUsd, deepgramCostExact: true });
      }
    }
  } catch (error) {
    console.error('Cost sweep failed:', error);
  }
}

async function main() {
  await connectToDatabase();

  await sweepStaleJobs();
  setInterval(sweepStaleJobs, STALE_SWEEP_INTERVAL_MS).unref();

  await sweepPendingCosts();
  setInterval(sweepPendingCosts, COST_SWEEP_INTERVAL_MS).unref();

  const app = express();

  app.use(cors({
    origin: allowedOrigins.length ? allowedOrigins : false,
    methods: ['POST', 'GET', 'OPTIONS']
  }));

  app.get('/', (req, res) => {
    res.status(200).json({ ok: true });
  });

  app.post('/api/transcribe', (req, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) {
        // A partial file may have been written to disk even though req.file
        // was never populated (see the filename() comment above).
        if (req.pendingUploadPath) {
          await fs.promises.unlink(req.pendingUploadPath).catch(() => {});
        }
        return res.status(400).json({ error: err.message || 'Upload failed.' });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
      }

      // The token is a required text field alongside the file in the same
      // multipart form. It's minted by the Next.js app (already behind a
      // real session) and authorizes exactly one upload for one user.
      const token = req.body.token;
      if (!token) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(401).json({ error: 'Missing upload authorization.' });
      }

      const tokenDoc = await UploadToken.findByIdAndDelete(token).catch(() => null);
      if (!tokenDoc) {
        await fs.promises.unlink(req.file.path).catch(() => {});
        return res.status(401).json({ error: 'This upload link has expired. Please try again.' });
      }

      // The Meeting row already exists (created by createUploadToken() at
      // mint time, before any bytes were sent), so a reload during the raw
      // upload transfer itself - which nothing here can make resumable,
      // since the browser is what's streaming the bytes - already left a
      // durable 'processing' row behind. Just find it.
      let meeting = tokenDoc.meetingId
        ? await Meeting.findById(tokenDoc.meetingId).catch(() => null)
        : null;

      if (!meeting) {
        // Falls back to the old create-here behavior if the token predates
        // this field (a rolling deploy where the frontend hasn't picked up
        // the new createUploadToken() yet), or if the meeting was deleted
        // by the user while the upload was still in flight - in the latter
        // case, honor the deletion rather than resurrecting the row.
        if (tokenDoc.meetingId) {
          await fs.promises.unlink(req.file.path).catch(() => {});
          return res.status(404).json({ error: 'This meeting was deleted. Please try uploading again.' });
        }
        try {
          meeting = await Meeting.create({
            userId: tokenDoc.userId,
            title: req.file.originalname,
            originalName: req.file.originalname,
            speakerNames: {},
            status: 'processing'
          });
        } catch (error) {
          console.error(error);
          await fs.promises.unlink(req.file.path).catch(() => {});
          return res.status(500).json({ error: 'Could not start transcription.' });
        }
      }

      // Respond immediately rather than making the client hold this
      // connection open for the whole pipeline. Render runs a normal
      // long-lived process (unlike a serverless function, which would be
      // frozen once a response is sent), so the work below keeps running
      // regardless of whether the client is still connected.
      res.status(202).json({ id: String(meeting._id) });

      try {
        const result = await transcribeFile(req.file.path);
        meeting.isVideo = result.isVideo;
        meeting.durationSeconds = result.durationSeconds;
        meeting.transcript = result.transcript;
        meeting.utterances = result.utterances;
        meeting.deepgramModel = result.model;
        meeting.deepgramCostUsd = result.costUsd;
        meeting.deepgramRequestId = result.requestId;
        meeting.status = 'complete';
        await meeting.save();
        await sendNotifications(meeting);
      } catch (error) {
        console.error(error);
        const isDeepgramError = error.message?.startsWith('Deepgram API error');
        meeting.status = 'failed';
        meeting.errorMessage = error.clientSafe || isDeepgramError
          ? error.message
          : 'Could not process this file. It may be corrupted, empty, or in an unsupported format.';
        await meeting.save().catch((saveError) => console.error(saveError));
        await sendNotifications(meeting);
      }
    });
  });

  app.listen(PORT, () => {
    console.log(`Transcription backend running on port ${PORT}`);
  });
}

main().catch((error) => {
  console.error('Failed to start the server:', error);
  process.exit(1);
});
