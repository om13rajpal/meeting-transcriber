import 'server-only';
import mongoose from 'mongoose';

// Kept as its own schema (not inline) because it's duplicated verbatim on
// Meeting.userWebhooks (see app/lib/models/Meeting.js) - same relationship
// as utteranceSchema.
export const webhookSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    // 'generic' sends the full raw JSON payload (meeting data, meant for
    // your own automation/agent); the others reshape it into that
    // platform's expected message format - see app/lib/webhook.js.
    format: { type: String, enum: ['generic', 'discord', 'slack', 'teams'], default: 'generic' }
  },
  { _id: false }
);

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
  // Google's profile photo URL, captured at sign-in time (see the OAuth
  // callback route and fetchGoogleProfile in app/lib/oauth.js). Absent for
  // a password-only account; the header falls back to initials.
  avatarUrl: String,
  // POSTed with the transcript when a meeting completes or fails, one
  // request per entry. Denormalized onto Meeting.userWebhooks at creation
  // time (see app/actions/transcribe.js) the same way userEmail is, so the
  // backend can send them without a User model or lookup.
  webhooks: { type: [webhookSchema], default: [] },
  createdAt: { type: Date, default: Date.now }
});

// Reuse the existing compiled model across Next.js dev-mode hot reloads
// instead of registering it again, which mongoose throws on.
export default mongoose.models.User || mongoose.model('User', userSchema);
