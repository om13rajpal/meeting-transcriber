import 'server-only';
import UploadToken from '@/app/lib/models/UploadToken';
import Meeting from '@/app/lib/models/Meeting';
import User from '@/app/lib/models/User';
import { toSummary } from '@/app/lib/meetings';

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes: long enough to start an upload, short enough to bound exposure

// The auth-agnostic core of "mint an upload token and create the Meeting
// row up front" - see CLAUDE.md's "Upload token flow" for why the
// Meeting is created here, before any bytes are sent. Callers
// (app/actions/transcribe.js's createUploadToken for the browser-session
// path, app/api/tokens/upload/route.js for the API-key path) are
// responsible for resolving `userId` through whichever auth mechanism
// they use, then calling this - so there is exactly one place that
// creates a Meeting + UploadToken pair, no matter which client asked.
export async function mintUploadToken({ userId, fileName }) {
  const user = await User.findById(userId).select('email webhooks').lean();
  if (!user) {
    return { error: 'Your session is no longer valid. Please log in again.' };
  }

  const title = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : undefined;
  const meeting = await Meeting.create({
    userId,
    userEmail: user.email,
    userWebhooks: user.webhooks || [],
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
