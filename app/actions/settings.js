'use server';

import { verifySession } from '@/app/lib/dal';
import { connectToDatabase } from '@/app/lib/db';
import User from '@/app/lib/models/User';

const VALID_FORMATS = ['generic', 'discord', 'slack', 'teams'];

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

// Replaces the whole list atomically - simpler than granular add/remove
// actions, and the dashboard's dialog already manages the list as local
// state before saving it in one call.
export async function saveWebhooks(rawWebhooks) {
  const { userId } = await verifySession();
  await connectToDatabase();

  const list = Array.isArray(rawWebhooks) ? rawWebhooks : [];
  const cleaned = [];

  for (const entry of list) {
    const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
    if (!url) continue;

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return { error: `"${url}" is not a valid URL.` };
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { error: `"${url}" must start with http:// or https://.` };
    }
    if (isBlockedWebhookHost(parsed.hostname)) {
      return { error: `"${url}": this host is not allowed.` };
    }

    const format = VALID_FORMATS.includes(entry?.format) ? entry.format : 'generic';
    cleaned.push({ url: parsed.toString(), format });
  }

  await User.findByIdAndUpdate(userId, { webhooks: cleaned });
  return { ok: true };
}

export async function getWebhooks() {
  const { userId } = await verifySession();
  await connectToDatabase();
  const user = await User.findById(userId).select('webhooks').lean();
  return { webhooks: user?.webhooks || [] };
}
