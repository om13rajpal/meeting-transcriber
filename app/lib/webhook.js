import 'server-only';

const WEBHOOK_TIMEOUT_MS = 10 * 1000;

// Best-effort, like sendMeetingEmail in app/lib/email.js - never throws,
// so a broken or slow webhook endpoint never surfaces as a user-facing
// error for an unrelated action. No-ops quietly if the user hasn't set a
// webhookUrl.
export async function sendMeetingWebhook(url, meeting) {
  if (!url) return;

  const appUrl = process.env.APP_URL;
  const link = appUrl ? `${appUrl}/meeting/${meeting.id}` : undefined;

  const payload = {
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
