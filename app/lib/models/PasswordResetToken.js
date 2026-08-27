import 'server-only';
import crypto from 'crypto';
import mongoose from 'mongoose';

// Single-use, short-lived token emailed to a user who requests a password
// reset. Mirrors UploadToken's shape (random _id doubling as the token,
// TTL index for auto-expiry) - see app/lib/models/UploadToken.js.
const passwordResetTokenSchema = new mongoose.Schema({
  _id: { type: String, default: () => crypto.randomBytes(32).toString('hex') },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  createdAt: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true, index: { expires: 0 } }
});

export default mongoose.models.PasswordResetToken || mongoose.model('PasswordResetToken', passwordResetTokenSchema);
