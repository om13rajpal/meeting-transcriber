# Meeting Transcriber: Engineering Practices

Two deployed services, not one:

- **Frontend (this directory, `/`)**: Next.js 16 (App Router), deployed on
  Vercel. Auth, dashboard, meeting history, search, share links, speaker
  rename. All small JSON operations against MongoDB.
- **Backend (`backend/`)**: a standalone Express service, deployed on Render
  via Docker. Handles the one thing Vercel's serverless functions cannot:
  receiving a large file upload, running ffmpeg, and calling Deepgram. See
  `backend/CLAUDE.md`-equivalent notes below and the file itself.

Upload MP4/MP3, extract audio, transcribe Hinglish speech with Deepgram
(Nova-3, `language=multi`), keep a private per-user history in MongoDB.
Email/password auth only. **No AI chat / OpenAI / ChatGPT feature, do not
add one.** "Sign in with ChatGPT" is not a real OAuth flow for third-party
apps.

## Why two services: Vercel's serverless payload limit

Vercel Functions (including Server Actions, which are just POST requests
under the hood) have a **hard 4.5MB request body limit** that cannot be
raised by any application-level config. A meeting recording is routinely
much larger than that. Vercel's own official guidance is also that
ffmpeg-based video processing is a poor fit for serverless functions at all
(no ffmpeg binary by default, tight `/tmp` and duration limits). So:

- The browser uploads the file **directly** to the Render backend,
  never through Vercel. See "Upload token flow" below for how that's
  authorized.
- The backend does the ffmpeg + Deepgram work on a normal long-running
  process with a real filesystem, no serverless constraints.
- `next.config.mjs` has no `serverActions.bodySizeLimit` override, because
  no Server Action ever receives the file. If you're tempted to add a big
  file upload back into a Server Action, don't. It will hit the 4.5MB wall
  in production even though it works fine in local dev (which has no such
  limit).

## Upload token flow

