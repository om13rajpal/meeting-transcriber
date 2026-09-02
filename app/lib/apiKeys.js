import 'server-only';
import crypto from 'crypto';
import ApiKey from '@/app/lib/models/ApiKey';

// Shared with app/actions/settings.js's createApiKey (which hashes the raw
// key exactly once, at creation, to store) and both Route Handlers below
// (which hash an incoming Bearer token to look it up). Previously defined
// three times with the exact same body - one shared definition means a
// future change to the hashing scheme only has one place to make it.
export function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// Parses `Authorization: Bearer <key>`, hashes it, and looks it up. Used by
// both /api/tokens/upload and /api/tokens/mark-failed so their auth
// mechanism can't drift the way it already had (upload/route.js rejected
// an empty-after-trim token with 401; mark-failed/route.js didn't check
// for that case at all before hashing and querying). Returns the found
// ApiKey document with lastUsedAt already updated and saved, or null if
// the header is missing/malformed/empty or no key matches - callers decide
// the exact error message/status for each of those cases themselves, since
// the two routes' error strings are allowed to stay as they are; only the
// mechanism is shared here.
export async function authenticateApiKey(request) {
  const authHeader = request.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return null;
  }
  const rawKey = match[1].trim();
  if (!rawKey) {
    return null;
  }

  const keyHash = hashApiKey(rawKey);
  const apiKey = await ApiKey.findOne({ keyHash });
  if (!apiKey) {
    return null;
  }

  apiKey.lastUsedAt = new Date();
  await apiKey.save();

  return apiKey;
}
