import 'server-only';
import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  // Not required: an account created via Google sign-in has no password at
  // all, only a linked googleId below. verifyCredentials() in
  // app/actions/auth.js treats a missing passwordHash as "this account
  // can't log in with a password" rather than crashing bcrypt.compare.
  passwordHash: String,
  // Sparse, not unique: uniqueness is already guaranteed by Google itself
  // (it won't hand out the same subject id twice), and a sparse index only
  // needs "no default" - see "Sparse unique indexes need no default" in
  // CLAUDE.md - which doesn't even apply here since this isn't declared
  // unique. It's just indexed for the callback's lookup.
  googleId: { type: String, index: true, sparse: true },
  // Optional: POSTed with the transcript when a meeting completes or
  // fails. Denormalized onto Meeting.userWebhookUrl at creation time (see
  // app/actions/transcribe.js) the same way userEmail is, so the backend
  // can send it without a User model or lookup.
  webhookUrl: String,
  createdAt: { type: Date, default: Date.now }
});

// Reuse the existing compiled model across Next.js dev-mode hot reloads
// instead of registering it again, which mongoose throws on.
export default mongoose.models.User || mongoose.model('User', userSchema);
