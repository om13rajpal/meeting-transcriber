// Mirrors app/lib/webhook.js on the frontend.

const WEBHOOK_TIMEOUT_MS = 10 * 1000;
const PREVIEW_LENGTH = 1800;

function truncate(text) {
  if (!text) return '';
  if (text.length <= PREVIEW_LENGTH) return text;
  return `${text.slice(0, PREVIEW_LENGTH)}… (truncated - see the full transcript at the link below)`;
}

function speakerNamesToPlainObject(speakerNames) {
  if (speakerNames instanceof Map) return Object.fromEntries(speakerNames);
  return speakerNames || {};
}

function buildGenericPayload(meeting, link) {
  return {
    id: String(meeting._id),
    title: meeting.title || meeting.originalName || 'Untitled recording',
    status: meeting.status,
    errorMessage: meeting.errorMessage || null,
    isVideo: meeting.isVideo ?? null,
    durationSeconds: meeting.durationSeconds ?? null,
    transcript: meeting.transcript || null,
    utterances: meeting.utterances || [],
    speakerNames: speakerNamesToPlainObject(meeting.speakerNames),
    link
  };
}

// https://discord.com/developers/docs/resources/webhook#execute-webhook
function buildDiscordPayload(meeting, link, title) {
  const isComplete = meeting.status === 'complete';
  const body = isComplete
    ? (truncate(meeting.transcript) || '(no speech detected)')
    : (meeting.errorMessage || 'An unknown error occurred.');
  return {
    embeds: [{
      title: isComplete ? `"${title}" is ready` : `"${title}" failed to transcribe`,
      description: body,
      url: link,
      color: isComplete ? 0x22c55e : 0xef4444
    }]
  };
}

// https://api.slack.com/messaging/webhooks
function buildSlackPayload(meeting, link, title) {
  const isComplete = meeting.status === 'complete';
  const body = isComplete
    ? (truncate(meeting.transcript) || '(no speech detected)')
    : (meeting.errorMessage || 'An unknown error occurred.');
  const heading = isComplete ? `*"${title}" is ready*` : `*"${title}" failed to transcribe*`;
  return { text: [heading, body, link].filter(Boolean).join('\n') };
}

// MessageCard format: the Office 365 connector webhooks this originally
// targeted were retired in Teams (May 2026), but their replacement -
// Workflows webhooks, set up via Power Automate - still accepts this same
// payload shape without any reformatting.
function buildTeamsPayload(meeting, link, title) {
  const isComplete = meeting.status === 'complete';
  const text = isComplete
    ? (truncate(meeting.transcript) || '(no speech detected)')
    : (meeting.errorMessage || 'An unknown error occurred.');
  return {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: isComplete ? '22c55e' : 'ef4444',
    summary: isComplete ? `"${title}" is ready` : `"${title}" failed to transcribe`,
    sections: [{ activityTitle: title, text }],
    potentialAction: link ? [{ '@type': 'OpenUri', name: 'View meeting', targets: [{ os: 'default', uri: link }] }] : []
  };
}

function buildPayload(format, meeting, link, title) {
  if (format === 'discord') return buildDiscordPayload(meeting, link, title);
  if (format === 'slack') return buildSlackPayload(meeting, link, title);
  if (format === 'teams') return buildTeamsPayload(meeting, link, title);
  return buildGenericPayload(meeting, link);
}

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
  } catch (error) {
    console.error(`sendMeetingWebhook (${format}) failed:`, error);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendMeetingWebhook(webhooks, meeting) {
  if (!webhooks || !webhooks.length) return;

  const appUrl = process.env.FRONTEND_URL;
  const link = appUrl ? `${appUrl}/meeting/${meeting._id}` : undefined;
  const title = meeting.title || meeting.originalName || 'Untitled recording';

  await Promise.allSettled(
    webhooks.filter((w) => w.url).map((w) => sendOne(w.url, w.format || 'generic', meeting, link, title))
  );
}

module.exports = { sendMeetingWebhook };
