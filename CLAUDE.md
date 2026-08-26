# Meeting Transcriber: Engineering Practices

Local-first app: upload MP4/MP3, extract audio, transcribe Hinglish speech
with Deepgram (Nova-3, `language=multi`), keep a private per-user history in
MongoDB. Email/password auth only. **No AI chat / OpenAI / ChatGPT feature,
do not add one.** "Sign in with ChatGPT" is not a real OAuth flow for
third-party apps; don't build on the unofficial reverse-engineered version.

## Stack

- Node.js + Express, CommonJS, no build step, no frontend framework.
- MongoDB via Mongoose, connection string from `MONGODB_URI` only (never
  hardcoded), local now, swappable to Atlas later without code changes.
- Sessions: `express-session` + `connect-mongo`, `httpOnly` /
  `sameSite: 'lax'` cookies, `secure: true` when `NODE_ENV === 'production'`.
  Passwords: `bcrypt`, cost 12.
- Deepgram requests always include `mip_opt_out=true` (excludes the request
  from their model-training program). Don't remove this for cost reasons
  without asking first.
- Dark theme tokens live in `public/style.css` `:root`, reuse them.

## File layout

- `server.js`: thin entrypoint, session middleware, mounts routers.
- `db.js`: mongoose connection.
- `models/User.js`, `models/Meeting.js`
- `middleware/auth.js`: `requireAuth` (API, 401 JSON) / `requirePageAuth`
  (pages, redirect to `/login`)
- `routes/auth.js`, `routes/meetings.js`, `routes/transcribe.js`, `routes/share.js`
  (public, no auth: looks a meeting up by its random `shareToken` only, never
  exposes the real Mongo `_id` or owner info)
- `services/deepgram.js`: extraction + `transcribeWithRetry`
- `public/`: statically served, unconditionally public: `style.css`,
  shared client JS, `login.html`, `signup.html`. Nothing that requires login
  goes here.
- `views/`: protected page templates, served only through a
  `requirePageAuth` route: `dashboard.html`, `meeting.html`.
- `uploads/`: scratch space, always cleaned up in a `finally`.

## Security (non-negotiable)

- Every meeting query filters by `req.session.userId`. Never trust a
  client-supplied user id. `GET /api/meetings/:id` returns 404 (not 403) for
  a meeting that exists but isn't yours; don't leak existence.
- Never return internals (stack traces, file paths, raw ffmpeg stderr) in an
  API response. Mark an error `{ clientSafe: true }` when its message is
  safe to show; log everything else server-side and return a generic
  message.
- Secrets only via `.env` (`DEEPGRAM_API_KEY`, `MONGODB_URI`,
  `SESSION_SECRET`); `.env.example` documents required vars with no values.
  Fail loudly at startup if `SESSION_SECRET` is missing.
- Frontend: `textContent`/`createElement` only, never `innerHTML` with user-
  or API-sourced data; there's no templating layer escaping it for you.
- Login failure message is always generic ("Invalid email or password"),
  never reveal whether the email exists.

## External API calls

Retry `429`/`5xx` with exponential backoff (respect `Retry-After`), never
retry `4xx`. Every outbound call has a timeout. See `transcribeWithRetry` in
`services/deepgram.js` for the reference pattern.

## Conventions

- Async/await; no bare callbacks.
- Comments explain *why*, not *what*. No speculative abstraction, no config
  for requirements that don't exist yet, no new dependency for something a
  few lines of code covers.
- An optional field with a sparse unique index (e.g. `Meeting.shareToken`)
  must never have a schema `default`, not even `null`. A sparse index only
  skips documents where the field is truly absent; a default writes it into
  every document and the second one collides. Clear such a field with
  `= undefined`, not `= null`.

## Testing

- Verify every feature for real before calling it done: `curl` for API
  endpoints, a real Playwright pass for anything with a UI.
- MongoDB: use plain scripts (`mongosh`, or a small Node script via
  `mongoose`/the driver) to inspect or seed data during testing; no MongoDB
  MCP is installed. If one would genuinely help, ask before installing.
- No Supabase MCP is connected to this project (and this app doesn't use
  Supabase/Postgres); don't reference it.
- Clean up test artifacts (`uploads/` temp files, throwaway test
  users/meetings) after verifying, or state clearly what was left behind.
- `npm audit` should report 0 vulnerabilities after any dependency change.

## Git

Commits only when the user explicitly asks; an initial checkpoint commit
before a large rework is the one standing exception.
