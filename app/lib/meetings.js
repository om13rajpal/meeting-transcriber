import 'server-only';
import { connectToDatabase } from '@/app/lib/db';
import Meeting from '@/app/lib/models/Meeting';

const PREVIEW_LENGTH = 140;

// speakerNames arrives as a real Mongoose Map when `meeting` came from a
// live (non-lean) document - e.g. a mutation Server Action that just called
// .save() and is handing the result back to the client. It arrives as a
// plain object when `meeting` came from a .lean() read, since lean() never
// wraps Map-typed fields in the first place.
function speakerNamesToPlainObject(speakerNames) {
  if (speakerNames instanceof Map) return Object.fromEntries(speakerNames);
  return speakerNames || {};
}

export function toSummary(meeting) {
  const transcript = meeting.transcript || '';
  return {
    id: String(meeting._id),
    title: meeting.title || meeting.originalName || 'Untitled recording',
    originalName: meeting.originalName,
    isVideo: meeting.isVideo,
    durationSeconds: meeting.durationSeconds,
    createdAt: meeting.createdAt.toISOString(),
    preview: transcript.slice(0, PREVIEW_LENGTH),
    status: meeting.status || 'complete',
    errorMessage: meeting.errorMessage || null
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
    // Mongoose subdocuments (from a non-lean document) carry an internal
    // circular reference back to their parent and would send React/Next
    // into infinite recursion trying to serialize them across the
    // Server-to-Client Component boundary. A plain .map() extracts just
    // the fields we need either way - harmless no-op when `utterances` is
    // already plain (a .lean() read), required when it isn't.
    utterances: (meeting.utterances || []).map((u) => ({
      speaker: u.speaker,
      start: u.start,
      end: u.end,
      transcript: u.transcript
    })),
    speakerNames: speakerNamesToPlainObject(meeting.speakerNames),
    shareToken: meeting.shareToken || null,
    status: meeting.status || 'complete',
    errorMessage: meeting.errorMessage || null,
    createdAt: meeting.createdAt.toISOString()
  };
}

// Escapes user input for safe use inside a RegExp, so a search string like
// "budget (q3)" is matched literally instead of being read as regex syntax.
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Read-only: .lean() skips Mongoose document hydration (faster, and the
// result has no circular references to begin with), and excluding
// utterances keeps the list query from pulling potentially large
// transcript-timing data over the wire for rows that only show a preview.
export async function listMeetings(userId, query) {
  await connectToDatabase();
  const filter = { userId };

  const q = typeof query === 'string' ? query.trim() : '';
  if (q) {
    const pattern = new RegExp(escapeRegex(q), 'i');
    filter.$or = [{ title: pattern }, { originalName: pattern }, { transcript: pattern }];
  }

  const meetings = await Meeting.find(filter)
    .select('-utterances')
    .sort({ createdAt: -1 })
    .lean();
  return meetings.map(toSummary);
}

// Ownership is always enforced here: every meeting query filters by userId.
// Never trust a client-supplied user id. Returns a live document (not
// lean) because callers use this to mutate and .save().
export async function findOwnedMeeting(id, userId) {
  await connectToDatabase();
  return Meeting.findOne({ _id: id, userId }).catch(() => null);
}

// Read-only counterpart of findOwnedMeeting, for pages that just display a
// meeting rather than mutate it (the meeting detail page's initial load).
export async function findOwnedMeetingLean(id, userId) {
  await connectToDatabase();
  return Meeting.findOne({ _id: id, userId }).lean().catch(() => null);
}

// Public by design: looked up by the random shareToken only, no auth. The
// caller (the /share/[token] page) must never expose the real Mongo _id or
// any owner info from what this returns.
export async function findMeetingByShareToken(token) {
  await connectToDatabase();
  return Meeting.findOne({ shareToken: token }).lean().catch(() => null);
}

// Every name this user has typed into a speaker-rename box across all
// their meetings, deduplicated - purely for autocomplete suggestions on
// the next meeting's rename input, not automatic recognition (nothing here
// knows which speaker in a new recording is which person, it just saves
// retyping a name you've used before). Small enough at this app's scale to
// aggregate in Node rather than a database pipeline.
export async function listKnownSpeakerNames(userId) {
  await connectToDatabase();
  const meetings = await Meeting.find({ userId }).select('speakerNames').lean();
  const names = new Set();
  for (const meeting of meetings) {
    for (const name of Object.values(meeting.speakerNames || {})) {
      if (name) names.add(name);
    }
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}
