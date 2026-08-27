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

1. The dashboard calls `createUploadToken(fileName)` (a Server Action,
   behind `verifySession()`, so it's a real authenticated call), passing
   the file name straight from the already-selected `File` object. This
   mints a random, single-use, 15-minute token in the `uploadtokens`
   collection, **and creates the `Meeting` document right then with
   `status: 'processing'`**, before a single byte of the file has been
   sent. It returns the token, the backend's URL
   (`NEXT_PUBLIC_TRANSCRIBE_BACKEND_URL`), and the new meeting (so the
   dashboard can show the "Transcribing..." row immediately).
2. The browser then uploads the file directly to `${backendUrl}/api/transcribe`
   with the file and the token in one multipart form, bypassing this
   Next.js app entirely. This is the one step that can take real time for a
   large recording, and it's also the one step nothing here can make
   resumable, since the browser itself is what's streaming the bytes - a
   reload or dropped connection during this step genuinely aborts that
   specific transfer. What creating the Meeting a step earlier buys you is
   that the *row* survives that abort even though the *transfer* doesn't:
   reload afterward and you see "Transcribing..." (which the stale-job
   sweep below will eventually mark `'failed'` if the backend truly never
   got the file), not nothing.
   - `Dashboard.js` uses `XMLHttpRequest` for this upload, not `fetch()`,
     specifically so it can listen to `xhr.upload.onprogress` and show a
     real percentage. `fetch()` has no upload-progress event, which is
     exactly what made a slow or stalled upload indistinguishable from one
     that was actually working - the user had no way to tell them apart.
     The same `xhr` is stashed in a ref so the "Cancel" button (shown in
     place of "Clear" while uploading) can call `xhr.abort()`, which
     rejects the upload promise and immediately calls `markMeetingFailed()`
     rather than leaving the row to sit at `'processing'` until the
     stale-job sweep eventually notices.
3. The backend looks up the token (`findByIdAndDelete`, so it's consumed
   immediately and can't be replayed), extracts `meetingId` from it, and
   looks up the `Meeting` document that step 1 already created (falling
   back to creating one itself only if `meetingId` is missing - a rolling
   deploy where the frontend hasn't picked up this flow yet - or returning
   404 if the meeting was deleted by the user while the upload was still in
   flight, honoring that deletion rather than resurrecting the row). It
   responds `202` with `{ id }` right away, then keeps running ffmpeg +
   Deepgram in the background on the same request handler (Render is a
   normal long-lived process, unlike a serverless function, so work after
   `res.json()` keeps running). See "Job status: surviving reloads and
   upload failures" below for why this shape exists.
4. The browser gets back `{ id }`, then just calls the normal
   `searchMeetings()` Server Action to refresh the dashboard list. If the
   upload request itself failed (bad token, network drop, backend 4xx/5xx),
   the dashboard calls `markMeetingFailed()` right away instead of leaving
   the row it already added stuck at `'processing'` until the stale-job
   sweep eventually notices.

The `UploadToken` model (`app/lib/models/UploadToken.js` here,
`backend/models/UploadToken.js` on the backend) and the `Meeting` model
must stay schema-identical between the two services since they share one
MongoDB database. If you change one, change the other.

## Job status: surviving reloads and upload failures

`Meeting.status` is `'processing' | 'complete' | 'failed'` (plus
`errorMessage` when failed). This is the entire mechanism behind reload and
failure resilience, and it's deliberately just a DB field, not anything
held in client or server memory:

- The `Meeting` row is created with `status: 'processing'` by
  `createUploadToken()` before the file upload even starts (see "Upload
  token flow" above), so the job's existence and state live in MongoDB from
  the first moment, not in the HTTP request/response cycle. A dropped
  connection, a closed tab, or a page reload can't lose the *row* even when
  it does interrupt the raw file transfer itself, because nothing about
  resuming depends on the browser still being connected.
- On success the backend sets `status: 'complete'` and fills in the
  transcript/utterances/duration fields. On failure it sets
  `status: 'failed'` and a client-safe `errorMessage` (Deepgram errors pass
  their message through since Deepgram's own errors are already safe to
  show; anything else, including raw ffmpeg failures, collapses to a
  generic message, per the no-internals-leaked rule below).
- `Dashboard.js` and `MeetingDetail.js` each run a `useEffect` that polls
  (`searchMeetings`/`getMeeting`) every 4 seconds **only while** a
  `'processing'` row is present in their own state, and that check runs on
  every mount, not just after an upload the same tab initiated. That's what
  makes reload-resilience automatic: reload the dashboard while a job is
  running, the server-rendered initial data already has `status:
  'processing'` (nothing was lost), and the polling effect notices that and
  starts on its own with zero client-side memory of the upload ever having
  happened.
- A `'processing'` or `'failed'` meeting can still be deleted. If a job is
  deleted while the backend is still working on it, the backend's eventual
  `meeting.save()` just matches zero documents and no-ops, no error, no
  zombie record recreated, no crash.

If you add a new failure path in `backend/server.js`, set `status: 'failed'`
and a client-safe `errorMessage` on the way out, don't just `console.error`
and leave the row stuck in `'processing'` forever.

The one failure mode that pattern alone doesn't cover is the backend
process itself dying mid-job (a crash, a Render deploy, an OOM kill) -
nothing ever runs the code that would set `status: 'failed'` in that case.
`sweepStaleJobs()` in `backend/server.js` handles this: it marks any
`'processing'` row older than `STALE_PROCESSING_MS` (30 minutes) as
`'failed'`, and runs once at startup (to clean up whatever a previous crash
left behind) plus on a `STALE_SWEEP_INTERVAL_MS` (5 minute) interval, so a
hang doesn't need a restart to be noticed either.

## Email notifications

A meeting sends an email (via Resend) the moment its `status` leaves
`'processing'`, so you don't have to keep a tab open watching for a job to
finish. `Meeting.userEmail` is denormalized from `User.email` at creation
time in `createUploadToken()`, since the backend has no `User` model of its
own and the stale-job sweep needs it long after the originating
`UploadToken` is gone.

Every path that can set `status: 'processing'` to `'complete'` or
`'failed'` sends this email, and there are genuinely two separate
implementations of `sendMeetingEmail()` (`app/lib/email.js` on the
frontend, `backend/services/email.js` on the backend) because failures can
originate on either side:

- **Backend** (`backend/server.js`): the ffmpeg/Deepgram success or failure
  branch in `/api/transcribe`, and `sweepStaleJobs()` for a job whose
  backend process died mid-work.
- **Frontend** (`app/actions/meetings.js`): `markMeetingFailed()`, called
  by `Dashboard.js` when the upload request itself never reaches the
  backend at all (bad token, network drop, backend unreachable) - this
  failure is caught entirely client-side and never touches
  `backend/server.js`, so only the frontend can send this one.

Both implementations are deliberately best-effort and can never throw: a
broken Resend integration should never surface as a user-facing error for
an unrelated action, and both no-op quietly (logging, not throwing) if
`RESEND_API_KEY` isn't set, so email stays fully optional in any
environment that hasn't configured it. Neither retries on failure (unlike
`transcribeWithRetry` for Deepgram) - a missed notification email is a
minor inconvenience, not a correctness problem, since the meeting's real
status is always sitting in the database regardless of whether the email
got through.

Env vars: `RESEND_API_KEY`, `EMAIL_FROM` (must be `@` a domain verified in
Resend) on both services; `FRONTEND_URL` on the backend and `APP_URL` on
the frontend (same value, different names, since they're separate `.env`
files) to build the link back to the meeting.

## Webhook notifications

Same trigger points as email notifications above, same
two-implementations-because-failures-can-originate-on-either-side
structure (`app/lib/webhook.js` frontend, `backend/services/webhook.js`
backend, both best-effort and never throw), same reasoning for not
retrying. Unlike email, this is a *list* of destinations
(`User.webhooks: [{ url, format }]`) sent to in parallel
(`Promise.allSettled`, so one bad endpoint doesn't block the others) -
each entry's `format` picks how the meeting gets reshaped for that
destination:

- `'generic'`: the full raw JSON payload (transcript, speaker-labeled
  utterances, status, link) - meant for piping a finished transcript
  straight into the user's own automation (n8n, Zapier, a custom agent)
  without them having to copy-paste it. No size limit, since nothing
  displays it directly.
- `'discord'`, `'slack'`, `'teams'`: reshaped into that platform's actual
  expected message format (Discord's `{embeds: [...]}`, Slack's
  `{text: "..."}`, Teams' MessageCard `{"@type": "MessageCard", ...}`),
  with the transcript truncated to a fixed preview length - these
  platforms reject or mangle oversized messages, and a real meeting
  transcript can be far larger than any of them will render sensibly.
  Pasting a raw webhook URL for one of these directly into the `'generic'`
  format would likely fail outright, since none of these platforms accept
  arbitrary JSON.

There's no auto-detection of which format a URL needs - the user picks it
explicitly in the dialog. This was a deliberate choice, not an oversight:
Discord's and Slack's webhook URLs are unambiguous
(`discord.com`/`discordapp.com`, `hooks.slack.com`), but Teams' current
webhook mechanism (Workflows, via Power Automate - the old Office 365
connector webhooks this used to be were retired in Teams in May 2026)
goes through Azure Logic Apps' generic domain, which is used for countless
Power Automate flows unrelated to Teams. URL-sniffing would work for two
of three and silently misfire for the third; explicit is simpler and more
honest than partial magic.

`User.webhooks` is the setting (a dialog off the dashboard's avatar menu,
`saveWebhooks`/`getWebhooks` in `app/actions/settings.js`, replacing the
whole list atomically rather than granular add/remove actions), and like
`userEmail` it's denormalized onto `Meeting.userWebhooks` at creation time
in `createUploadToken()` for the same reason (available to the backend and
the stale-job sweep without a lookup, snapshotted so a later change to the
list doesn't retroactively apply to a meeting already in flight).

`saveWebhooks` rejects `localhost`, loopback/private/link-local IPs, and
non-http(s) schemes for *every* entry at save time - a deliberate but
deliberately *basic* SSRF deterrent, not a hardened one (it doesn't
resolve DNS or follow redirects, so it can't catch a rebinding attack).
That's a proportionate call for this app's actual trust model - the
person setting these URLs is the account owner pointing at their own
destinations, same trust level as exporting their own transcript, not an
untrusted third party choosing a target on a shared multi-tenant service.
Don't quietly relax this list; if you need to allow something like
`192.168.x.x` for local testing, do it consciously and say why.

Verified for real: all four formats fired in parallel from one completed
meeting, delivered to a local catcher, with each payload's shape confirmed
correct against its platform's documented schema (Discord embed object,
Slack `text` field, Teams MessageCard).

## Speaker merge

Deepgram's diarization sometimes over-splits one person's voice into
multiple speaker ids (or, rarer, merges two people into one). `mergeSpeakers`
in `app/actions/meetings.js` rewrites `utterances[].speaker` for the merged-
away ids onto the target id and drops their `speakerNames` entries. The UI
is a small dialog in `MeetingDetail.js` (a "Keep as" `Select` plus checkboxes
for the others), reachable from a "Merge speakers" button that only shows
when there's more than one speaker.

### Speaker rename autocomplete

`listKnownSpeakerNames()` in `app/lib/meetings.js` collects every name a
user has ever typed into a speaker-rename box, deduplicated across all
their meetings, and `MeetingDetail.js`'s `page.js` passes it down as a
`<datalist id="known-speaker-names">` that each `SpeakerLine`'s rename
`<input>` references via `list=`. This is autocomplete, not recognition -
nothing here knows which speaker in a *new* meeting corresponds to which
suggested name; it just saves retyping "Om" for the fifth time and avoids
near-duplicate names ("Om" vs "om" vs "OM"). Real cross-meeting speaker
identification would need actual voice fingerprinting (a separate
biometrics pipeline; Deepgram's diarization doesn't expose portable
embeddings across separate API calls) and was deliberately not built -
disproportionate for what this bought.

This is also why the rename field became a real `<input>` instead of the
`contentEditable` span used everywhere else in this app (the meeting
title, and this same field before this change) - `<datalist>` only works
with a real form input, `contentEditable` has no equivalent. Don't convert
the title back and forth between the two patterns without a reason; they
coexist here because only the speaker field needed the datalist.

## Password reset

`PasswordResetToken` (`app/lib/models/PasswordResetToken.js`) mirrors
`UploadToken`'s shape - a random `_id` doubling as the token, a TTL index
for auto-expiry (1 hour here vs. 15 minutes for uploads) - and lives only
on the frontend, since resetting a password never touches the backend.
`requestPasswordReset()` in `app/actions/auth.js` always returns the same
generic "if that email has an account..." message and only actually
creates a token/sends an email when the account exists, same
don't-leak-existence rule as login's `verifyCredentials()`. Both the
result *and* Resend delivery failures stay silent to the caller for this
reason - see `sendPasswordResetEmail()` in `app/lib/email.js`.

`resetPassword()` consumes the token with `findByIdAndDelete` (single-use,
same pattern as `UploadToken`), then deletes every existing `Session` for
that user before creating a fresh one for the tab completing the reset - a
password reset is often a response to a compromised account, so every
other logged-in device has to log in again with the new password rather
than staying signed in on the old one.

`/reset-password/[token]/page.js` does a read-only `PasswordResetToken.exists()`
check before rendering the form, purely so an invalid/expired link says so
immediately instead of only after submitting a new password - the actual
consume-and-verify still only happens once, in `resetPassword()` itself.

## Sign in with Google

`app/lib/oauth.js` holds Google's config (endpoints, scope) and the
Authorization Code flow logic (`buildGoogleAuthorizationUrl`,
`exchangeGoogleCode`, `fetchGoogleProfile`). This was originally written
generically to cover Google and Microsoft both, but Microsoft sign-in was
dropped (no Azure access to actually register and test it against), and a
generic multi-provider shape for a single real provider is exactly the
premature abstraction this codebase avoids elsewhere - it was
deliberately de-genericized back down to Google-only rather than left
carrying dead flexibility. If a second provider is added back for real,
re-introduce the generic shape then, motivated by the actual second
provider's needs, not preemptively.

Flow: `GET /api/auth/google` (see the Route Handler exception above)
generates a random `state`, stores it in a short-lived httpOnly cookie,
and redirects to Google's consent screen. Google redirects back to
`GET /api/auth/google/callback` with `code` and `state` - mismatched or
missing `state` is rejected outright (CSRF protection; the cookie is what
proves *this browser* started the flow, not just anyone who can craft a
callback URL). On a match, the callback exchanges the code for an access
token, fetches the profile, and requires `verified_email: true`
specifically - no verified email, no login. Don't relax this to "whatever
email Google hands back," since that would let someone authenticate as an
address they don't actually control.

Account matching is by email, not by `googleId`: if a `User` with that
email already exists (created by password signup), the incoming
`googleId` gets linked onto the existing account rather than creating a
duplicate - signing in with Google using the same address as an existing
password account should just work, not fork into two accounts.
`User.passwordHash` is `required: false` for exactly this reason (a
Google-only account has none), and `verifyCredentials()` in
`app/actions/auth.js` treats a missing passwordHash as "wrong password"
(falls through to `DUMMY_HASH`) rather than passing `undefined` to
`bcrypt.compare`, which throws.

`OAuthButtons.js` (rendered on both `/login` and `/signup`) is a Server
Component that checks `isGoogleConfigured()` - the button simply doesn't
render until `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set, rather
than rendering a button that would immediately fail. This is why nothing
in the UI needs an "OAuth is unavailable" state for the common case of it
not being configured yet; `oauth_unavailable` in `oauthErrorMessage()`
only fires if `/api/auth/google` is hit directly (a stale bookmark, or a
race where env vars were removed) despite the button being hidden.

Env vars (frontend only - OAuth never touches the backend):
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. Getting real values requires
registering an OAuth app in Google Cloud Console (OAuth consent screen +
Web application credentials), with the redirect URI set to
`${APP_URL}/api/auth/google/callback` - a manual, account-specific step
that can't be done from this codebase. With real credentials configured,
the redirect from `/api/auth/google` to Google's actual consent screen
was confirmed correct (registering `http://localhost:3000/...` as a
second authorized redirect URI made local testing reach Google's real
sign-in page instead of a `redirect_uri_mismatch` error). The callback's
token exchange, profile fetch, and account creation/linking still need a
completed real sign-in to confirm end to end.

## Stack (frontend)

- Next.js 16 (App Router), React 19, JavaScript (no TypeScript).
- Server Components for reads, Server Actions for every mutation except the
  file upload itself (see above). The **only** Route Handlers in this app
  are `app/api/auth/google/route.js` and its `callback/route.js` - Google
  redirects the browser here with a plain GET it initiates,
  which can't be a Server Action (those only respond to POSTs this app
  itself sends, via a form or `fetch`, not a third party's redirect). Don't
  add a Route Handler for anything else without the same justification;
  everything that isn't "a GET request initiated by something outside this
  app" belongs in a Server Action or a Server Component instead.
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

Pinning the locale isn't always sufficient by itself, though - this
actually happened in production (`formatDate` in `Dashboard.js`), reliably
reproducible on the deployed Vercel build but never locally (`next dev`
*or* `next build && next start`), which was the tell that it wasn't the
`undefined`-locale mistake above. The real cause: even with the same
pinned locale, `toLocaleString`'s exact output can still differ by the
*specific whitespace character* it uses before "AM"/"PM" (a plain space
vs. U+202F NARROW NO-BREAK SPACE), depending on the ICU/CLDR data bundled
with whatever Node version rendered the server HTML versus whatever
browser hydrates it - invisible to the eye, but still a byte-for-byte
mismatch to React (error #418). `formatDate` now strips every Unicode
space variant to a plain `' '` after formatting, so the output is
byte-identical no matter which ICU produced it. If a similar
"only-in-production, self-recovering, no visible glitch" hydration error
shows up again, check for this exact pattern before assuming it's the
`undefined`-locale mistake.

## Database query patterns

- `Meeting` has one compound index, `{ userId: 1, createdAt: -1 }`. Every
  real query on this collection filters by `userId` and sorts by
  `createdAt`, so one compound index covers both instead of maintaining a
  separate standalone `userId` index. Don't add a standalone `userId` index
  back; it would be redundant (a compound index's leading field already
  serves lookups on that field alone) and just cost extra write overhead.
- Read-only queries use `.lean()`: `listMeetings` and
  `findOwnedMeetingLean` (used by both meeting page loads and the polling
  `getMeeting` action). `.lean()` skips Mongoose document hydration (faster)
  and returns plain objects with no circular parent references and no
  Map-wrapping on `speakerNames`, which is what makes `toDetail`/`toSummary`
  simple pass-throughs instead of needing manual `.map()`/
  `Object.fromEntries()` gymnastics to survive the Server-to-Client
  Component boundary (see "The Mongoose-to-Client-Component trap" below).
  `findOwnedMeeting` (non-lean) still exists and is still what every
  *mutating* Server Action uses, since those need a real document to call
  `.save()`/`.markModified()`/Map methods on.
- `listMeetings` excludes `utterances` (`.select('-utterances')`): the
  dashboard list only ever shows a short preview, so there's no reason to
  pull potentially large transcript-timing arrays over the wire for every
  row.
- The share page (`findMeetingByShareToken`) intentionally has **no**
  time-based caching (no `revalidate`, no `unstable_cache`). Revoking a
  share link needs to take effect immediately - that's a real security
  guarantee this app makes ("Revoke" in the UI) - and caching this lookup
  even briefly would mean a revoked link could keep working until the cache
  expired. At this app's real scale (a single user's private meetings, not
  public high-traffic content) the query is cheap enough that this
  isn't a real performance tradeoff, just a correctness one.

## Sparse unique indexes need no `default`

`Meeting.shareToken` and `UploadToken`'s own expiry pattern both rely on a
sparse unique index. A sparse index only excludes documents where the field
is truly *absent* - a schema `default` (even `null`) writes the field into
every document, and the second one collides. Never add a `default` to a
sparse-unique field; clear it with `= undefined`, not `= null`.

## File layout

- `app/lib/db.js`: mongoose connection.
- `app/lib/models/User.js`, `Meeting.js`, `Session.js`, `UploadToken.js`,
  `PasswordResetToken.js`
- `app/lib/email.js`: `sendMeetingEmail()` and `sendPasswordResetEmail()`,
  the frontend half of email - see "Email notifications" and "Password
  reset".
- `app/lib/webhook.js`: `sendMeetingWebhook()`, the frontend half of
  webhook notifications - see "Webhook notifications".
- `app/lib/oauth.js`: Google config + Authorization Code flow helpers - see
  "Sign in with Google".
- `app/lib/session.js`: cookie/session primitives (`createSession`,
  `getSessionUserId`, `deleteSession`).
- `app/lib/dal.js`: `verifySession()`, the auth boundary.
- `app/lib/meetings.js`: `toSummary`/`toDetail` (plain-object conversion,
  see above), `listMeetings` (search), `findOwnedMeeting` (ownership-scoped,
  live document, for mutations), `findOwnedMeetingLean` (ownership-scoped,
  read-only), `findMeetingByShareToken` (public, unauthenticated lookup),
  `listKnownSpeakerNames` (rename autocomplete source).
- `app/actions/`: every Server Action (`auth.js` [signup/login/logout,
  `requestPasswordReset`, `resetPassword`], `meetings.js` [`getMeeting`,
  title/speaker rename, `mergeSpeakers`, `markMeetingFailed`, delete, share
  links], `settings.js` [`getWebhooks`, `saveWebhooks`],
  `transcribe.js` [token minting, also creates the `Meeting` row - see
  "Upload token flow"], `search.js`).
- `app/login/`, `app/signup/`, `app/forgot-password/`,
  `app/reset-password/[token]/`, `app/meeting/[id]/`, `app/share/[token]/`:
  one folder per route; `page.js` is the Server Component (auth check + data
  fetch), a sibling Client Component (e.g. `MeetingDetail.js`) owns the
  interactive UI.
- `app/api/auth/google/route.js`, `app/api/auth/google/callback/route.js`:
  the OAuth Route Handlers - see "Sign in with Google" for why these are
  Route Handlers and everything else in `app/` isn't.
- `app/OAuthButtons.js`: the "Continue with Google" button, a shared
  Server Component rendered on both `/login` and `/signup`.
- `app/Dashboard.js`: the dashboard's Client Component, rendered by
  `app/page.js`. Owns the direct-to-backend upload call and the webhook
  settings dialog.
- `components/ui/`: shadcn components. Edit sparingly; prefer composing
  them from a page over changing the primitives.
- `backend/server.js`: the whole Express app (health check + `/api/transcribe`).
- `backend/services/deepgram.js`: extraction + `transcribeWithRetry`, kept
  byte-for-byte equivalent in spirit to how it worked before the split.
- `backend/services/email.js`: `sendMeetingEmail()`, the backend half of
  email notifications - see "Email notifications".
- `backend/services/webhook.js`: `sendMeetingWebhook()`, the backend half
  of webhook notifications - see "Webhook notifications".
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
  `NEXT_PUBLIC_TRANSCRIBE_BACKEND_URL`, `RESEND_API_KEY`, `EMAIL_FROM`,
  `APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`; backend:
  `DEEPGRAM_API_KEY`, `MONGODB_URI`, `ALLOWED_ORIGINS`, `RESEND_API_KEY`,
  `EMAIL_FROM`, `FRONTEND_URL`); each `.env.example` documents its
  required vars with no values.
- Never build DOM content from user- or API-sourced data with `innerHTML` or
  `dangerouslySetInnerHTML`. This is React, so plain JSX children already
  escape correctly; don't introduce raw HTML injection points.
- Login failure message is always generic ("Invalid email or password"),
  never reveal whether the email exists. `requestPasswordReset()` follows
  the same rule.
- The upload token is single-use and short-lived on purpose. Don't turn it
  into a long-lived reusable credential without a real reason to. Same for
  `PasswordResetToken` and the OAuth `state` cookie.
- OAuth sign-in only accepts an email Google itself marked verified, and
  matches/links accounts by that email - never by a client-supplied
  identifier. See "Sign in with Google".

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
