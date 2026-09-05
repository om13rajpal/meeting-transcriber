const crypto = require('crypto');
const mongoose = require('mongoose');

// One-time, short-lived token authorizing a single Retry or Cancel against
// a meeting whose raw file is still held on this backend's local disk (see
// pendingFilePath on Meeting). The Next.js app mints these (behind a real
// session, after an ownership check) via retryMeeting()/cancelMeeting() in
// app/actions/meetings.js; this backend consumes them, since it has no
// session mechanism of its own. Must match
// app/lib/models/MeetingActionToken.js in the Next.js app - both services
// read/write the same collection.
const meetingActionTokenSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomBytes(24).toString('hex') },
  meetingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', required: true },
  action: { type: String, enum: ['retry', 'cancel'], required: true },
  createdAt: { type: Date, default: Date.now },
  // TTL index: Mongo auto-deletes the document once this passes, so an
  // unused token can't be replayed after expiry.
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
});

module.exports = mongoose.models.MeetingActionToken || mongoose.model('MeetingActionToken', meetingActionTokenSchema);
