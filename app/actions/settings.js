'use server';

import { verifySession } from '@/app/lib/dal';
import { connectToDatabase } from '@/app/lib/db';
import User from '@/app/lib/models/User';

// A basic deterrent, not a hardened SSRF defense: this app is single/
// few-user and the person setting the URL is the account owner pointing
// at their own destination (same trust level as "export my own
// transcript"), not an untrusted third party. This blocks the obvious
// cases (pointing the server's outbound request at itself, a private
// network, or cloud metadata) without building a full DNS-resolution +
// redirect-following SSRF proxy, which would be disproportionate here.
// It does NOT protect against DNS rebinding (a normal-looking hostname
// that resolves to an internal IP only at request time).
function isBlockedWebhookHost(hostname) {
  const lower = hostname.toLowerCase();
  if (lower === 'localhost' || lower.endsWith('.localhost')) return true;

  // IPv4 literal checks: loopback, private ranges, link-local (includes
  // 169.254.169.254, the common cloud metadata endpoint).
  const ipv4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const [a, b] = ipv4.slice(1).map(Number);
    if (a === 127) return true;
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }

  if (lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('[::1]')) return true;

  return false;
}

export async function updateWebhookUrl(rawUrl) {
  const { userId } = await verifySession();
  await connectToDatabase();

  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!trimmed) {
    await User.findByIdAndUpdate(userId, { $unset: { webhookUrl: '' } });
    return { ok: true };
  }

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'Enter a valid URL.' };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { error: 'The URL must start with http:// or https://.' };
  }
  if (isBlockedWebhookHost(parsed.hostname)) {
    return { error: 'This host is not allowed.' };
  }

  await User.findByIdAndUpdate(userId, { webhookUrl: parsed.toString() });
  return { ok: true };
}

export async function getWebhookUrl() {
  const { userId } = await verifySession();
  await connectToDatabase();
  const user = await User.findById(userId).select('webhookUrl').lean();
  return { webhookUrl: user?.webhookUrl || '' };
}
