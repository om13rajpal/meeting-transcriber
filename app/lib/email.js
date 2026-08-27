import 'server-only';
import { Resend } from 'resend';

const EMAIL_TIMEOUT_MS = 10 * 1000;

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Resend request timed out.')), ms))
  ]);
}

// Mirrors backend/services/email.js. Needed here too because not every
// failure path goes through the backend: an upload that never reaches it
// at all (bad token, network drop, backend unreachable) is caught and
// marked 'failed' by markMeetingFailed() in app/actions/meetings.js, on
// this side. Never throws - a broken email integration should never
// surface as a user-facing error for an unrelated action. No-ops quietly
// if RESEND_API_KEY isn't set, so email stays fully optional.
export async function sendMeetingEmail(to, meeting) {
  if (!resend || !to) return;

  const from = process.env.EMAIL_FROM;
  const appUrl = process.env.APP_URL;
  if (!from || !appUrl) {
    console.error('sendMeetingEmail: EMAIL_FROM or APP_URL is not set, skipping.');
    return;
  }

  const title = meeting.title || meeting.originalName || 'Your recording';
  const link = `${appUrl}/meeting/${meeting.id}`;

  const isComplete = meeting.status === 'complete';
  const subject = isComplete ? `"${title}" is ready` : `"${title}" failed to transcribe`;
  const text = isComplete
    ? `Your meeting "${title}" has finished transcribing.\n\nView it here: ${link}`
    : `Your meeting "${title}" failed to transcribe.\n\n${meeting.errorMessage || 'An unknown error occurred.'}\n\nYou can delete it and try again: ${link}`;

  try {
    const { error } = await withTimeout(
      resend.emails.send({ from, to, subject, text }),
      EMAIL_TIMEOUT_MS
    );
    if (error) console.error('sendMeetingEmail: Resend returned an error:', error);
  } catch (error) {
    console.error('sendMeetingEmail failed:', error);
  }
}
