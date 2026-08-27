# Meeting Transcriber: Engineering Practices

Local-first Next.js app (App Router). Upload MP4/MP3, extract audio, transcribe
Hinglish speech with Deepgram (Nova-3, `language=multi`), keep a private
per-user history in MongoDB. Email/password auth only. **No AI chat / OpenAI
/ ChatGPT feature, do not add one.** "Sign in with ChatGPT" is not a real
OAuth flow for third-party apps.

## Stack

- Next.js 16 (App Router), React 19, JavaScript (no TypeScript).
- Server Components for reads, Server Actions for every mutation. There are
  deliberately **no Route Handlers** in this app: pages fetch data directly
  in Server Components, and forms/interactions call Server Actions
  imperatively. Don't add a Route Handler unless something genuinely needs a
  plain REST endpoint (e.g. a future external client).
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

## File layout

- `app/lib/db.js`: mongoose connection.
- `app/lib/models/User.js`, `Meeting.js`, `Session.js`
- `app/lib/session.js`: cookie/session primitives (`createSession`,
  `getSessionUserId`, `deleteSession`).
- `app/lib/dal.js`: `verifySession()`, the auth boundary. `hashToken` lives
  here too (currently unused; kept for a possible future personal-access-
  token / non-browser client path. Don't build that out until there's an
  actual client that needs it).
- `app/lib/meetings.js`: `toSummary`/`toDetail` (plain-object conversion,
  see above), `listMeetings` (search), `findOwnedMeeting` (ownership-scoped),
  `findMeetingByShareToken` (public, unauthenticated lookup).
- `app/lib/deepgram.js`: extraction + `transcribeWithRetry`.
- `app/actions/`: every Server Action (`auth.js`, `meetings.js`,
  `transcribe.js`, `search.js`).
- `app/login/`, `app/signup/`, `app/meeting/[id]/`, `app/share/[token]/`:
  one folder per route; `page.js` is the Server Component (auth check + data
  fetch), a sibling Client Component (e.g. `MeetingDetail.js`) owns the
  interactive UI.
- `app/Dashboard.js`: the dashboard's Client Component, rendered by
  `app/page.js`.
- `components/ui/`: shadcn components. Edit sparingly; prefer composing
  them from a page over changing the primitives.
- `uploads/`: scratch space, always cleaned up in a `finally`
  (`app/lib/deepgram.js`).

## Security (non-negotiable)

- Every meeting query filters by the session's userId
  (`findOwnedMeeting`/`listMeetings`). Never trust a client-supplied user id.
  A meeting that exists but isn't yours returns the same "not found" as one
  that doesn't exist at all, never a 403, don't leak existence.
- Never return internals (stack traces, file paths, raw ffmpeg stderr) from
  a Server Action. Mark an error `{ clientSafe: true }` when its message is
  safe to show; log everything else server-side and return a generic
  message (see `app/actions/transcribe.js`).
- Secrets only via `.env` (`DEEPGRAM_API_KEY`, `MONGODB_URI`); `.env.example`
  documents required vars with no values.
- Never build DOM content from user- or API-sourced data with `innerHTML` or
  `dangerouslySetInnerHTML`. This is React, so plain JSX children already
  escape correctly; don't introduce raw HTML injection points.
- Login failure message is always generic ("Invalid email or password"),
  never reveal whether the email exists.

## External API calls

Retry `429`/`5xx` with exponential backoff (respect `Retry-After`), never
retry `4xx`. Every outbound call has a timeout. See `transcribeWithRetry` in
`app/lib/deepgram.js` for the reference pattern.

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
  mistakes, Mongoose serialization) that only a live browser run surfaces,
  code review alone would have missed all of them.
- MongoDB: use plain scripts (`mongosh`, or a small Node script via
  `mongoose`/the driver) to inspect or seed data during testing.
- Clean up test artifacts (`uploads/` temp files, throwaway test
  users/meetings) after verifying, or state clearly what was left behind.
- `npm audit` should report 0 vulnerabilities after any dependency change.

## Git

Commits only when the user explicitly asks.
