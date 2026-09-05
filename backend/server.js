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
const MeetingActionToken = require('./models/MeetingActionToken');
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

// How long a failed meeting's raw file is kept around for a possible Retry
// before the orphaned-file sweep reclaims the disk space. Generous enough
// to give a user a real chance to notice and retry, bounded so an
// abandoned recording doesn't sit on Render's limited free-tier disk
// forever. See sweepOrphanedFiles().
const ORPHANED_FILE_RETENTION_MS = 24 * 60 * 60 * 1000;
const ORPHANED_FILE_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

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

// Runs transcribeFile() against `filePath` for `meeting` and records the
// outcome, exactly the way /api/transcribe always has - shared with
// /api/meetings/retry below so there's exactly one implementation of "run
// the pipeline and update the meeting," not two that could drift.
// Meeting.pendingFilePath is set *before* transcribeFile() runs (not just
// on failure) so a process death mid-job still leaves a record of where
// the file is - the stale-job sweep's own cleanup, and a future Retry
// attempt on a hung-then-recovered meeting, both depend on that.
async function runTranscriptionJob(meeting, filePath) {
  meeting.pendingFilePath = filePath;
  meeting.pendingFileStoredAt = new Date();
  await meeting.save();

  try {
    const result = await transcribeFile(filePath);

    // Guarded by { status: 'processing' } rather than a plain meeting.save()
    // - if /api/meetings/cancel flipped this meeting to 'failed' while this
    // job was still running (a real, possible race: Cancel's own unlink
    // doesn't actually interrupt the in-flight ffmpeg/Deepgram call), this
    // update matches nothing and `updated` comes back null, so the
    // completion is simply dropped instead of resurrecting a job the user
    // explicitly cancelled.
    const updated = await Meeting.findOneAndUpdate(
      { _id: meeting._id, status: 'processing' },
      {
        $set: {
          isVideo: result.isVideo,
          durationSeconds: result.durationSeconds,
          transcript: result.transcript,
          utterances: result.utterances,
          deepgramModel: result.model,
          deepgramCostUsd: result.costUsd,
          deepgramRequestId: result.requestId,
          status: 'complete'
        },
        // Only cleared on success - a failure deliberately keeps both
        // fields set so the file survives for a possible Retry (see
        // /api/meetings/retry and the orphaned-file sweep). A plain
        // `field: undefined` in a findOneAndUpdate object is silently
        // dropped, not applied - confirmed directly against this app's
        // own Mongoose version, not assumed - so this needs a real
        // $unset, unlike the equivalent `meeting.field = undefined`
        // pattern that works on a live document's own .save().
        $unset: { pendingFilePath: '', pendingFileStoredAt: '' }
      },
      { new: true }
    );
    if (!updated) {
      console.log(`Skipping completion for ${meeting._id}: no longer 'processing' (likely cancelled).`);
      return;
    }
    meeting = updated;
    await fs.promises.unlink(filePath).catch(() => {});
    await sendNotifications(meeting);

    // Best-effort: Deepgram's billing data for this exact request is
    // sometimes already indexed by the time transcription finishes, so
    // this can upgrade the estimate to the real billed amount right away
    // instead of waiting for the next sweepPendingCosts() tick. Usually it
    // isn't ready yet - fetchExactCost() just returns null in that case,
    // which is fine, since the sweep is what actually guarantees this
    // eventually happens either way.
    const exactUsd = await fetchExactCost(result.requestId);
    if (exactUsd != null) {
      meeting.deepgramCostUsd = exactUsd;
      meeting.deepgramCostExact = true;
      await meeting.save().catch((saveError) => console.error(saveError));
    }
  } catch (error) {
    console.error(error);
    const isDeepgramError = error.message?.startsWith('Deepgram API error');
    // Same race guard as the success path above - don't overwrite a
    // meeting that was already cancelled (or otherwise moved on) while
    // this job was failing.
    const updated = await Meeting.findOneAndUpdate(
      { _id: meeting._id, status: 'processing' },
      {
        status: 'failed',
        errorMessage: error.clientSafe || isDeepgramError
          ? error.message
          : 'Could not process this file. It may be corrupted, empty, or in an unsupported format.'
      },
      { new: true }
    ).catch((saveError) => {
      console.error(saveError);
      return null;
    });
    if (!updated) return;
    await sendNotifications(updated);
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
      // Unlike a normal failure (where the file is kept for a possible
      // Retry - see runTranscriptionJob), a job stuck long enough for this
      // sweep to fire means whatever process was working on it is long
      // gone (a crash, a restart) - there's nothing that could still be
      // reading this file, so it's safe to reclaim immediately rather than
      // waiting for the separate orphaned-file sweep's 24-hour window.
      if (meeting.pendingFilePath) {
        await fs.promises.unlink(meeting.pendingFilePath).catch(() => {});
        meeting.pendingFilePath = undefined;
        meeting.pendingFileStoredAt = undefined;
      }
      await meeting.save();
      await sendNotifications(meeting);
    }
    console.log(`Marked ${staleMeetings.length} stale processing job(s) as failed.`);
  } catch (error) {
    console.error('Stale job sweep failed:', error);
  }
}

