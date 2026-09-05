import 'server-only';
import crypto from 'crypto';
import mongoose from 'mongoose';

// One-time, short-lived token authorizing a single Retry or Cancel against
// a meeting whose raw file is still held on the backend's local disk (see
// pendingFilePath on Meeting). Minted here (behind a real session, after an
// ownership check) and consumed by the backend, which has no session
// mechanism of its own - same pattern as UploadToken, just for a tiny
// server-to-server call instead of a large file transfer. Must match
// backend/models/MeetingActionToken.js - both services read/write the same
// collection.
const meetingActionTokenSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomBytes(24).toString('hex') },
  meetingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', required: true },
  action: { type: String, enum: ['retry', 'cancel'], required: true },
  createdAt: { type: Date, default: Date.now },
  // Short TTL - this is minted and consumed by an immediate server-to-server
  // fetch, not something a user waits minutes to use like UploadToken.
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
});

export default mongoose.models.MeetingActionToken || mongoose.model('MeetingActionToken', meetingActionTokenSchema);
