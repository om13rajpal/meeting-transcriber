import 'server-only';
import crypto from 'crypto';
import mongoose from 'mongoose';

// One-time, short-lived token that authorizes a single direct-to-backend
// upload. Minted here (behind a real session) and consumed by the separate
// transcription backend, so the browser can upload large files straight to
// it without ever routing them through a Vercel serverless function (which
// has a hard ~4.5MB request body limit). Must match
// backend/models/UploadToken.js - both services read/write the same
// collection.
const uploadTokenSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomBytes(24).toString('hex') },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // The Meeting row is created up front, at mint time, with status
  // 'processing' - not by the backend after it receives the file. That way
  // a reload during the raw upload transfer (before the backend has even
  // received the whole file) still leaves a durable row behind instead of
  // the job vanishing with no trace.
  meetingId: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', required: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
});

export default mongoose.models.UploadToken || mongoose.model('UploadToken', uploadTokenSchema);