// Reclaims a failed meeting's stored file once it's been sitting unretried
// for ORPHANED_FILE_RETENTION_MS - the safety net for a recording nobody
// ever comes back to Retry or Cancel. Uses pendingFileStoredAt, not
// createdAt, as the retention clock: createdAt is the *original* upload
// time, which would make this sweep reclaim a file seconds after a much
// later Retry re-stored it.
async function sweepOrphanedFiles() {
  const cutoff = new Date(Date.now() - ORPHANED_FILE_RETENTION_MS);
  try {
    const orphaned = await Meeting.find({
      pendingFilePath: { $ne: null },
      status: { $ne: 'processing' },
      pendingFileStoredAt: { $lt: cutoff }
    });
    if (!orphaned.length) return;

    for (const meeting of orphaned) {
      await fs.promises.unlink(meeting.pendingFilePath).catch(() => {});
      meeting.pendingFilePath = undefined;
      meeting.pendingFileStoredAt = undefined;
      await meeting.save();
    }
    console.log(`Reclaimed ${orphaned.length} orphaned recording file(s).`);
  } catch (error) {
    console.error('Orphaned file sweep failed:', error);
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

  await sweepOrphanedFiles();
  setInterval(sweepOrphanedFiles, ORPHANED_FILE_SWEEP_INTERVAL_MS).unref();

  const app = express();

  app.use(cors({
    origin: allowedOrigins.length ? allowedOrigins : false,
    methods: ['POST', 'GET', 'OPTIONS']
  }));

  // Only used by /api/meetings/retry and /api/meetings/cancel below - both
  // are small, token-authenticated, server-to-server calls from the
  // Next.js app (never the browser), so this doesn't interact with the
  // multipart /api/transcribe route at all (express.json() only parses
  // requests with an application/json Content-Type).
  app.use(express.json());

  app.get('/', (req, res) => {
    res.status(200).json({ ok: true });
  });

  // Dedicated path for external uptime/keep-alive pings (cron-job.org, etc.)
  // - same trivial response as '/', just a conventional, memorable path to
  // point a monitor at instead of the bare root.
  app.get('/health', (req, res) => {
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

      await runTranscriptionJob(meeting, req.file.path);
    });
  });

  // Re-runs the pipeline against a meeting's already-stored file (see
  // Meeting.pendingFilePath / runTranscriptionJob above) - the point of
  // keeping that file around at all. Token-authenticated (MeetingActionToken)
  // rather than session-authenticated: this backend has no session
  // mechanism of its own, and retryMeeting() in app/actions/meetings.js
  // already verified the session and ownership before minting one.
  app.post('/api/meetings/retry', async (req, res) => {
    // Must be a plain string, not just truthy - {_id: token} below goes
    // straight into a Mongoose query, and an object value there (e.g.
    // {"token": {"$ne": null}} in the JSON body) is interpreted as a raw
    // query operator, not cast to the schema's String type. Without this
    // check that would match and consume an arbitrary live token instead
    // of the one this specific caller was issued - a real, confirmed
    // NoSQL injection, not a theoretical one.
    const token = req.body?.token;
    if (typeof token !== 'string' || !token) {
      return res.status(400).json({ error: 'Missing token.' });
    }

    const tokenDoc = await MeetingActionToken.findOneAndDelete({ _id: token, action: 'retry' }).catch(() => null);
    if (!tokenDoc) {
      return res.status(401).json({ error: 'This retry request has expired. Please try again.' });
    }

    const meeting = await Meeting.findById(tokenDoc.meetingId).catch(() => null);
    if (!meeting) {
      return res.status(404).json({ error: 'This meeting was deleted.' });
    }
    if (meeting.status !== 'failed' || !meeting.pendingFilePath) {
      return res.status(409).json({ error: 'This recording has nothing to retry.' });
    }

    const fileExists = await fs.promises.access(meeting.pendingFilePath).then(() => true).catch(() => false);
    if (!fileExists) {
      // The backend restarted (Render free-tier spin-down, a deploy) since
      // this meeting failed, and its local disk doesn't survive that - a
      // known, accepted limitation of keeping the file locally rather than
      // in persistent storage. Nothing to retry with; say so plainly
      // rather than trying and failing again with a confusing error.
      meeting.pendingFilePath = undefined;
      meeting.pendingFileStoredAt = undefined;
      await meeting.save().catch(() => {});
      return res.status(410).json({ error: 'The original recording is no longer available on the server. Please upload it again.' });
    }

    meeting.status = 'processing';
    meeting.errorMessage = undefined;
    await meeting.save();
    res.status(202).json({ id: String(meeting._id) });

    await runTranscriptionJob(meeting, meeting.pendingFilePath);
  });

  // Deletes a meeting's stored file and marks it failed. Deliberately does
  // NOT call sendNotifications() the way every other status-flip in this
  // file does - the user just took this action themselves, so an "upload
  // failed" email/webhook right afterward would be redundant, not
  // informative.
  app.post('/api/meetings/cancel', async (req, res) => {
    // Must be a plain string, not just truthy - {_id: token} below goes
    // straight into a Mongoose query, and an object value there (e.g.
    // {"token": {"$ne": null}} in the JSON body) is interpreted as a raw
    // query operator, not cast to the schema's String type. Without this
    // check that would match and consume an arbitrary live token instead
    // of the one this specific caller was issued - a real, confirmed
    // NoSQL injection, not a theoretical one.
    const token = req.body?.token;
    if (typeof token !== 'string' || !token) {
      return res.status(400).json({ error: 'Missing token.' });
    }

    const tokenDoc = await MeetingActionToken.findOneAndDelete({ _id: token, action: 'cancel' }).catch(() => null);
    if (!tokenDoc) {
      return res.status(401).json({ error: 'This cancel request has expired. Please try again.' });
    }

    const meeting = await Meeting.findById(tokenDoc.meetingId).catch(() => null);
    if (!meeting) {
      return res.status(404).json({ error: 'This meeting was deleted.' });
    }
    if (meeting.status !== 'processing') {
      return res.status(409).json({ error: 'This recording is not in progress.' });
    }

    if (meeting.pendingFilePath) {
      await fs.promises.unlink(meeting.pendingFilePath).catch(() => {});
    }
    meeting.status = 'failed';
    meeting.errorMessage = 'Cancelled by user.';
    meeting.pendingFilePath = undefined;
    meeting.pendingFileStoredAt = undefined;
    await meeting.save();
    res.status(200).json({ ok: true });
  });

  app.listen(PORT, () => {
    console.log(`Transcription backend running on port ${PORT}`);
  });
}

main().catch((error) => {
  console.error('Failed to start the server:', error);
  process.exit(1);
});
