const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const User = require('../models/User');
const { requireAuth, getUserId, hashToken } = require('../middleware/auth');

const router = express.Router();

const BCRYPT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUMMY_HASH = '$2b$12$invalidsaltinvalidsaltinvalidsaltinvalidsaltuu';

// Shared by /login and /token so a native client authenticating with
// email+password gets the exact same timing-safe behavior as the browser.
async function verifyCredentials(email, password) {
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const user = normalizedEmail ? await User.findOne({ email: normalizedEmail }) : null;
  const matches = await bcrypt.compare(typeof password === 'string' ? password : '', user ? user.passwordHash : DUMMY_HASH);
  return matches ? user : null;
}

function regenerateAndSetUserId(req, userId) {
  return new Promise((resolve, reject) => {
    req.session.regenerate((err) => {
      if (err) return reject(err);
      req.session.userId = userId;
      req.session.save((saveErr) => {
        if (saveErr) return reject(saveErr);
        resolve();
      });
    });
  });
}

router.post('/signup', async (req, res) => {
  try {
    const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }

    const existing = await User.findOne({ email });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const user = await User.create({ email, passwordHash });

    await regenerateAndSetUserId(req, user._id);

    res.status(201).json({ email: user.email });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not create your account. Please try again.' });
  }
});

router.post('/login', async (req, res) => {
  try {
    const user = await verifyCredentials(req.body.email, req.body.password);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    await regenerateAndSetUserId(req, user._id);

    res.status(200).json({ email: user.email });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not sign you in. Please try again.' });
  }
});

// Issues a personal access token for non-browser clients (the desktop
// recorder) that can't hold a session cookie. Works two ways: a browser
// that's already logged in can just call this with its session cookie, or a
// headless client can pass {email, password} directly in the body. Either
// way, generating a new token invalidates any previous one (only one active
// token per user, keeping this simple to reason about and to revoke).
router.post('/token', async (req, res) => {
  try {
    let userId = getUserId(req);

    if (!userId) {
      const user = await verifyCredentials(req.body.email, req.body.password);
      if (!user) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }
      userId = user._id;
    }

    const rawToken = crypto.randomBytes(32).toString('hex');
    await User.findByIdAndUpdate(userId, { apiTokenHash: hashToken(rawToken) });

    res.status(200).json({ token: rawToken });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not create a token.' });
  }
});

router.delete('/token', requireAuth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(getUserId(req), { $unset: { apiTokenHash: 1 } });
    res.status(200).json({ ok: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not revoke the token.' });
  }
});

router.post('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: 'Could not log out. Please try again.' });
    }
    res.clearCookie('connect.sid');
    res.status(200).json({ ok: true });
  });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(getUserId(req));
    if (!user) {
      return res.status(401).json({ error: 'You must be signed in.' });
    }
    res.status(200).json({ email: user.email, hasApiToken: Boolean(user.apiTokenHash) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Could not load your account.' });
  }
});

module.exports = router;
