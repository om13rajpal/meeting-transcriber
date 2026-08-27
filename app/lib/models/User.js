import 'server-only';
import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
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
