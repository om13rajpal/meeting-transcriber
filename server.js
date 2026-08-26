require('dotenv').config();

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const path = require('path');

const db = require('./db');
const { requirePageAuth } = require('./middleware/auth');
const authRoutes = require('./routes/auth');
const meetingsRoutes = require('./routes/meetings');
const transcribeRoutes = require('./routes/transcribe');
const shareRoutes = require('./routes/share');

const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET is not set. Add it to .env before starting the server.');
}

async function main() {
  await db.connect();

  const app = express();

  app.use(express.json());
  app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ mongoUrl: process.env.MONGODB_URI }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 30 * 24 * 60 * 60 * 1000
    }
  }));

  app.use(express.static(path.join(__dirname, 'public'), { index: false }));

  app.get('/', requirePageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'dashboard.html'));
  });

  app.get('/meeting/:id', requirePageAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'views', 'meeting.html'));
  });

  // Public, no auth: anyone with the link can view (read-only).
  app.get('/share/:token', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'share.html'));
  });

  app.use('/api/auth', authRoutes);
  app.use('/api/meetings', meetingsRoutes);
  app.use('/api/transcribe', transcribeRoutes);
  app.use('/api/share', shareRoutes);

  app.listen(PORT, () => {
    console.log(`Meeting transcriber running at http://localhost:${PORT}`);
  });
}

main().catch((error) => {
  console.error('Failed to start the server:', error);
  process.exit(1);
});
