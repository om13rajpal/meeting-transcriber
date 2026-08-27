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
const { transcribeFile } = require('./services/deepgram');

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

// Marks any 'processing' meeting older than STALE_PROCESSING_MS as failed.
// Runs once at startup (to clean up whatever was left mid-job by a previous
// crash or deploy, since nothing else ever revisits those rows) and on a
// recurring interval (to catch a job that hangs without the process itself
// restarting). This is the only thing that can ever un-stick a 'processing'
// row if the request handler running it never gets to its own catch block.
async function sweepStaleJobs() {
  const cutoff = new Date(Date.now() - STALE_PROCESSING_MS);
  try {
    const result = await Meeting.updateMany(
      { status: 'processing', createdAt: { $lt: cutoff } },
      {
        $set: {
          status: 'failed',
          errorMessage: 'Transcription did not finish in time. Please try uploading again.'
        }
      }
    );
    if (result.modifiedCount) {
      console.log(`Marked ${result.modifiedCount} stale processing job(s) as failed.`);
    }
  } catch (error) {
    console.error('Stale job sweep failed:', error);
  }
}

async function main() {
  await connectToDatabase();

  await sweepStaleJobs();
  setInterval(sweepStaleJobs, STALE_SWEEP_INTERVAL_MS).unref();

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
        meeting.status = 'complete';
        await meeting.save();
      } catch (error) {
        console.error(error);
        const isDeepgramError = error.message?.startsWith('Deepgram API error');
        meeting.status = 'failed';
        meeting.errorMessage = error.clientSafe || isDeepgramError
          ? error.message
          : 'Could not process this file. It may be corrupted, empty, or in an unsupported format.';
        await meeting.save().catch((saveError) => console.error(saveError));
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
