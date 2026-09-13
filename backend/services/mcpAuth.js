const crypto = require('crypto');
const McpToken = require('../models/McpToken');

// Duplicated from app/lib/apiKeys.js's hashToken() rather than imported -
// this is a separate Node service (CommonJS, no access to the frontend's
// module graph), same reasoning as email.js/webhook.js being duplicated
// per service elsewhere in this app. Any future change to the hashing
// scheme needs to be made in both places.
function hashToken(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// Parses `Authorization: Bearer <token>`, hashes it, looks it up, and
// updates lastUsedAt - the backend's first bearer-token auth mechanism
// (its existing UploadToken/MeetingActionToken flows are single-use
// tokens embedded in a request body, not a standing header credential).
// Returns the found McpToken document, or null for any invalid/missing
// case (no header, malformed header, empty token, no match) - the caller
// decides the exact error shape.
async function authenticateMcpToken(req) {
  const authHeader = req.headers['authorization'] || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) return null;

  const rawKey = match[1].trim();
  if (!rawKey) return null;

  const keyHash = hashToken(rawKey);
  const token = await McpToken.findOne({ keyHash });
  if (!token) return null;

  token.lastUsedAt = new Date();
  await token.save();

  return token;
}

module.exports = { authenticateMcpToken };
