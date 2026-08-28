import 'server-only';
import { connectToDatabase } from '@/app/lib/db';
import Meeting from '@/app/lib/models/Meeting';

const PREVIEW_LENGTH = 140;
const SNIPPET_CONTEXT_CHARS = 60;

// speakerNames arrives as a real Mongoose Map when `meeting` came from a
// live (non-lean) document - e.g. a mutation Server Action that just called
// .save() and is handing the result back to the client. It arrives as a
// plain object when `meeting` came from a .lean() read, since lean() never
// wraps Map-typed fields in the first place.
function speakerNamesToPlainObject(speakerNames) {
  if (speakerNames instanceof Map) return Object.fromEntries(speakerNames);
  return speakerNames || {};
}

// When a search query matches inside the transcript, show the text around
// that match instead of always the first PREVIEW_LENGTH characters - a hit
// deep into a long meeting is otherwise invisible in the dashboard preview.
// Returns null (falls back to the plain prefix slice) if the query isn't
// found in the transcript at all - e.g. it matched the title or a tag
// instead, which are already visible elsewhere on the row.
function buildSnippet(transcript, query) {
  if (!transcript || !query) return null;
  const idx = transcript.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;

  const start = Math.max(0, idx - SNIPPET_CONTEXT_CHARS);
  const end = Math.min(transcript.length, idx + query.length + SNIPPET_CONTEXT_CHARS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < transcript.length ? '…' : '';
  return `${prefix}${transcript.slice(start, end).trim()}${suffix}`;
}

// `query` is optional and only passed by listMeetings() - every other
// caller (createUploadToken, the polling refresh in Dashboard.js's
// non-search path, etc.) just gets the plain prefix preview as before.
export function toSummary(meeting, query) {
  const transcript = meeting.transcript || '';
  const trimmedQuery = typeof query === 'string' ? query.trim() : '';
  const snippet = trimmedQuery ? buildSnippet(transcript, trimmedQuery) : null;
  return {
    id: String(meeting._id),
    title: meeting.title || meeting.originalName || 'Untitled recording',
    originalName: meeting.originalName,
    isVideo: meeting.isVideo,
    durationSeconds: meeting.durationSeconds,
    createdAt: meeting.createdAt.toISOString(),
    preview: snippet || transcript.slice(0, PREVIEW_LENGTH),
    status: meeting.status || 'complete',
    errorMessage: meeting.errorMessage || null,
    tags: meeting.tags || [],
    deepgramModel: meeting.deepgramModel || null,
    deepgramCostUsd: meeting.deepgramCostUsd ?? null,
    deepgramCostExact: Boolean(meeting.deepgramCostExact)
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
    createdAt: meeting.createdAt.toISOString(),
    tags: meeting.tags || [],
    deepgramModel: meeting.deepgramModel || null,
    deepgramCostUsd: meeting.deepgramCostUsd ?? null,
    deepgramCostExact: Boolean(meeting.deepgramCostExact),
    // Delivery status per notification channel, so a silently failed
    // webhook/email is visible on the page instead of requiring a
    // database lookup to notice - see resendNotifications() in
    // app/actions/meetings.js. `ok: null` means never attempted yet (e.g.
    // configured after this meeting already completed).
    notifications: {
      email: meeting.userEmail
        ? { attemptedAt: meeting.emailLastAttemptAt ? meeting.emailLastAttemptAt.toISOString() : null, ok: meeting.emailLastAttemptOk ?? null }
        : null,
      webhooks: (meeting.userWebhooks || []).map((w) => ({
        format: w.format,
        attemptedAt: w.lastAttemptAt ? w.lastAttemptAt.toISOString() : null,
        ok: w.lastAttemptOk ?? null
      }))
    }
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
    // Mongo matches a regex/equality against an array field if any element
    // matches, so this needs no $elemMatch to search tags the same way as
    // the other text fields.
    filter.$or = [{ title: pattern }, { originalName: pattern }, { transcript: pattern }, { tags: pattern }];
  }

  const meetings = await Meeting.find(filter)
    .select('-utterances')
    .sort({ createdAt: -1 })
    .lean();
  return meetings.map((m) => toSummary(m, q));
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

// Total minutes/cost transcribed this calendar month, for the "This month"
// line on the dashboard. Approximate by nature (a rough usage estimate,
// not a real billing sync with Deepgram, and "calendar month" may not line
// up with your actual billing cycle) - fine at this app's scale, and small
// enough to sum in Node rather than a database aggregation pipeline,
// matching listKnownSpeakerNames() above.
export async function getUsageSummary(userId) {
  await connectToDatabase();
  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const meetings = await Meeting.find({ userId, status: 'complete', createdAt: { $gte: startOfMonth } })
    .select('durationSeconds deepgramCostUsd')
    .lean();

  const totalSeconds = meetings.reduce((sum, m) => sum + (m.durationSeconds || 0), 0);
  const totalCostUsd = meetings.reduce((sum, m) => sum + (m.deepgramCostUsd || 0), 0);
  return { minutes: Math.round(totalSeconds / 60), costUsd: totalCostUsd, count: meetings.length };
}
