'use server';

import { verifySession } from '@/app/lib/dal';
import { connectToDatabase } from '@/app/lib/db';
import UploadToken from '@/app/lib/models/UploadToken';
import Meeting from '@/app/lib/models/Meeting';
import User from '@/app/lib/models/User';
import { toSummary } from '@/app/lib/meetings';

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes: long enough to start an upload, short enough to bound exposure

// Mints a short-lived, single-use token authorizing one direct upload to
// the separate transcription backend, and creates the Meeting row (status
// 'processing') right now, before any bytes are sent. The actual file
// (which can be large: a full meeting recording) never passes through this
// Next.js app or Vercel's serverless functions - the browser sends it
// straight to the backend, which validates this token before doing any
// work. See backend/server.js for the consuming side.
//
// Creating the Meeting here rather than after the backend receives the
// file means a reload during the raw upload transfer itself - which can
// take a real amount of time for a large recording, and which nothing can
// make resumable since the browser is what's streaming the bytes - still
// leaves a durable 'processing' row behind instead of the job vanishing
// with no trace. If the backend never actually receives the file, the
// stale-job sweep in backend/server.js marks that row 'failed' after 30
// minutes instead of leaving it stuck forever.
export async function createUploadToken(fileName) {
  const { userId } = await verifySession();

  await connectToDatabase();

  const user = await User.findById(userId).select('email webhookUrl').lean();
  if (!user) {
    return { error: 'Your session is no longer valid. Please log in again.' };
  }

  const title = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : undefined;
  const meeting = await Meeting.create({
    userId,
    userEmail: user.email,
    userWebhookUrl: user.webhookUrl || undefined,
    title,
    originalName: title,
    speakerNames: {},
    status: 'processing'
  });

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const tokenDoc = await UploadToken.create({ userId, meetingId: meeting._id, expiresAt });

  const backendUrl = process.env.NEXT_PUBLIC_TRANSCRIBE_BACKEND_URL;
  if (!backendUrl) {
    await meeting.deleteOne().catch(() => {});
    return { error: 'Transcription backend is not configured.' };
  }

  return { token: tokenDoc._id, backendUrl, meeting: toSummary(meeting) };
}
