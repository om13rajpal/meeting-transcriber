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

## Git remotes: pushing to `origin` alone does not deploy anything

This repo's local `origin` remote is `om13rajpal/meeting-transcriber`. That
is **not** the repo Vercel and Render actually watch for auto-deploy -
their git integrations are connected to **`omrajpal13274/meeting-transcriber`**,
which is a *fork* of `om13rajpal/meeting-transcriber`, not the same repo.
`git push origin main` updates the upstream repo but does **not** touch
the fork, and the fork does not auto-sync from its upstream on its own.

After pushing to `origin`, the fork has to be explicitly synced before
Vercel/Render will see the new commits:

```bash
gh auth switch --user omrajpal13274
gh repo sync omrajpal13274/meeting-transcriber --source om13rajpal/meeting-transcriber
gh auth switch --user om13rajpal   # back to the usual account
```

(`gh auth status` lists several keyring-stored accounts on this machine,
including `omrajpal13274` - `gh repo sync` needs that account active since
it's the one with write access to the fork.) Confirm the sync actually
worked by comparing HEAD commits rather than trusting the command's exit
code alone:

```bash
gh api repos/omrajpal13274/meeting-transcriber/commits/main --jq '.sha'
gh api repos/om13rajpal/meeting-transcriber/commits/main --jq '.sha'
```

Even after the fork is synced, don't assume Vercel/Render auto-deploy
fired promptly - this session saw real, repeated delay (minutes, sometimes
no deploy at all without a manual nudge) rather than the usual
near-instant webhook trigger. Verify the actual deployed behavior instead
of trusting elapsed time or exit codes:

- **Vercel**: `vercel ls` (once `vercel link`ed to
  `om-rajpals-projects/meeting-transcriber`) shows recent deployments and
  their age. If nothing new shows up after a few minutes, deploy directly
  rather than keep waiting: `vercel --prod --yes --archive=tgz` (the
  `--archive=tgz` flag is required on this machine - a plain `vercel
  --prod` fails with `missing_archive` / "files should NOT have more than
  15000 items," almost certainly the exFAT-volume AppleDouble sidecar
  files inflating the file count - see the cargo/Next.js cache notes
  elsewhere in this file for the same underlying cause).
- **Render**: there is no CLI or API key configured for this backend on
  this machine as of this writing - the only way to verify a Render
  deploy landed is an HTTP check against the live service (e.g. `curl
  https://meeting-transcriber-i7s9.onrender.com/health`, or checking for
  a route that only exists in the new code). If a manual nudge is needed
  and no API access is available, that has to come from the user via the
  Render dashboard ("Manual Deploy -> Deploy latest commit").

## This repo lives on an exFAT external volume: AppleDouble sidecar files

This project's working directory is on an external drive formatted
exFAT, not APFS. exFAT has no native support for macOS extended
attributes/resource forks, so macOS silently writes a shadow `._<name>`
sidecar file next to many real files to hold that metadata - and these
sidecars accumulate in build/cache directories over normal use, not just
from one-off Finder operations. This has caused two distinct real
failures in this session, both from a tool trying to read its own
cache/build directory and getting confused by (or overwhelmed by) these
extra files:

- **Rust/Cargo, building the desktop app in place**: `cargo check`/`cargo
  build`/`cargo tauri build` can panic reading a `._default.toml`-style
  sidecar as if it were the real file ("stream did not contain valid
  UTF-8"). Fix: point `CARGO_TARGET_DIR` at a normal (non-exFAT)
  filesystem, e.g. `CARGO_TARGET_DIR=/tmp/mt-cargo-target cargo check` /
  `... npx tauri build`. Do this for every desktop build on this machine,
  not just when it actually fails.
- **Next.js dev server, Turbopack's persistent cache**: `npm run dev` can
  fail outright with `Failed to open database / Loading persistence
  directory failed / invalid digit found in string` (a Rust-side error
  from Turbopack's own cache reader, same root cause as above). Fix:
  `rm -rf .next` and restart - the cache regenerates cleanly, though it
  can recur after enough file churn and may need repeating.
- This is also the most likely explanation for `vercel --prod` failing
  with `missing_archive` / "files should NOT have more than 15000 items"
  on a plain deploy from this machine - use `--archive=tgz` (see the git
  remotes section above).

If a build/dev-server/deploy tool on this machine fails with a
filesystem/parsing error that makes no sense given the actual source
code, suspect this before anything else - it is an environment quirk of
this specific machine's disk, not a bug in the project.

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

**`sweepStaleJobs()` only runs while the backend process is actually
awake**, which on Render's free tier (15-minute spin-down) it very often
isn't - and nothing about reloading or polling the dashboard wakes it,
since the frontend's Server Actions talk to MongoDB directly and never
touch the backend at all. `sweepStaleProcessingMeetings(userId)`
(`app/lib/meetings.js`) is the same 30-minute-stale check run from the
frontend side instead - Vercel/MongoDB are always reachable regardless of
whether the backend is asleep. It's called at the top of `listMeetings()`
and in the `getMeeting` Server Action, the two places already documented
above as polling while a `'processing'` row exists. Both constants are
named `STALE_PROCESSING_MS` (backend and frontend copies) on purpose -
kept at the same 30 minutes so there's only one definition of "stale" for
this field, not two that could drift.

A dedicated `GET /health` route on the backend exists specifically so an
external uptime/keep-alive pinger (this app uses cron-job.org) has a
stable, memorable path - point it there, not at `/`, and make sure the
monitor's own request timeout comfortably exceeds a Render cold start
(which can take 20+ seconds) or the monitor will report the job as
failing every time it happens to land during a sleep window.

## Retry and Cancel

A `'processing'` row can be **Cancel**led from the dashboard; a
`'failed'` one can be **Retry**'d - both shown as a small icon button next
to Delete in `app/Dashboard.js`, only for the matching status. This only
works because the backend now keeps the raw uploaded file around for a
while instead of always deleting it once transcription finishes:

- **`Meeting.pendingFilePath`** / **`pendingFileStoredAt`**: set by
  `runTranscriptionJob()` in `backend/server.js` right before it calls
  `transcribeFile()`, for every job (not just failures) - so a process
  death mid-job still leaves a record of where the file is. Cleared only
  on success (the file is deleted right after) or an explicit Cancel. A
  failure leaves both fields set, on purpose - that's what makes Retry
  possible. Backend-only fields, never exposed through
  `toSummary`/`toDetail`/`toApiKeySummary` - they're a local filesystem
  path, not user-facing data.
- **`transcribeFile()`** (`backend/services/deepgram.js`) no longer
  deletes the uploaded file itself - only the transient ffmpeg-normalized
  intermediate copy. Whether the original survives is entirely the
  caller's decision now (see `pendingFilePath` above).
- **`MeetingActionToken`** (`app/lib/models/MeetingActionToken.js`,
  `backend/models/MeetingActionToken.js` - schema-identical, same rule as
  `UploadToken`): a one-time, 5-minute token scoped to one meeting and one
  action (`'retry'` or `'cancel'`). Minted by `retryMeeting(id)`/
  `cancelMeeting(id)` (`app/actions/meetings.js`, after the normal
  `verifySession()` + ownership check every mutation here already does),
  then used for a small server-to-server `fetch()` straight from the
  Server Action to the backend - no browser involvement, since retry/
  cancel never move the file itself, just tell the backend (which already
  has it) to act. This is the same reasoning as `UploadToken`, just for a
  tiny request instead of a large file transfer, and is why this isn't a
  static shared secret between the two services - a leaked token is
  single-use and scoped to one meeting, not standing access.
- **`POST /api/meetings/retry`**: re-runs `runTranscriptionJob()` against
  `pendingFilePath`. If the file's gone - the backend restarted since the
  failure (a Render free-tier spin-down or a deploy; **this backend has no
  persistent disk**, a known, accepted limitation, not a bug) - it returns
  a clear "no longer available, please upload it again" error instead of
  retrying into a confusing second failure.
- **`POST /api/meetings/cancel`**: deletes the stored file and marks the
  meeting `'failed'` with `"Cancelled by user."`. Deliberately does **not**
  call `sendNotifications()` the way every other status-flip in this file
  does - the user just took this action themselves, so an "upload failed"
  email/webhook immediately afterward would be redundant, not informative.
- **`sweepOrphanedFiles()`** (`backend/server.js`, same recurring-interval
  pattern as the other sweeps): reclaims a failed meeting's file once it's
  sat unretried for `ORPHANED_FILE_RETENTION_MS` (24 hours) - the backstop
  for a recording nobody ever comes back to Retry or Cancel, so an
  abandoned file doesn't sit on Render's limited disk forever. Keyed off
  `pendingFileStoredAt`, not `createdAt` - `createdAt` is the *original*
  upload time, which would make this sweep reclaim a file seconds after a
  much later Retry re-stored it. `sweepStaleJobs()` also unlinks the file
  immediately (no 24-hour wait) when it marks a hung job failed, since a
  job stuck long enough for that sweep to fire means whatever process was
  using the file is long gone - nothing could still be reading it.

Verified for real, end to end, against a local backend + a live browser
session (not just read from the code): Retry re-ran the full ffmpeg +
Deepgram pipeline against a stored file and reached `'complete'`, with the
file deleted afterward; Cancel deleted the stored file and set
`'failed'`/`"Cancelled by user."`; and Retry against a meeting whose file
had already been removed (simulating a backend restart) returned the
honest "no longer available" error instead of a confusing second failure.

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
  `{text: "..."}`, Teams' MessageCard `{"@type": "MessageCard", ...}`), but
  deliberately just a notification, not a transcript dump -
  `chatMessageBody()` returns `Hi! Your transcript for "<title>" is
  ready.` (or the failure equivalent, with `errorMessage`) plus the link,
  nothing else. This was a real design decision, not the original
  behavior: it used to send a speaker/timestamp-formatted transcript
  preview into the chat message itself, which the user explicitly asked
  to drop in favor of "just tell me it's ready and link me to it." Pasting
  a raw webhook URL for one of these directly into the `'generic'` format
  would likely fail outright regardless, since none of these platforms
  accept arbitrary JSON.

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

## Notification delivery status and resend

`sendMeetingEmail()`/`sendMeetingWebhook()` used to be pure fire-and-forget
- this was the direct cause of a real debugging session: a webhook
silently failed to fire and the only way to find out was reading the
database by hand. Both now return their outcome (`sendMeetingEmail` a
boolean, `sendMeetingWebhook` one `{ url, ok, status }` per destination),
and every call site records it back onto the meeting:
`Meeting.emailLastAttemptAt`/`emailLastAttemptOk`, and
`userWebhooks[].lastAttemptAt`/`lastAttemptOk`/`lastAttemptStatus` (the
HTTP status code, or `0` for a network failure/timeout that never got a
response).

`sendNotifications(meeting)` - duplicated in `backend/server.js` and as a
private helper in `app/actions/meetings.js`, same reasoning as the
email/webhook services themselves being duplicated per service - wraps
"send both channels, merge the results back onto the meeting document,
save" as one call, used by all four places that can trigger the automatic
notification (the backend's success/failure branches, its stale-job
sweep, and the frontend's `markMeetingFailed()`) plus the new
`resendNotifications(id)` Server Action for a manual retry.

The status/errorMessage save always happens *before* `sendNotifications()`
is called (a separate, second `.save()`), not folded into one save - a
webhook can take up to its own timeout to answer, and the dashboard/
meeting page polling should see `'complete'`/`'failed'` the instant it's
true, not delayed behind however long notifications take to attempt.

`toDetail()` in `app/lib/meetings.js` exposes this as `notifications:
{ email, webhooks: [...] }` (format + attempt status per entry, not the
raw webhook URLs - those stay in the settings dialog, not cluttering the
meeting page). `MeetingDetail.js`'s `NotificationsPanel` renders one badge
per channel (not sent yet / delivered / failed) plus a "Resend" button
that calls `resendNotifications()` and replaces local state with the
fresh result - shown on both the `'complete'` and `'failed'` states, since
either can have channels to retry.

Verified for real: uploaded through a real transcription with one working
webhook (`generic`, an httpbin.org echo endpoint) and one broken one
(`discord`, pointed at a non-resolving domain), confirmed the panel showed
the right status for each (plus a genuinely-rejected email, from Resend's
own `@example.com` test-domain validation - a real failure, not a test
artifact), clicked Resend and confirmed it re-attempted, then fixed the
broken webhook's URL and confirmed a second Resend flipped just that one
channel to delivered while the others stayed as they were.

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

## Cost tracking

Every completed meeting shows which Deepgram model transcribed it and what
it cost, per the app's own requirement to always know "cost of each
transcript and what model was used." Two fields on `Meeting`:
`deepgramModel` (always `'nova-3'` today - a real field rather than a
hardcoded UI string so a future model change doesn't need a frontend
deploy to show correctly) and `deepgramCostUsd` (a dollar figure, always
present once `status: 'complete'`).

`deepgramCostUsd` starts as an **estimate**, not a guess pulled from thin
air: `transcribeFile()` in `backend/services/deepgram.js` computes it from
the meeting's real `durationSeconds` times `DEEPGRAM_RATE_PER_MINUTE_USD`
(env var, defaults to `0.0071` - Nova-3 batch multilingual transcription
plus the diarization add-on on Deepgram's pay-as-you-go pricing, the
combination this app always requests). This is stored and shown
immediately (`"Nova-3 · $0.0002 estimated"` in `MeetingDetail.js`'s meta
line) because Deepgram's own billing data for a request isn't necessarily
available the instant transcription finishes.

That estimate then gets **upgraded to Deepgram's actual billed amount** in
the background: every `/v1/listen` response includes a `request_id`
(stored as `Meeting.deepgramRequestId`), and Deepgram's Management API
(`GET /v1/projects/:project_id/requests/:request_id`, `response.details.usd`
in the response) returns the real number they billed for that specific
request - not an app-side calculation at all. Two things try this lookup:

- **Immediately after transcription finishes**, right after
  `sendNotifications()` in the `/api/transcribe` success branch - Deepgram's
  billing data for a request is sometimes already indexed by the time the
  job completes, so this can upgrade the estimate the moment a meeting goes
  `'complete'` instead of making every meeting wait for a sweep tick.
  Usually it isn't ready yet, in which case `fetchExactCost()` just returns
  `null` here and this is a no-op - the sweep below is what actually
  guarantees the upgrade eventually happens regardless of whether this
  first attempt succeeds.
- **`sweepPendingCosts()`** in `backend/server.js`, on the same
  recurring-interval pattern as `sweepStaleJobs()` (5-minute interval, plus
  once at startup), scanning `'complete'` meetings where `deepgramCostExact`
  is still `false` and retrying `fetchExactCost()` for each. Gives up after
  `COST_SWEEP_LOOKBACK_MS` (6 hours) per meeting so a request Deepgram's
  billing pipeline never indexes doesn't get retried forever.

Either path flips `deepgramCostExact: true` once it succeeds - at which
point the "estimated" qualifier disappears from the UI and the number
itself may also change slightly to match Deepgram's real billing.

This whole exact-cost path is **opt-in via `DEEPGRAM_PROJECT_ID`**
(backend-only env var, found in the Deepgram console) and silently no-ops
entirely if it's unset - `sweepPendingCosts()` returns immediately,
`fetchExactCost()` never gets called, and the estimate is simply left in
place forever, still a real and clearly-labeled number. `fetchExactCost()`
itself also never throws: a 404 (not indexed yet), a permissions error, or
a network failure all just return `null`, which the sweep reads as "try
again next interval" - this is a deliberate exception to the "retry
429/5xx, never 4xx" rule under "External API calls" below, because a 404
here doesn't mean "this will never exist," it means "not ready yet."

Verified for real against Deepgram's live Management API (not just read
from their docs): a request's cost is genuinely not queryable for **at
least ~1.5 hours** after it happens - `GET /v1/projects/:id/requests/:id`
returns HTTP `200` with a literal `null` body (not a `404`) for a request
that hasn't been indexed yet, which is exactly the "not ready, try later"
case `fetchExactCost()` already treats identically to a 404. This is a
real characteristic of Deepgram's billing pipeline, not a bug in this
app - `deepgramCostExact` will legitimately stay `false` for a while after
every meeting completes, by design, and there's no way to shorten that
from this app's side. Don't "fix" this by shrinking
`COST_SWEEP_LOOKBACK_MS`; if anything it should stay generous relative to
this observed delay.

`app/lib/meetings.js`'s `getUsageSummary(userId)` sums `durationSeconds`/
`deepgramCostUsd` across the current calendar month's `'complete'`
meetings (plain Node reduce, not an aggregation pipeline, matching
`listKnownSpeakerNames()`'s reasoning for this app's scale) and
`Dashboard.js` shows it as "This month: N min transcribed · ~$X.XX
estimated" next to the "Past Meetings" heading. This is an approximation
by nature (a real usage estimate, not a live sync with Deepgram's billing
dashboard, and "calendar month" may not match your actual billing cycle) -
fine at this app's single-user scale.

## Multi-file upload

`Dashboard.js` uploads multiple files independently rather than one at a
time: `files` state is an array of `{ key, file, status, progress, error,
xhr }` entries (`status`: `'pending' | 'uploading' | 'done' | 'error' |
'cancelled'`), and `uploadOneFile(key, file)` runs the exact same
`createUploadToken()` → `uploadWithProgress()` → `markMeetingFailed()` flow
from "Upload token flow" above, just parameterized per entry instead of
against one `selectedFile`. `handleTranscribeAll()` fires every `'pending'`
entry's `uploadOneFile()` concurrently (no queue/concurrency cap of its
own - relies on the browser's normal per-origin connection limits), so
several recordings can genuinely be uploading, and separately
transcribing, at once, each becoming its own `'processing'` `Meeting` row
as soon as its own token is minted. Each row has its own Cancel (while
uploading, aborts that entry's `xhr` only) or Retry (after error/cancelled,
re-runs `uploadOneFile()` for that same `File` object, no re-selection
needed) - unrelated files are never affected by one file's failure or
cancellation.

## Meeting tags

Simple organization, deliberately not a workflow/automation builder (that
idea was considered and explicitly rejected in favor of this). `Meeting.tags:
[String]`, edited via `updateMeetingTags(id, tags)` in
`app/actions/meetings.js`, which trims, dedupes, and caps each meeting to
`MAX_TAGS` (10) tags of `MAX_TAG_LENGTH` (30) characters each server-side -
never trust the client-side input alone. `MeetingDetail.js` renders them as
removable `Badge`s next to an inline "Add tag" input (`Enter` to add);
`Dashboard.js` shows the same badges under each meeting row's preview line.
`listMeetings()`'s existing search `$or` includes `{ tags: pattern }`
alongside title/originalName/transcript - Mongo matches a regex against an
array field if *any* element matches, so this needed no `$elemMatch`, and
the dashboard's one search box doubles as the tag filter rather than a
separate UI for it.

## Bulk actions

`Dashboard.js` tracks a `selectedIds` Set alongside `meetings`; each row
gets a checkbox (`onClick` stops propagation so it doesn't trigger the
row's own navigate-to-meeting handler) that toggles membership. Selecting
anything shows a bar with "Add tag" and "Delete", both scoped to
`Array.from(selectedIds)`. Selection is cleared whenever the search query
changes (`handleSearchChange`) - keeping a selection across a different
filtered result set would show a count that doesn't match what's visible.

- `deleteMeetings(ids)` in `app/actions/meetings.js` is a single
  `Meeting.deleteMany({ _id: { $in: idList }, userId })` - no per-meeting
  side effect needs a loaded document first (unlike, say, notifications),
  so there's no reason to loop individual `deleteOne()` calls. Still
  filtered by `userId` in the query itself, same ownership rule as
  everywhere else.
- `addTagToMeetings(ids, tag)` *adds* one tag to several meetings,
  deliberately not a bulk-replace of each meeting's whole tag list (bulk-
  editing N different existing tag sets in one step isn't a real use case
  here - see "Meeting tags" above). This one does loop with individual
  `.save()` calls, since the dedupe/cap-to-`MAX_TAGS` logic has to run
  against each meeting's own existing tags.
- The single-row delete button and the bulk delete button share one
  dialog and one `confirmDelete()`, unified via `pendingDeleteIds` (an
  array, even for a single row - `setPendingDeleteIds([meeting.id])`)
  rather than keeping two separate delete code paths.

## Search result highlighting and jump-to-match

Two parts, split across the two pages that need them:

- **Dashboard preview**: `toSummary(meeting, query)` in
  `app/lib/meetings.js` takes an optional second argument - only
  `listMeetings()` passes it, every other caller (`createUploadToken`,
  etc.) gets the plain old prefix-slice preview. When the query actually
  matches inside the transcript, `buildSnippet()` returns the text
  *around* that match (with `SNIPPET_CONTEXT_CHARS` on each side) instead
  of always the first `PREVIEW_LENGTH` characters - a hit 10 minutes into
  a long meeting was otherwise invisible in the dashboard row. If the
  query matched the title or a tag instead (both already visible
  elsewhere on the row), `buildSnippet()` returns `null` and the row falls
  back to the normal prefix preview.
- **Jump on the meeting page**: clicking a dashboard row while a search is
  active navigates to `/meeting/{id}?q=<query>` instead of the plain path
  (see `Dashboard.js`'s row `onClick`). `app/meeting/[id]/page.js` reads
  `searchParams.q` and passes it to `MeetingDetail` as `initialQuery`. On
  load, a `useEffect` (placed *after* the `currentGroups` `useMemo` it
  depends on - a temporal-dead-zone bug if it's declared earlier) finds
  the first utterance group containing the query and calls
  `scrollIntoView({ behavior: 'smooth', block: 'center' })` on it via a
  `groupRefs` map of index → DOM node, populated by wrapping each
  `SpeakerLine` in a `<div ref={...}>` (a plain function component can't
  take a `ref` directly without `forwardRef`, so the wrapper is simpler
  than converting it). Guarded by `hasJumpedRef` so it only runs once per
  page load, not on every `currentGroups` recompute.

Both the dashboard snippet and the meeting page's speaker/plain-text views
share one `highlightText(text, query)` helper in `lib/utils.js` (not
`app/lib/`, since it's plain client-safe code, not a server-only
data-access function) - it returns an array of strings and `<mark>`
elements, never `dangerouslySetInnerHTML`, since the transcript text this
wraps is Deepgram/user-sourced (see the no-raw-HTML-injection rule under
"Security" below). The meeting title is deliberately *not* run through
this, even though it's a real match target - it's a `contentEditable`
span, and injecting React elements as children of a `contentEditable`
region interacts badly with reading `textContent` back out on blur.

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

## API key auth for machine clients

Every mutation in this app so far has been a Server Action behind
`verifySession()`, which only works from a browser that's holding this
app's own session cookie. That's a real wall for the two follow-on
clients this feature exists for - a desktop app (a native process, no
browser) and a Chrome extension (a background script, not a page this
app rendered) - neither can call a Server Action at all: Server Actions
are POSTs to an encrypted, browser-session-bound action id, not a stable
HTTP API a native Rust process or an extension can target. See
`docs/superpowers/specs/2026-09-02-desktop-extension-capture-design.md`'s
"Authentication for machine clients" for the design this implements.

The fix is a second, additive-only auth mechanism - a long-lived personal
API key, the same shape as a GitHub PAT - that machine clients use
instead of a session cookie, without duplicating a single line of the
business logic the browser path already exercises:

- **`ApiKey` model** (`app/lib/models/ApiKey.js`): `{ userId, keyHash,
  label, createdAt, lastUsedAt }`. Only the SHA-256 hash of the raw key is
  ever stored - the raw key is shown to the user exactly once, at
  creation, in `app/actions/settings.js`'s `createApiKey()`, and is not
  recoverable after that, matching how a password is never stored in
  plaintext either. Deliberately long-lived, unlike `UploadToken` - but
  still a bounded, low-blast-radius grant: a key can only ever do what a
  logged-in browser tab can already do (start one transcription job at a
  time, or report one upload as failed), never act as a general-purpose
  account credential (it can't read a transcript, change a password, or
  touch anything `UploadToken`/`markMeetingFailedCore` don't already
  reach). One deliberate exception: `GET /api/tokens/meetings` (see
  below) gives a key read access to its own user's meeting *status*
  metadata only - never transcript content.
- **`app/lib/apiKeys.js`** (`server-only`) holds `hashApiKey()` (the
  shared SHA-256 hex-digest function - previously defined three times,
  once per call site, which had already let the surrounding auth-check
  logic drift: one route trimmed the Bearer token and 401'd on an
  empty-after-trim value, the other trimmed but never checked) and
  `authenticateApiKey(request)`, which parses the `Authorization: Bearer
  <key>` header, hashes it, looks it up, updates `lastUsedAt`, and
  returns the `ApiKey` document (or `null` for any invalid/missing
  case) - the one mechanism both routes below now share, so this
  particular drift can't recur.
- **Route Handlers**, `app/api/tokens/upload/route.js` and
  `app/api/tokens/mark-failed/route.js` - justified under the Route
  Handler rule below as "a request initiated by something outside this
  app": not a browser POSTing this app's own form/fetch, but a native
  client or extension authenticating with a bearer credential instead of
  a session cookie, which a Server Action structurally cannot accept.
  Each one's entire job is resolving `userId` from the API key, then
  delegating to the exact same core logic the browser session path
  already uses - `mintUploadToken()` (`app/lib/uploadTokens.js`) and
  `markMeetingFailedCore()` (`app/lib/meetings.js`) respectively - so
  there is exactly one implementation of "mint a token and create the
  Meeting row" and exactly one of "flip a meeting to failed and notify,"
  no matter which auth mechanism got you there. Both core functions live
  in `server-only` lib files, never in a `'use server'` actions file -
  see "Server Actions vs. auth-agnostic core logic" below for why that
  placement is load-bearing, not incidental. `app/api/tokens/validate/route.js`
  follows the same auth mechanism (`authenticateApiKey`) with no side
  effect of its own - used to confirm a key is real before saving it in
  the desktop app/extension Settings UI. `app/api/tokens/meetings/route.js`
  is the one read-capable exception described above: `authenticateApiKey`
  resolves `userId`, then `listMeetingsForApiKey(userId)`
  (`app/lib/meetings.js`) returns each meeting through `toApiKeySummary()`
  - a mapper kept deliberately separate from `toSummary()`, since
  `toSummary()`'s `preview` field carries real transcript text and this
  route must never return that. Feeds the desktop app's native "Recent
  Recordings" list (see `docs/superpowers/specs/2026-09-05-desktop-native-recordings-view-design.md`) -
  reading the actual transcript still happens on the website.
- **Settings UI**: an "API Keys" section in `/settings`
  (`ApiKeysSection` in `app/settings/SettingsView.js`), following the
  same section-nav pattern as the existing Webhooks settings. Lets the
  user generate a key (shown once, with a copy button) and revoke one
  (`revokeApiKey(id)` in `app/actions/settings.js`, ownership-scoped the
  same way every other mutation in this app is - `deleteOne({ _id: id,
  userId })` - and guarded against a malformed `id` the same way
  `deleteMeetings()` guards its `deleteMany()`, so a bad id comes back as
  `{ ok: false }` instead of throwing a Mongoose `CastError`).
  `createApiKey()` returns the real database id (`String(apiKey._id)`)
  alongside the raw key, so a freshly-created row is revokable the
  instant it appears - no placeholder id, no disabled Revoke button, no
  "refresh the page first" workaround.

## Server Actions vs. auth-agnostic core logic

`app/actions/meetings.js` and `app/actions/settings.js` both start with
`'use server'`, which means **every exported async function in either
file becomes a callable Server Action with its own action id** -
reachable by anyone who obtains that id, not just the code that imports
it. `app/lib/uploadTokens.js` and `app/lib/meetings.js`, by contrast, are
`server-only` (not `'use server'`): importable from server code, but
never compiled into the client-reachable server-reference graph.

This distinction is a real security boundary, not a style preference. A
core function like `markMeetingFailedCore({ meetingId, userId, message })`
trusts a caller-supplied `userId` directly - by design, since its whole
purpose is to be called by two different auth mechanisms (a session
cookie in `app/actions/meetings.js`'s `markMeetingFailed()`, an API key
in `app/api/tokens/mark-failed/route.js`) that each resolve `userId`
their own way before delegating. That's exactly what a client should
never be able to trigger directly with an arbitrary `userId` of its own
choosing - this app's own Security rule ("never trust a client-supplied
user id"). So the rule for any function shaped like this - does real
work, takes `userId` as a parameter instead of calling
`verifySession()` itself - is: it belongs in a `server-only` lib file
(`app/lib/uploadTokens.js`'s `mintUploadToken()`,
`app/lib/meetings.js`'s `markMeetingFailedCore()`/`sendNotifications()`),
never in a `'use server'` actions file, even if nothing in the UI
currently imports it from anywhere else. The thin `verifySession()` +
delegate wrapper (`createUploadToken()` in `app/actions/transcribe.js`,
`markMeetingFailed()` in `app/actions/meetings.js`) is what actually
belongs in the `'use server'` file - it has no logic worth protecting on
its own, only an auth check and a one-line delegation.

## Stack (frontend)

- Next.js 16 (App Router), React 19, JavaScript (no TypeScript).
- Server Components for reads, Server Actions for every mutation except the
  file upload itself (see above). Route Handlers are the exception, not
  the default, and each one currently in this app is justified the same
  way: "a request initiated by something outside this app," not a
  browser POSTing this app's own form/fetch. That's `app/api/auth/google/route.js`
  and its `callback/route.js` (Google redirects the browser here with a
  plain GET it initiates - see "Sign in with Google"), and
  `app/api/tokens/upload/route.js` and `app/api/tokens/mark-failed/route.js`
  (an authenticated Bearer-token POST from a desktop app or Chrome
  extension, not a browser - see "API key auth for machine clients"
  above). Don't add a Route Handler for anything else without the same
  justification; everything that isn't "a request initiated by something
  outside this app" belongs in a Server Action or a Server Component
  instead.
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
  `PasswordResetToken.js`, `ApiKey.js` (see "API key auth for machine
  clients"), `MeetingActionToken.js` (see "Retry and Cancel").
- `app/lib/email.js`: `sendMeetingEmail()` and `sendPasswordResetEmail()`,
  the frontend half of email - see "Email notifications" and "Password
  reset".
- `app/lib/webhook.js`: `sendMeetingWebhook()`, the frontend half of
  webhook notifications - see "Webhook notifications".
- `app/lib/oauth.js`: Google config + Authorization Code flow helpers - see
  "Sign in with Google".
- `app/lib/apiKeys.js`: `hashApiKey()` and `authenticateApiKey(request)`,
  shared by `createApiKey()` and both `/api/tokens/*` Route Handlers - see
  "API key auth for machine clients".
- `app/lib/uploadTokens.js`: `mintUploadToken({ userId, fileName })`, the
  auth-agnostic core of "mint an upload token and create the Meeting row"
  - called by both `createUploadToken()` (session) and
  `/api/tokens/upload` (API key). See "Server Actions vs. auth-agnostic
  core logic".
- `app/lib/session.js`: cookie/session primitives (`createSession`,
  `getSessionUserId`, `deleteSession`).
- `app/lib/dal.js`: `verifySession()`, the auth boundary.
- `app/lib/meetings.js`: `toSummary`/`toDetail` (plain-object conversion,
  see above), `listMeetings` (search, incl. tags), `findOwnedMeeting`
  (ownership-scoped, live document, for mutations), `findOwnedMeetingLean`
  (ownership-scoped, read-only), `findMeetingByShareToken` (public,
  unauthenticated lookup), `listKnownSpeakerNames` (rename autocomplete
  source), `getUsageSummary` (this-month cost/minutes total - see "Cost
  tracking"), `sendNotifications` and `markMeetingFailedCore` (the
  auth-agnostic core behind `markMeetingFailed`/`resendNotifications` in
  `app/actions/meetings.js` and `/api/tokens/mark-failed` - see "Server
  Actions vs. auth-agnostic core logic").
- `app/actions/`: every Server Action (`auth.js` [signup/login/logout,
  `requestPasswordReset`, `resetPassword`], `meetings.js` [`getMeeting`,
  title/speaker rename, `mergeSpeakers`, `markMeetingFailed`,
  `resendNotifications`, `updateMeetingTags`, `deleteMeetings`,
  `addTagToMeetings` (see "Bulk actions"), delete, share links],
  `settings.js` [`getWebhooks`, `saveWebhooks`, `createApiKey`,
  `revokeApiKey` (see "API key auth for machine clients")],
  `transcribe.js` [token minting, also creates the `Meeting` row - see
  "Upload token flow"], `search.js`).
- `lib/utils.js` (project root, not `app/lib/`): `cn()` (shadcn's Tailwind
  class merge) and `highlightText()` (search-match highlighting - see
  "Search result highlighting and jump-to-match"). Plain client-safe code
  shared by both `Dashboard.js` and `MeetingDetail.js`, which is why it
  lives outside `app/lib/` (that directory is `server-only`).
- `app/login/`, `app/signup/`, `app/forgot-password/`,
  `app/reset-password/[token]/`, `app/meeting/[id]/`, `app/share/[token]/`:
  one folder per route; `page.js` is the Server Component (auth check + data
  fetch), a sibling Client Component (e.g. `MeetingDetail.js`) owns the
  interactive UI.
- `app/api/auth/google/route.js`, `app/api/auth/google/callback/route.js`:
  the OAuth Route Handlers - see "Sign in with Google" for why these are
  Route Handlers.
- `app/api/tokens/upload/route.js`, `app/api/tokens/mark-failed/route.js`,
  `app/api/tokens/validate/route.js`, `app/api/tokens/meetings/route.js`:
  the API-key Route Handlers for machine clients - see "API key auth for
  machine clients".
- `app/OAuthButtons.js`: the "Continue with Google" button, a shared
  Server Component rendered on both `/login` and `/signup`.
- `app/Dashboard.js`: the dashboard's Client Component, rendered by
  `app/page.js`. Owns the direct-to-backend multi-file upload (see
  "Multi-file upload") and the webhook settings dialog.
- `components/ui/`: shadcn components. Edit sparingly; prefer composing
  them from a page over changing the primitives.
- `backend/server.js`: the whole Express app (health checks, `/api/transcribe`,
  `/api/meetings/retry`, `/api/meetings/cancel`), `runTranscriptionJob()`
  (see "Retry and Cancel"), plus `sweepStaleJobs()`, `sweepOrphanedFiles()`,
  and `sweepPendingCosts()` (see "Cost tracking").
- `backend/services/deepgram.js`: extraction + `transcribeWithRetry` +
  `fetchExactCost()` (see "Cost tracking"), kept byte-for-byte equivalent in
  spirit to how it worked before the split.
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
  `DEEPGRAM_API_KEY`, `DEEPGRAM_PROJECT_ID`, `DEEPGRAM_RATE_PER_MINUTE_USD`,
  `MONGODB_URI`, `ALLOWED_ORIGINS`, `RESEND_API_KEY`, `EMAIL_FROM`,
  `FRONTEND_URL`); each `.env.example` documents its required vars with no
  values. `DEEPGRAM_API_KEY` never goes in the frontend's `.env` - all
  Deepgram calls, including the Management API cost lookup, happen on the
  backend only (see "Cost tracking").
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
- `mintUploadToken()` and `markMeetingFailedCore()` are exceptions to
  "never trust a client-supplied user id" in the sense that they *take*
  `userId` as a parameter rather than deriving it from a session - that's
  fine specifically because neither is ever reachable directly by a
  client. Both live in `server-only` lib files, never in a `'use server'`
  actions file, and every caller (a Server Action wrapper, or a Route
  Handler that resolved `userId` from a verified API key) resolves
  `userId` through a real auth mechanism before calling in. See "Server
  Actions vs. auth-agnostic core logic".

## External API calls

Retry `429`/`5xx` with exponential backoff (respect `Retry-After`), never
retry `4xx`. Every outbound call has a timeout. See `transcribeWithRetry` in
`backend/services/deepgram.js` for the reference pattern.

`fetchExactCost()` (also in `deepgram.js`) is a deliberate exception: it
never retries within a single call, and treats every failure - 404, other
non-2xx, timeout, network error - identically, as "return `null`, try
again on the next sweep interval." A 404 there doesn't mean the resource
doesn't exist, it means Deepgram hasn't indexed the billing data for that
request yet; `sweepPendingCosts()`'s recurring interval already *is* the
retry loop, so the function itself doesn't need its own.

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
