'use server';

import { verifySession } from '@/app/lib/dal';
import { connectToDatabase } from '@/app/lib/db';
import UploadToken from '@/app/lib/models/UploadToken';

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes: long enough to start an upload, short enough to bound exposure

// Mints a short-lived, single-use token authorizing one direct upload to
// the separate transcription backend. The actual file (which can be large:
// a full meeting recording) never passes through this Next.js app or
// Vercel's serverless functions - the browser sends it straight to the
// backend, which validates this token before doing any work. See
// backend/server.js for the consuming side.
export async function createUploadToken() {
  const { userId } = await verifySession();

  await connectToDatabase();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const tokenDoc = await UploadToken.create({ userId, expiresAt });

  const backendUrl = process.env.NEXT_PUBLIC_TRANSCRIBE_BACKEND_URL;
  if (!backendUrl) {
    return { error: 'Transcription backend is not configured.' };
  }

  return { token: tokenDoc._id, backendUrl };
}
