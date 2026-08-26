const crypto = require('crypto');
const User = require('../models/User');

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Session (browser) and personal-access-token (native/headless clients, e.g.
// the desktop recorder) both authenticate through here. Routes should read
// the resulting user id via getUserId(req), never req.session.userId
// directly, so both auth modes keep working everywhere.
async function requireAuth(req, res, next) {
  if (req.session.userId) {
    return next();
  }

  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (match) {
    try {
      const user = await User.findOne({ apiTokenHash: hashToken(match[1]) });
      if (user) {
        req.userId = user._id;
        return next();
      }
    } catch (error) {
      console.error(error);
    }
  }

  return res.status(401).json({ error: 'You must be signed in.' });
}

function requirePageAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect(302, '/login.html');
  }
  next();
}

function getUserId(req) {
  return req.session.userId || req.userId;
}

module.exports = { requireAuth, requirePageAuth, getUserId, hashToken };
