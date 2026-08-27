import 'server-only';
import crypto from 'crypto';
import mongoose from 'mongoose';

const sessionSchema = new mongoose.Schema({
  // The random token itself is the document id: the cookie holds this
  // value directly, so looking up a session is a single indexed _id read.
  _id: { type: String, default: () => crypto.randomBytes(32).toString('hex') },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  // TTL index: MongoDB automatically deletes the document once this time
  // passes, so expired sessions clean themselves up with no cron job.
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
});

export default mongoose.models.Session || mongoose.model('Session', sessionSchema);
