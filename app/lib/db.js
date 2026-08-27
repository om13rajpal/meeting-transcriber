import 'server-only';
import mongoose from 'mongoose';

// Cache the connection on `global` so Next.js's dev-mode module reloading
// doesn't open a fresh MongoDB connection on every hot reload.
const cached = (global.__mongooseConnection ??= { conn: null, promise: null });

export async function connectToDatabase() {
  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGODB_URI is not set. Add it to .env before starting the server.');
    }
    cached.promise = mongoose.connect(uri).then((mongooseInstance) => mongooseInstance);
  }

  cached.conn = await cached.promise;
  return cached.conn;
}
