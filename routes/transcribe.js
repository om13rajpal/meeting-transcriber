const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

const { requireAuth, getUserId } = require('../middleware/auth');
const { transcribeFile } = require('../services/deepgram');
const Meeting = require('../models/Meeting');

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // raw upload; gets compressed before it ever reaches Deepgram

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname) || ''}`)
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES }
});

router.post('/', requireAuth, (req, res) => {
  upload.single('file')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Upload failed.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded.' });
    }

    try {
      const result = await transcribeFile(req.file.path);

      const meeting = await Meeting.create({
        userId: getUserId(req),
        title: req.file.originalname,
        originalName: req.file.originalname,
        isVideo: result.isVideo,
        durationSeconds: result.durationSeconds,
        transcript: result.transcript,
        utterances: result.utterances,
        speakerNames: {}
      });

      res.status(200).json({
        id: meeting._id,
        originalName: req.file.originalname,
        isVideo: result.isVideo,
        durationSeconds: result.durationSeconds,
        transcript: result.transcript,
        utterances: result.utterances
      });
    } catch (error) {
      console.error(error);
      const isDeepgramError = error.message?.startsWith('Deepgram API error');
      const clientMessage = error.clientSafe || isDeepgramError
        ? error.message
        : 'Could not process this file. It may be corrupted, empty, or in an unsupported format.';
      res.status(500).json({ error: clientMessage });
    }
  });
});

module.exports = router;
