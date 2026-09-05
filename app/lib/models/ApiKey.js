import 'server-only';
import mongoose from 'mongoose';

// A long-lived credential for a non-browser client (the desktop app) to
// mint upload tokens without a browser session cookie. Deliberately
// long-lived, unlike UploadToken - see
// "Authentication for machine clients" in the design spec for why that's
// still a bounded, low-blast-radius grant: it can only ever do what a
// logged-in browser tab can already do (start one transcription job at a
// time), never a general-purpose account credential.
//
// Only the SHA-256 hash of the raw key is ever stored - the raw key is
// shown to the user once, at creation, in app/actions/settings.js, and
// is not recoverable after that (matching how a password is never stored
// in plaintext either).
const apiKeySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  keyHash: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: null }
});

export default mongoose.models.ApiKey || mongoose.model('ApiKey', apiKeySchema);
