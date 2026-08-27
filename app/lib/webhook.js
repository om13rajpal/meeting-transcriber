import 'server-only';

const WEBHOOK_TIMEOUT_MS = 10 * 1000;
// Chat platforms reject or truncate oversized messages; the 'generic'
// format has no limit since it's meant for programmatic consumption, not
// display.
const PREVIEW_LENGTH = 1800;

function truncate(text) {
  if (!text) return '';
  if (text.length <= PREVIEW_LENGTH) return text;
  return `${text.slice(0, PREVIEW_LENGTH)}… (truncated - see the full transcript at the link below)`;
}

function formatTimestamp(sec) {
  if (sec == null) return '';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function speakerLabel(speakerId, speakerNames) {
  return (speakerNames && speakerNames[String(speakerId)]) || `Speaker ${speakerId + 1}`;
}

// Groups consecutive utterances from the same speaker into one line, same
// as buildSpeakerText() in MeetingDetail.js, so the chat notification reads
// the same way the "Transcript" tab does - not the flat wall of text
// meeting.transcript is.
function buildSpeakerTranscript(meeting) {
  const utterances = meeting.utterances || [];
  if (!utterances.length) return meeting.transcript || '';

  const speakerNames = meeting.speakerNames || {};
  const groups = [];
  for (const u of utterances) {
    const last = groups[groups.length - 1];
    if (last && last.speaker === u.speaker) {
      last.transcript += ` ${u.transcript}`;
    } else {
      groups.push({ speaker: u.speaker, start: u.start, transcript: u.transcript });
    }
  }

  return groups
    .map((g) => `${speakerLabel(g.speaker, speakerNames)} [${formatTimestamp(g.start)}]: ${g.transcript}`)
    .join('\n');
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
  const body = isComplete
    ? (truncate(buildSpeakerTranscript(meeting)) || '(no speech detected)')
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
    ? (truncate(buildSpeakerTranscript(meeting)) || '(no speech detected)')
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
    ? (truncate(buildSpeakerTranscript(meeting)) || '(no speech detected)')
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

// Best-effort, like sendMeetingEmail in app/lib/email.js - never throws,
// so a broken or slow webhook endpoint never surfaces as a user-facing
// error for an unrelated action, and one destination failing doesn't stop
// the others (Promise.allSettled, not Promise.all). No-ops quietly if the
// user hasn't configured any webhooks.
export async function sendMeetingWebhook(webhooks, meeting) {
  if (!webhooks || !webhooks.length) return;

  const appUrl = process.env.APP_URL;
  const link = appUrl ? `${appUrl}/meeting/${meeting.id}` : undefined;
  const title = meeting.title || meeting.originalName || 'Untitled recording';

  await Promise.allSettled(
    webhooks.filter((w) => w.url).map((w) => sendOne(w.url, w.format || 'generic', meeting, link, title))
  );
}
