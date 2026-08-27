import 'server-only';

const WEBHOOK_TIMEOUT_MS = 10 * 1000;

// The chat formats (Discord/Slack/Teams) are a notification, not a
// transcript dump - just enough to know it's ready and a link to go read
// it in the app. Only 'generic' carries the actual transcript/utterances,
// since that one's for the user's own automation, not for a human to read
// in a chat window.
function chatMessageBody(meeting, title, link) {
  if (meeting.status === 'complete') {
    return `Hi! Your transcript for "${title}" is ready.${link ? ` ${link}` : ''}`;
  }
  const reason = meeting.errorMessage || 'An unknown error occurred.';
  return `Hi! Your transcript for "${title}" failed to generate.\n${reason}${link ? ` ${link}` : ''}`;
}

function buildGenericPayload(meeting, link) {
  return {
    id: meeting.id,
    title: meeting.title || meeting.originalName || 'Untitled recording',
    status: meeting.status,
    errorMessage: meeting.errorMessage || null,
    isVideo: meeting.isVideo ?? null,
    durationSeconds: meeting.durationSeconds ?? null,
    transcript: meeting.transcript || null,
    utterances: meeting.utterances || [],
    speakerNames: meeting.speakerNames || {},
    link
  };
}

// https://discord.com/developers/docs/resources/webhook#execute-webhook
function buildDiscordPayload(meeting, link, title) {
  const isComplete = meeting.status === 'complete';
  return {
    embeds: [{
      title: isComplete ? `"${title}" is ready` : `"${title}" failed to transcribe`,
      description: chatMessageBody(meeting, title, link),
      url: link,
      color: isComplete ? 0x22c55e : 0xef4444
    }]
  };
}

// https://api.slack.com/messaging/webhooks
function buildSlackPayload(meeting, link, title) {
  return { text: chatMessageBody(meeting, title, link) };
}

// MessageCard format: the Office 365 connector webhooks this originally
// targeted were retired in Teams (May 2026), but their replacement -
// Workflows webhooks, set up via Power Automate - still accepts this same
// payload shape without any reformatting.
function buildTeamsPayload(meeting, link, title) {
  const isComplete = meeting.status === 'complete';
  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: isComplete ? '22c55e' : 'ef4444',
    summary: isComplete ? `"${title}" is ready` : `"${title}" failed to transcribe`,
    sections: [{ activityTitle: title, text: chatMessageBody(meeting, title, link) }],
    potentialAction: link ? [{ '@type': 'OpenUri', name: 'View meeting', targets: [{ os: 'default', uri: link }] }] : []
  };
}

function buildPayload(format, meeting, link, title) {
  if (format === 'discord') return buildDiscordPayload(meeting, link, title);
  if (format === 'slack') return buildSlackPayload(meeting, link, title);
  if (format === 'teams') return buildTeamsPayload(meeting, link, title);
  return buildGenericPayload(meeting, link);
}

// Returns { url, ok, status } rather than throwing - status is the HTTP
// response code when the endpoint answered at all (0 for a network
// failure/timeout, which never got a response to have a status).
async function sendOne(url, format, meeting, link, title) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(format, meeting, link, title)),
      signal: controller.signal
    });
    if (!resp.ok) {
      console.error(`sendMeetingWebhook (${format}): endpoint returned ${resp.status}`);
    }
    return { url, ok: resp.ok, status: resp.status };
  } catch (error) {
    console.error(`sendMeetingWebhook (${format}) failed:`, error);
    return { url, ok: false, status: 0 };
  } finally {
    clearTimeout(timeoutId);
  }
}

// Best-effort, like sendMeetingEmail in app/lib/email.js - never throws,
// so a broken or slow webhook endpoint never surfaces as a user-facing
// error for an unrelated action, and one destination failing doesn't stop
// the others (Promise.allSettled, not Promise.all). No-ops quietly if the
// user hasn't configured any webhooks. Returns one { url, ok, status } per
// entry in `webhooks`, so callers can record delivery status on the
// meeting (Meeting.userWebhooks[].lastAttemptOk) - the whole reason this
// returns anything instead of being pure fire-and-forget.
export async function sendMeetingWebhook(webhooks, meeting) {
  if (!webhooks || !webhooks.length) return [];

  const appUrl = process.env.APP_URL;
  const link = appUrl ? `${appUrl}/meeting/${meeting.id}` : undefined;
  const title = meeting.title || meeting.originalName || 'Untitled recording';

  const settled = await Promise.allSettled(
    webhooks.filter((w) => w.url).map((w) => sendOne(w.url, w.format || 'generic', meeting, link, title))
  );
  // sendOne never rejects (it catches everything itself), so every entry
  // here is a fulfilled promise - .map() to unwrap rather than needing to
  // handle a 'rejected' branch that can't actually occur.
  return settled.map((result) => result.value);
}
