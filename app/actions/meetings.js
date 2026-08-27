'use server';

import crypto from 'crypto';
import { verifySession } from '@/app/lib/dal';
import { findOwnedMeeting, findOwnedMeetingLean, toDetail } from '@/app/lib/meetings';
import { sendMeetingEmail } from '@/app/lib/email';
import { sendMeetingWebhook } from '@/app/lib/webhook';

// Read-only refetch for the meeting detail page's processing-status polling.
// Uses the lean path since nothing here mutates the document.
export async function getMeeting(id) {
  const { userId } = await verifySession();
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
export async function markMeetingFailed(id, message) {
  const { userId } = await verifySession();
  const meeting = await findOwnedMeeting(id, userId);
  if (!meeting || meeting.status !== 'processing') {
    return { ok: false };
  }

  meeting.status = 'failed';
  meeting.errorMessage = typeof message === 'string' && message ? message : 'Upload failed. Please try again.';
  await meeting.save();
  const detail = toDetail(meeting);
  await sendMeetingEmail(meeting.userEmail, detail);
  await sendMeetingWebhook(meeting.userWebhooks, detail);
  return { ok: true };
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
