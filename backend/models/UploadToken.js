const crypto = require('crypto');
const mongoose = require('mongoose');

// One-time, short-lived token that authorizes a single direct-to-backend
// upload. The Next.js app (already behind a real session) mints these via
// createUploadToken(); the browser then sends the raw file straight to this
// backend, bypassing Vercel's serverless payload size limit entirely. Must
// match app/lib/models/UploadToken.js in the Next.js app - both services
// read/write the same collection.
const uploadTokenSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomBytes(24).toString('hex') },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  // TTL index: Mongo auto-deletes the document once this passes, so an
  // unused token can't be replayed after expiry.
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
});

module.exports = mongoose.models.UploadToken || mongoose.model('UploadToken', uploadTokenSchema);
