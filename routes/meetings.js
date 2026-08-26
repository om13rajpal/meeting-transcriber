const express = require('express');
const crypto = require('crypto');
const Meeting = require('../models/Meeting');
const { requireAuth, getUserId } = require('../middleware/auth');

const router = express.Router();

router.use(requireAuth);

const PREVIEW_LENGTH = 140;

function toSummary(meeting) {
  const transcript = meeting.transcript || '';
  return {
    id: meeting._id,
    title: meeting.title || meeting.originalName || 'Untitled recording',
    originalName: meeting.originalName,
    isVideo: meeting.isVideo,
    durationSeconds: meeting.durationSeconds,
    createdAt: meeting.createdAt,
    preview: transcript.slice(0, PREVIEW_LENGTH)
  };
}

function toDetail(meeting) {
  return {
    id: meeting._id,
    title: meeting.title || meeting.originalName || 'Untitled recording',
    originalName: meeting.originalName,
    isVideo: meeting.isVideo,
    durationSeconds: meeting.durationSeconds,
    transcript: meeting.transcript,
    utterances: meeting.utterances,
    speakerNames: Object.fromEntries(meeting.speakerNames || []),
    shareToken: meeting.shareToken || null,
    createdAt: meeting.createdAt
  };
}

async function findOwnedMeeting(req) {
  return Meeting.findOne({ _id: req.params.id, userId: getUserId(req) }).catch(() => null);
}

// Escapes user input for safe use inside a RegExp, so a search string like
// "budget (q3)" is matched literally instead of being read as regex syntax.
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

router.get('/', async (req, res) => {
  try {
    const filter = { userId: getUserId(req) };

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (q) {
      const pattern = new RegExp(escapeRegex(q), 'i');
      filter.$or = [{ title: pattern }, { originalName: pattern }, { transcript: pattern }];
    }

    const meetings = await Meeting.find(filter).sort({ createdAt: -1 });
    res.status(200).json(meetings.map(toSummary));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load your meetings.' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const meeting = await findOwnedMeeting(req);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found.' });
    }
    res.status(200).json({ meeting: toDetail(meeting) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load this meeting.' });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const meeting = await findOwnedMeeting(req);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found.' });
    }

    if (typeof req.body.title === 'string') {
      const trimmedTitle = req.body.title.trim();
      if (!trimmedTitle) {
        return res.status(400).json({ error: 'Title cannot be empty.' });
      }
      meeting.title = trimmedTitle;
    }

    const updates = req.body.speakerNames;
    if (updates && typeof updates === 'object') {
      for (const [key, value] of Object.entries(updates)) {
        const trimmed = typeof value === 'string' ? value.trim() : '';
        if (trimmed) {
          meeting.speakerNames.set(key, trimmed);
        } else {
          meeting.speakerNames.delete(key);
        }
      }
      meeting.markModified('speakerNames');
    }

    await meeting.save();

    res.status(200).json({ meeting: toDetail(meeting) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not update this meeting.' });
  }
});

router.post('/:id/share', async (req, res) => {
  try {
    const meeting = await findOwnedMeeting(req);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found.' });
    }
    if (!meeting.shareToken) {
      meeting.shareToken = crypto.randomBytes(24).toString('hex');
      await meeting.save();
    }
    res.status(200).json({ shareToken: meeting.shareToken });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not create a share link.' });
  }
});

router.delete('/:id/share', async (req, res) => {
  try {
    const meeting = await findOwnedMeeting(req);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found.' });
    }
    // Unset (not null) so it drops out of the sparse index instead of
    // colliding with every other un-shared meeting.
    meeting.shareToken = undefined;
    await meeting.save();
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not revoke the share link.' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const meeting = await findOwnedMeeting(req);
    if (!meeting) {
      return res.status(404).json({ error: 'Meeting not found.' });
    }
    await meeting.deleteOne();
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not delete this meeting.' });
  }
});

module.exports = router;
