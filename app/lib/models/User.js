import 'server-only';
import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  createdAt: { type: Date, default: Date.now }
});

// Reuse the existing compiled model across Next.js dev-mode hot reloads
// instead of registering it again, which mongoose throws on.
export default mongoose.models.User || mongoose.model('User', userSchema);
