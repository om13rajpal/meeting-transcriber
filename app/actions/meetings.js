'use server';

import crypto from 'crypto';
import { verifySession } from '@/app/lib/dal';
import { connectToDatabase } from '@/app/lib/db';
import Meeting from '@/app/lib/models/Meeting';
import {
  findOwnedMeeting,
  findOwnedMeetingLean,
  toDetail,
  sendNotifications,
  markMeetingFailedCore,
  sweepStaleProcessingMeetings
} from '@/app/lib/meetings';

// Read-only refetch for the meeting detail page's processing-status polling.
// Uses the lean path since nothing here mutates the document. Runs the
// same stale-processing backstop listMeetings() does - this is the other
// place CLAUDE.md documents as polling while a 'processing' row exists,
// so it needs the same chance to notice a stuck one.
export async function getMeeting(id) {
  const { userId } = await verifySession();
  await sweepStaleProcessingMeetings(userId);
  const meeting = await findOwnedMeetingLean(id, userId);
  if (!meeting) {
    return { error: 'Meeting not found.' };
  }
  return { meeting: toDetail(meeting) };
}

export async function updateMeetingTitle(id, title) {
  const { userId } = await verifySession();
  const meeting = await findOwnedMeeting(id, userId);
  if (!meeting) {
    return { error: 'Meeting not found.' };
  }

  const trimmed = typeof title === 'string' ? title.trim() : '';
  if (!trimmed) {
    return { error: 'Title cannot be empty.' };
  }

  meeting.title = trimmed;
  await meeting.save();

  return { meeting: toDetail(meeting) };
}

const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 30;

export async function updateMeetingTags(id, tags) {
  const { userId } = await verifySession();
  const meeting = await findOwnedMeeting(id, userId);
  if (!meeting) {
    return { error: 'Meeting not found.' };
  }

  const cleaned = Array.from(new Set(
    (Array.isArray(tags) ? tags : [])
      .map((t) => (typeof t === 'string' ? t.trim().slice(0, MAX_TAG_LENGTH) : ''))
      .filter(Boolean)
  )).slice(0, MAX_TAGS);

  meeting.tags = cleaned;
  await meeting.save();

  return { meeting: toDetail(meeting) };
}

// Adds one tag to several meetings at once, for the dashboard's multi-select
// bulk action - deliberately just "add", not a full replace like
// updateMeetingTags above, since bulk-editing N meetings' existing tag
// lists in one step isn't a real use case here (see "Meeting tags" in
// CLAUDE.md: simple organization, not a workflow builder). Loops with
// individual .save() calls rather than an updateMany() - each meeting's
// existing tags differ, so the dedupe/cap logic has to run per document.
export async function addTagToMeetings(ids, tag) {
  const { userId } = await verifySession();
  const trimmedTag = typeof tag === 'string' ? tag.trim().slice(0, MAX_TAG_LENGTH) : '';
  if (!trimmedTag) {
    return { error: 'Tag cannot be empty.' };
  }

  const idList = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
  if (!idList.length) {
    return { error: 'No meetings selected.' };
  }

  await connectToDatabase();
  const meetings = await Meeting.find({ _id: { $in: idList }, userId });
  for (const meeting of meetings) {
    meeting.tags = Array.from(new Set([...(meeting.tags || []), trimmedTag])).slice(0, MAX_TAGS);
    await meeting.save();
  }

  return { ok: true, count: meetings.length };
}

export async function updateSpeakerName(id, speakerId, name) {
  const { userId } = await verifySession();
  const meeting = await findOwnedMeeting(id, userId);
  if (!meeting) {
    return { error: 'Meeting not found.' };
  }

  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (trimmed) {
    meeting.speakerNames.set(String(speakerId), trimmed);
  } else {
    meeting.speakerNames.delete(String(speakerId));
  }
  meeting.markModified('speakerNames');
  await meeting.save();

  return { meeting: toDetail(meeting) };
}

