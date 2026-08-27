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

async function send({ to, subject, text }) {
  if (!resend || !to) return false;

  const from = process.env.EMAIL_FROM;
  if (!from) {
    console.error('email.js: EMAIL_FROM is not set, skipping.');
    return false;
  }

  try {
    const { error } = await withTimeout(resend.emails.send({ from, to, subject, text }), EMAIL_TIMEOUT_MS);
    if (error) {
      console.error('email.js: Resend returned an error:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('email.js: send failed:', error);
    return false;
  }
}

// Mirrors backend/services/email.js. Needed here too because not every
// failure path goes through the backend: an upload that never reaches it
// at all (bad token, network drop, backend unreachable) is caught and
// marked 'failed' by markMeetingFailed() in app/actions/meetings.js, on
// this side. Never throws - a broken email integration should never
// surface as a user-facing error for an unrelated action. No-ops quietly
// if RESEND_API_KEY isn't set, so email stays fully optional. Returns
// whether it actually sent, so callers can record delivery status on the
// meeting (see Meeting.emailLastAttemptOk) - the whole reason this returns
// a value now instead of being pure fire-and-forget.
export async function sendMeetingEmail(to, meeting) {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    console.error('sendMeetingEmail: APP_URL is not set, skipping.');
    return false;
  }

  const title = meeting.title || meeting.originalName || 'Your recording';
  const link = `${appUrl}/meeting/${meeting.id}`;

  const isComplete = meeting.status === 'complete';
  const subject = isComplete ? `"${title}" is ready` : `"${title}" failed to transcribe`;
  const text = isComplete
    ? `Your meeting "${title}" has finished transcribing.\n\nView it here: ${link}`
    : `Your meeting "${title}" failed to transcribe.\n\n${meeting.errorMessage || 'An unknown error occurred.'}\n\nYou can delete it and try again: ${link}`;

  return send({ to, subject, text });
}

// Best-effort like sendMeetingEmail above. requestPasswordReset() in
// app/actions/auth.js always returns the same generic response regardless
// of whether this succeeds (or whether the account even exists), so a
// delivery failure here never leaks anything - it just means the user
// doesn't get the email, logged server-side for debugging.
export async function sendPasswordResetEmail(to, token) {
  const appUrl = process.env.APP_URL;
  if (!appUrl) {
    console.error('sendPasswordResetEmail: APP_URL is not set, skipping.');
    return;
  }

  const link = `${appUrl}/reset-password/${token}`;
  const subject = 'Reset your Meeting Transcriber password';
  const text = `Someone requested a password reset for this account.\n\nReset it here (expires in 1 hour): ${link}\n\nIf this wasn't you, you can ignore this email.`;

  await send({ to, subject, text });
}