1. The dashboard calls `createUploadToken()` (a Server Action, behind
   `verifySession()`, so it's a real authenticated call) which mints a
   random, single-use, 15-minute token in the `uploadtokens` collection and
   returns it plus the backend's URL
   (`NEXT_PUBLIC_TRANSCRIBE_BACKEND_URL`).
2. The browser then does a plain `fetch()` directly to
   `${backendUrl}/api/transcribe` with the file and the token in one
   multipart form, bypassing this Next.js app entirely.
3. The backend looks up the token (`findByIdAndDelete`, so it's consumed
   immediately and can't be replayed), extracts the `userId`, runs the
   ffmpeg + Deepgram pipeline, and writes the `Meeting` document straight to
   MongoDB.
4. The browser gets back `{ id }`, then just calls the normal
   `searchMeetings()` Server Action to refresh the dashboard list.

The `UploadToken` model (`app/lib/models/UploadToken.js` here,
`backend/models/UploadToken.js` on the backend) and the `Meeting` model
must stay schema-identical between the two services since they share one
MongoDB database. If you change one, change the other.

## Stack (frontend)

- Next.js 16 (App Router), React 19, JavaScript (no TypeScript).
- Server Components for reads, Server Actions for every mutation except the
  file upload itself (see above). There are deliberately **no Route
  Handlers** in this app.
- MongoDB via Mongoose, connection string from `MONGODB_URI` only, cached on
  `global` in `app/lib/db.js` so Next's dev-mode hot reload doesn't open a
  new connection per edit.
- Sessions: a random token stored in a MongoDB `sessions` collection (TTL
  index for auto-expiry), the cookie holds only that opaque token. No JWT,
  no `SESSION_SECRET` needed, nothing to sign, since the cookie carries no
  data of its own, just a lookup key. See `app/lib/session.js`.
- `app/lib/dal.js`'s `verifySession()` is the auth boundary for every
  protected Server Component/Action: it redirects to `/login` if there's no
  valid session. Call it first, every time.
- UI: shadcn/ui (Base UI primitives, not Radix) + Tailwind v4. Always dark
  (`className="dark"` on `<html>`, no toggle).

## Stack (backend, `backend/`)

- Plain Node + Express, CommonJS, no framework beyond that.
- Deployed via the Dockerfile in `backend/` (installs ffmpeg at the OS
  layer with `apt-get`, since neither Render's default runtime nor the
  base Node image includes it).
- `cors` restricted to an explicit allow-list (`ALLOWED_ORIGINS` env var,
  comma-separated), not a wildcard, since this endpoint writes to the
  database.
- Deepgram requests always include `mip_opt_out=true` (excludes the request
  from their model-training program). Don't remove this for cost reasons
  without asking first.

## shadcn is Base UI, not Radix, don't guess the API

This project's shadcn components (`components/ui/*`) are built on
`@base-ui/react`, not Radix. The two have different polymorphism APIs:

- Use `render={<Component />}` (a childless element conveying which tag/
  component to render as), never `asChild`. `asChild` silently does nothing
  useful, then throws hydration/DOM-nesting errors at runtime.
- `DropdownMenuLabel` must be inside a `DropdownMenuGroup`, or it throws
  "MenuGroupContext is missing."
- When rendering a `Button` as a non-button element (e.g. an anchor via
  `render={<a href="..." />}`), also pass `nativeButton={false}`, or Base UI
  warns about broken button semantics.

If unsure about a Base UI component's API, read the actual file in
`components/ui/` (small, readable) rather than assuming Radix conventions
from memory or training data.

## The Mongoose-to-Client-Component trap

A Mongoose document's array fields (e.g. `Meeting.utterances`) are
`DocumentArray`s of subdocuments carrying an internal circular reference
back to their parent document. Passing one directly as a prop from a Server
Component to a Client Component (or returning one from a Server Action)
sends React/Next into infinite recursion trying to serialize it
("Maximum call stack size exceeded", often with a confusingly generic
stack). Always map Mongoose data to plain objects before it crosses that
boundary. See `toDetail()`/`toSummary()` in `app/lib/meetings.js` for the
pattern to follow for any new field.

## Hydration: locale-sensitive formatting must be pinned

`Date.prototype.toLocaleString(undefined, ...)` (or any locale-dependent
formatting call) can render differently on the server (Node's locale) than
in the browser during hydration, throwing a hydration mismatch. Always pass
an explicit locale (e.g. `'en-US'`) in any Client Component that formats a
date, time, or number that also gets server-rendered.

## Sparse unique indexes need no `default`

`Meeting.shareToken` and `UploadToken`'s own expiry pattern both rely on a
sparse unique index. A sparse index only excludes documents where the field
is truly *absent* - a schema `default` (even `null`) writes the field into
every document, and the second one collides. Never add a `default` to a
sparse-unique field; clear it with `= undefined`, not `= null`.

## File layout

- `app/lib/db.js`: mongoose connection.
- `app/lib/models/User.js`, `Meeting.js`, `Session.js`, `UploadToken.js`
- `app/lib/session.js`: cookie/session primitives (`createSession`,
  `getSessionUserId`, `deleteSession`).
- `app/lib/dal.js`: `verifySession()`, the auth boundary.
- `app/lib/meetings.js`: `toSummary`/`toDetail` (plain-object conversion,
  see above), `listMeetings` (search), `findOwnedMeeting` (ownership-scoped),
  `findMeetingByShareToken` (public, unauthenticated lookup).
- `app/actions/`: every Server Action (`auth.js`, `meetings.js`,
  `transcribe.js` [token minting only], `search.js`).
- `app/login/`, `app/signup/`, `app/meeting/[id]/`, `app/share/[token]/`:
  one folder per route; `page.js` is the Server Component (auth check + data
  fetch), a sibling Client Component (e.g. `MeetingDetail.js`) owns the
  interactive UI.
- `app/Dashboard.js`: the dashboard's Client Component, rendered by
  `app/page.js`. Owns the direct-to-backend upload call.
- `components/ui/`: shadcn components. Edit sparingly; prefer composing
  them from a page over changing the primitives.
- `backend/server.js`: the whole Express app (health check + `/api/transcribe`).
- `backend/services/deepgram.js`: extraction + `transcribeWithRetry`, kept
  byte-for-byte equivalent in spirit to how it worked before the split.
- `backend/uploads/`, `uploads/` (frontend, currently unused but kept for
  parity): scratch space, always cleaned up in a `finally`.

## Security (non-negotiable)

- Every meeting query filters by the session's userId
  (`findOwnedMeeting`/`listMeetings`). Never trust a client-supplied user id.
  A meeting that exists but isn't yours returns the same "not found" as one
  that doesn't exist at all, never a 403, don't leak existence.
- Never return internals (stack traces, file paths, raw ffmpeg stderr) from
  a Server Action or the backend. Mark an error `{ clientSafe: true }` when
  its message is safe to show; log everything else server-side and return a
  generic message.
- Secrets only via `.env` (frontend: `MONGODB_URI`,
  `NEXT_PUBLIC_TRANSCRIBE_BACKEND_URL`; backend: `DEEPGRAM_API_KEY`,
  `MONGODB_URI`, `ALLOWED_ORIGINS`); each `.env.example` documents its
  required vars with no values.
- Never build DOM content from user- or API-sourced data with `innerHTML` or
  `dangerouslySetInnerHTML`. This is React, so plain JSX children already
  escape correctly; don't introduce raw HTML injection points.
- Login failure message is always generic ("Invalid email or password"),
  never reveal whether the email exists.
- The upload token is single-use and short-lived on purpose. Don't turn it
  into a long-lived reusable credential without a real reason to.

## External API calls

Retry `429`/`5xx` with exponential backoff (respect `Retry-After`), never
retry `4xx`. Every outbound call has a timeout. See `transcribeWithRetry` in
`backend/services/deepgram.js` for the reference pattern.

## Conventions

- Async/await; no bare callbacks.
- Comments explain *why*, not *what*. No speculative abstraction, no config
  for requirements that don't exist yet, no new dependency for something a
  few lines of code covers.
- JavaScript, not TypeScript, matching the rest of the codebase. Don't
  introduce `.ts`/`.tsx` files without discussing it first.

## Testing

- Verify every feature for real before calling it done: a real Playwright
  pass for anything with a UI, not just "it compiles." This app in
  particular has burned real bugs (hydration mismatches, Base UI API
  mistakes, Mongoose serialization, a serverless payload limit that only
  shows up in production) that only a live run surfaces, code review alone
  would have missed all of them.
- Test the frontend and backend together locally before assuming a change
  works: `npm run dev` here, `npm start` in `backend/`, both pointed at the
  same local MongoDB.
- MongoDB: use plain scripts (`mongosh`, or a small Node script via
  `mongoose`/the driver) to inspect or seed data during testing.
- Clean up test artifacts (`uploads/` temp files, throwaway test
  users/meetings) after verifying, or state clearly what was left behind.
- `npm audit` should report 0 vulnerabilities after any dependency change,
  in both the frontend and `backend/`.

## Git

Commits only when the user explicitly asks.
