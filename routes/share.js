const express = require('express');
const Meeting = require('../models/Meeting');

const router = express.Router();

// Public by design: no auth, looked up by the random shareToken only.
// Never expose the real Mongo _id or any owner/user info here. The token
// is the only thing that should let a viewer see this meeting.
router.get('/:token', async (req, res) => {
  try {
    const meeting = await Meeting.findOne({ shareToken: req.params.token });
    if (!meeting) {
      return res.status(404).json({ error: 'This link is invalid or has been revoked.' });
    }

    res.status(200).json({
      meeting: {
        title: meeting.title || meeting.originalName || 'Untitled recording',
        originalName: meeting.originalName,
        isVideo: meeting.isVideo,
        durationSeconds: meeting.durationSeconds,
        transcript: meeting.transcript,
        utterances: meeting.utterances,
        speakerNames: Object.fromEntries(meeting.speakerNames || []),
        createdAt: meeting.createdAt
      }
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load this meeting.' });
  }
});

module.exports = router;
