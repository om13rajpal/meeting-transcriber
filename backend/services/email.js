const { Resend } = require('resend');

const EMAIL_TIMEOUT_MS = 10 * 1000;

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('Resend request timed out.')), ms))
  ]);
}

// Best-effort notification that a meeting finished transcribing (or
// failed). Never throws - a broken email integration should never affect
// the transcription pipeline itself, so any failure here is just logged.
// No-ops quietly if RESEND_API_KEY isn't set, so email stays fully
// optional in any environment that hasn't configured it. Returns whether
// it actually sent, so callers can record delivery status on the meeting
// (Meeting.emailLastAttemptOk).
async function sendMeetingEmail(to, meeting) {
  if (!resend || !to) return false;

  const from = process.env.EMAIL_FROM;
  const frontendUrl = process.env.FRONTEND_URL;
  if (!from || !frontendUrl) {
    console.error('sendMeetingEmail: EMAIL_FROM or FRONTEND_URL is not set, skipping.');
    return false;
  }

  const title = meeting.title || meeting.originalName || 'Your recording';
  const link = `${frontendUrl}/meeting/${meeting._id}`;

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
    if (error) {
      console.error('sendMeetingEmail: Resend returned an error:', error);
      return false;
    }
    return true;
  } catch (error) {
    console.error('sendMeetingEmail failed:', error);
    return false;
  }
}

module.exports = { sendMeetingEmail };