// Deepgram's diarization sometimes over-splits a single speaker into
// multiple speaker ids (or, less often, merges two people into one). This
// folds every utterance and speaker name for `fromSpeakerIds` into
// `toSpeakerId`, so a user who notices "4 speakers" but only 2 people
// actually spoke can fix it without re-uploading.
export async function mergeSpeakers(id, fromSpeakerIds, toSpeakerId) {
  const { userId } = await verifySession();
  const meeting = await findOwnedMeeting(id, userId);
  if (!meeting) {
    return { error: 'Meeting not found.' };
  }

  const target = Number(toSpeakerId);
  const sources = new Set((fromSpeakerIds || []).map(Number).filter((n) => Number.isInteger(n) && n !== target));
  if (!Number.isInteger(target) || sources.size === 0) {
    return { error: 'Select at least one speaker to merge.' };
  }

  meeting.utterances.forEach((u) => {
    if (sources.has(u.speaker)) u.speaker = target;
  });
  meeting.markModified('utterances');

  sources.forEach((speakerId) => meeting.speakerNames.delete(String(speakerId)));
  meeting.markModified('speakerNames');

  await meeting.save();
  return { meeting: toDetail(meeting) };
}

// Called by the dashboard right when the direct-to-backend upload request
// itself fails (a rejected token, a network drop, a 4xx/5xx from the
// backend) - the browser already knows this happened synchronously, so
// there's no reason to make the user wait for the 30-minute stale-job
// sweep in backend/server.js to notice. That sweep still exists as a
// backstop for failures the browser never finds out about (the backend
// process dying mid-job after already accepting the file).
//
// A thin verifySession() + delegate wrapper around markMeetingFailedCore()
// in app/lib/meetings.js - the core logic lives there, not here, because
// this file is 'use server': every exported async function here becomes a
// callable Server Action with its own action id, reachable by anyone who
// obtains it, and markMeetingFailedCore() trusts a caller-supplied userId
// directly rather than deriving it from a session. Keeping it in the
// server-only lib file (never 'use server') is what keeps it out of the
// client-reachable server-reference graph; app/api/tokens/mark-failed/route.js
// is the other caller, resolving userId from an API key instead.
export async function markMeetingFailed(id, message) {
  const { userId } = await verifySession();
  return markMeetingFailedCore({ meetingId: id, userId, message });
}

// Manual retry for when the automatic notification on completion/failure
// didn't get through - a wrong webhook URL, a temporary outage, whatever.
// Lets the user fix and retry it themselves without re-uploading just to
// trigger another attempt, and without needing to read the database by
// hand to even find out it failed in the first place.
export async function resendNotifications(id) {
  const { userId } = await verifySession();
  const meeting = await findOwnedMeeting(id, userId);
  if (!meeting) {
    return { error: 'Meeting not found.' };
  }
  if (meeting.status === 'processing') {
    return { error: 'Still processing - nothing to resend yet.' };
  }

  await sendNotifications(meeting);
  return { meeting: toDetail(meeting) };
}

export async function deleteMeeting(id) {
  const { userId } = await verifySession();
  const meeting = await findOwnedMeeting(id, userId);
  if (!meeting) {
    return { error: 'Meeting not found.' };
  }

  await meeting.deleteOne();
  return { ok: true };
}

// Bulk counterpart of deleteMeeting, for the dashboard's multi-select. A
// single deleteMany() rather than a loop of individual deleteOne() calls -
// there's no per-meeting side effect to run (unlike, say, notifications),
// so there's nothing that needs each document loaded first. Still scoped
// by userId in the filter itself, same ownership rule as everywhere else -
// an id for a meeting that isn't yours is silently excluded rather than
// erroring, matching the no-existence-leak rule.
export async function deleteMeetings(ids) {
  const { userId } = await verifySession();
  const idList = Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id) : [];
  if (!idList.length) {
    return { error: 'No meetings selected.' };
  }

  await connectToDatabase();
  const result = await Meeting.deleteMany({ _id: { $in: idList }, userId }).catch(() => null);
  if (!result) {
    return { error: 'Could not delete these meetings.' };
  }
  return { ok: true, deletedCount: result.deletedCount };
}

export async function createShareLink(id) {
  const { userId } = await verifySession();
  const meeting = await findOwnedMeeting(id, userId);
  if (!meeting) {
    return { error: 'Meeting not found.' };
  }

  if (!meeting.shareToken) {
    meeting.shareToken = crypto.randomBytes(24).toString('hex');
    await meeting.save();
  }

  return { shareToken: meeting.shareToken };
}

export async function revokeShareLink(id) {
  const { userId } = await verifySession();
  const meeting = await findOwnedMeeting(id, userId);
  if (!meeting) {
    return { error: 'Meeting not found.' };
  }

  // Unset (not null) so it drops out of the sparse index instead of
  // colliding with every other un-shared meeting.
  meeting.shareToken = undefined;
  await meeting.save();
  return { ok: true };
}
