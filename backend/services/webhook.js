const WEBHOOK_TIMEOUT_MS = 10 * 1000;

// Mirrors app/lib/webhook.js on the frontend. Best-effort, never throws.
async function sendMeetingWebhook(url, meeting) {
  if (!url) return;

  const appUrl = process.env.FRONTEND_URL;
  const link = appUrl ? `${appUrl}/meeting/${meeting._id}` : undefined;

  const payload = {
    id: String(meeting._id),
    title: meeting.title || meeting.originalName || 'Untitled recording',
    status: meeting.status,
    errorMessage: meeting.errorMessage || null,
    isVideo: meeting.isVideo ?? null,
    durationSeconds: meeting.durationSeconds ?? null,
    transcript: meeting.transcript || null,
    utterances: meeting.utterances || [],
    speakerNames: meeting.speakerNames instanceof Map ? Object.fromEntries(meeting.speakerNames) : meeting.speakerNames || {},
    link
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    if (!resp.ok) {
      console.error(`sendMeetingWebhook: endpoint returned ${resp.status}`);
    }
  } catch (error) {
    console.error('sendMeetingWebhook failed:', error);
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { sendMeetingWebhook };
