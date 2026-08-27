import 'server-only';
import { connectToDatabase } from '@/app/lib/db';
import Meeting from '@/app/lib/models/Meeting';

const PREVIEW_LENGTH = 140;

export function toSummary(meeting) {
  const transcript = meeting.transcript || '';
  return {
    id: String(meeting._id),
    title: meeting.title || meeting.originalName || 'Untitled recording',
    originalName: meeting.originalName,
    isVideo: meeting.isVideo,
    durationSeconds: meeting.durationSeconds,
    createdAt: meeting.createdAt.toISOString(),
    preview: transcript.slice(0, PREVIEW_LENGTH)
  };
}

export function toDetail(meeting) {
  return {
    id: String(meeting._id),
    title: meeting.title || meeting.originalName || 'Untitled recording',
    originalName: meeting.originalName,
    isVideo: meeting.isVideo,
    durationSeconds: meeting.durationSeconds,
    transcript: meeting.transcript,
    // Mongoose subdocuments carry an internal circular reference back to
    // their parent document - passing them as-is across the Server-to-
    // Client Component boundary sends React/Next into infinite recursion
    // trying to serialize them. Map to plain objects first.
    utterances: (meeting.utterances || []).map((u) => ({
      speaker: u.speaker,
      start: u.start,
      end: u.end,
      transcript: u.transcript
    })),
    speakerNames: Object.fromEntries(meeting.speakerNames || []),
    shareToken: meeting.shareToken || null,
    createdAt: meeting.createdAt.toISOString()
  };
}

// Escapes user input for safe use inside a RegExp, so a search string like
// "budget (q3)" is matched literally instead of being read as regex syntax.
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function listMeetings(userId, query) {
  await connectToDatabase();
  const filter = { userId };

  const q = typeof query === 'string' ? query.trim() : '';
  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ title: pattern }, { originalName: pattern }, { transcript: pattern }];
  }

  const meetings = await Meeting.find(filter).sort({ createdAt: -1 });
  return meetings.map(toSummary);
}

// Ownership is always enforced here: every meeting query filters by userId.
// Never trust a client-supplied user id.
export async function findOwnedMeeting(id, userId) {
  await connectToDatabase();
  return Meeting.findOne({ _id: id, userId }).catch(() => null);
}

// Public by design: looked up by the random shareToken only, no auth. The
// caller (the /share/[token] page) must never expose the real Mongo _id or
// any owner info from what this returns.
export async function findMeetingByShareToken(token) {
  await connectToDatabase();
  return Meeting.findOne({ shareToken: token }).catch(() => null);
}
