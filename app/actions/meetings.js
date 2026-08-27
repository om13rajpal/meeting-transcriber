'use server';

import crypto from 'crypto';
import { verifySession } from '@/app/lib/dal';
import { findOwnedMeeting, toDetail } from '@/app/lib/meetings';

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
