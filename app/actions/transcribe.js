'use server';

import { verifySession } from '@/app/lib/dal';
import { connectToDatabase } from '@/app/lib/db';
import { mintUploadToken } from '@/app/lib/uploadTokens';

const TOKEN_TTL_MS = 15 * 60 * 1000; // kept here as documentation of the contract; the real value lives in uploadTokens.js

// Mints a short-lived, single-use token authorizing one direct upload to
// the separate transcription backend, and creates the Meeting row
// (status 'processing') right now, before any bytes are sent - see
// mintUploadToken() in app/lib/uploadTokens.js for the shared logic, and
// CLAUDE.md's "Upload token flow" for the full picture. This wrapper's
// only job is resolving the authenticated user from the browser session
// cookie before delegating.
export async function createUploadToken(fileName) {
  const { userId } = await verifySession();
  await connectToDatabase();
  return mintUploadToken({ userId, fileName });
}
