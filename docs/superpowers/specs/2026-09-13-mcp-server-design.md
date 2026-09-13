# MCP server for transcript access and summaries

**Status:** Approved for planning
**Author:** Om Rajpal + Claude
**Date:** 2026-09-13

## Context and goals

Every meeting transcript today is only readable through the website
(`MeetingDetail.js`), one meeting at a time, with no built-in
summarization. The user wants to point an MCP client (Claude Desktop, or
any other MCP-capable client) at their own meeting history, so that
client's own model can read transcripts, answer questions about them, and
generate a summary that gets saved back onto the meeting record for later
viewing on the website.

Goal: add a `POST /mcp` route to the already-deployed `backend/` Express
service (no new hosting), authenticated by a new, narrowly-scoped
credential, exposing a small set of read tools plus one write tool for
saving a generated summary.

### Non-goals

- No in-app AI chat feature, no backend-side call to any LLM API. The
  backend never generates a summary itself - it only serves transcript
  data to whatever MCP client is connected, and stores back the summary
  that client produces. This keeps `CLAUDE.md`'s "No AI chat / OpenAI /
  ChatGPT feature" rule intact - this is a data-access layer, not a new
  AI integration owned by this app.
- No change to the existing `ApiKey` model or its two Route Handlers
  (`/api/tokens/upload`, `/api/tokens/mark-failed`, `/api/tokens/validate`,
  `/api/tokens/meetings`). Those stay exactly as restricted as they are
  today (`toApiKeySummary()` never includes transcript text).
- No UI for browsing/searching meetings beyond what the MCP tools
  themselves expose to the connected client. The one UI change is
  rendering a saved `summary` field on the meeting page, if present.
- No editing of tags, speaker names, or anything else via MCP. Read
  meetings/transcripts, write a summary - nothing more.

## Design

### 1. New credential: `McpToken`

Mirroring the existing convention (`UploadToken`, `MeetingActionToken`):
the token is *issued* by the frontend the same way `ApiKey` is
(`app/actions/settings.js`, shown once, hashed before storage) and
*verified* by the backend, since the backend is what serves `/mcp`. So the
model must exist in both places, schema-identical:

- `app/lib/models/McpToken.js` (frontend, `server-only`)
- `backend/models/McpToken.js` (backend, plain Mongoose)

Shape, deliberately identical to `ApiKey`:

```js
{
  userId: ObjectId,   // ref User, required, indexed
  keyHash: String,    // sha256, required, unique
  label: String,      // required, e.g. "Claude Desktop"
  createdAt: Date,
  lastUsedAt: Date
}
```

Raw key format `mcp_<64 hex chars>` (vs. `ApiKey`'s `mtk_` prefix) so a
leaked key's origin is identifiable at a glance. Hashing reuses the exact
`hashApiKey()` SHA-256 function from `app/lib/apiKeys.js` (renamed
in-place to `hashToken()` since it's no longer ApiKey-specific; both
`ApiKey` and `McpToken` creation/lookup call the same function - one
hashing implementation, not two copies drifting the way the pre-existing
API-key routes once did).

This is a genuinely separate credential type from `ApiKey`, not a scope
flag on it, so that a leaked desktop-app `ApiKey` (which today cannot read
a transcript) continues to be unable to, regardless of anything added
here.

### 2. Settings UI: "MCP Access" section

A fifth section in `/settings` (`app/settings/SettingsView.js`), following
the exact `ApiKeysSection` pattern (same component shape, same
create/copy-once/revoke flow), backed by two new Server Actions in
`app/actions/settings.js`:

- `createMcpToken(label)` - mirrors `createApiKey()`: mints `mcp_<hex>`,
  stores only the hash, returns the raw key once.
- `revokeMcpToken(id)` - mirrors `revokeApiKey()`: ownership-scoped
  `deleteOne({ _id: id, userId })`.

Card copy explains this key is different from an API key: "Gives an MCP
client (like Claude Desktop) read access to your meeting transcripts, and
lets it save a generated summary back to a meeting. Unlike an API key,
this can read your transcript content." The description matters here -
it is the one honest disclosure that this credential is more powerful
than the desktop app's key.

### 3. Auth on the backend: `authenticateMcpToken(request)`

New function in `backend/services/mcpAuth.js`, structurally identical to
`authenticateApiKey()` on the frontend (parse `Authorization: Bearer
<token>`, hash, look up `McpToken`, update `lastUsedAt`, return the
document or `null`). The backend has never needed its own bearer-token
auth helper before (its existing token flows - `UploadToken`,
`MeetingActionToken` - are single-use tokens embedded in a request body,
not a standing `Authorization` header credential), so this is new code,
not a port of existing backend code.

### 4. The `/mcp` route

`backend/mcp/server.js` builds an MCP server using
`@modelcontextprotocol/sdk` (new backend dependency) and mounts it at
`POST /mcp` in `backend/server.js`'s `main()`, using the SDK's Streamable
HTTP transport. Before any tool call is handled, the request is
authenticated via `authenticateMcpToken()`; a missing/invalid token
returns the transport's standard auth-error response, no meeting data
touched.

Four tools, every one of them scoped to the authenticated token's
`userId` - never a client-supplied id, same rule as everywhere else in
this app:

- **`list_meetings`** - params: none. Returns id, title, createdAt,
  durationSeconds, tags, status, and whether `summary` is already set,
  for every meeting owned by this user (newest first, same sort as the
  dashboard). No transcript text - this is for the client to see what's
  available before deciding what to pull.
- **`search_meetings`** - params: `query` (string). Same `$or` match as
  `listMeetings()` in `app/lib/meetings.js` (title/originalName/
  transcript/tags), returns the same summary shape as `list_meetings` plus
  a short transcript snippet around the match (reuses `buildSnippet()`'s
  logic).
- **`get_meeting`** - params: `id`. Returns the full transcript and
  speaker-labeled utterances for one meeting owned by this user (a
  meeting that exists but isn't theirs, or doesn't exist, returns the same
  "not found" tool error either way - no existence leak, same rule as the
  rest of the app). This is the one genuinely new capability; no existing
  API surface returns transcript text to a non-browser client.
- **`save_summary`** - params: `id`, `summary` (string, capped at 4000
  chars, mirroring the `MAX_TAG_LENGTH`-style server-side cap used
  elsewhere - never trust client-supplied length alone). Ownership-scoped
  update (`Meeting.findOneAndUpdate({ _id: id, userId }, { summary,
  summaryGeneratedAt: new Date() })`); returns a not-found tool error if
  it doesn't match.

Since these run inside `backend/`, they operate directly on the Mongoose
`Meeting` model already loaded there (`backend/models/Meeting.js`) -
there's no equivalent of `app/lib/meetings.js`'s `toDetail`/`toSummary`
mappers on the backend today, so the tool handlers build their own small
plain-object shapes directly (no Mongoose-to-client serialization concern
here, since MCP tool results are plain JSON returned from a Node process,
not React props crossing the Server/Client Component boundary).

### 5. Data model change: `Meeting.summary`

Two new fields, added identically to both `app/lib/models/Meeting.js` and
`backend/models/Meeting.js`:

```js
summary: String,
summaryGeneratedAt: Date,
```

`toDetail()` in `app/lib/meetings.js` exposes both. `MeetingDetail.js`
renders a small "Summary" card above the transcript tabs, shown only when
`meeting.summary` is present (no empty state - most meetings simply won't
have one until the user asks an MCP client to generate one). No new
Server Action needed to *write* this from the website side; it's
MCP-only, matching the non-goal above.

### 6. Error handling & security

- Every tool handler resolves `userId` from the authenticated
  `McpToken` document, never from a tool parameter - same rule as
  `markMeetingFailedCore()`/`mintUploadToken()` trusting a
  caller-resolved `userId` only because the resolution itself happened
  through a real auth mechanism first.
- `get_meeting`/`save_summary` never distinguish "meeting not found" from
  "meeting belongs to someone else" in their error message, consistent
  with the rest of the app's ownership rule.
- No internals (stack traces, Mongo error text) ever reach a tool
  response; caught and logged server-side, generic message returned,
  same as the existing `/api/transcribe`/`/api/meetings/*` routes.
- `/mcp` sits outside `ALLOWED_ORIGINS` CORS (this is a server-to-server
  MCP client, not a browser fetch), same category as the existing
  `/api/tokens/*` routes on the frontend side.
- `npm audit` clean in `backend/` after adding
  `@modelcontextprotocol/sdk`.

## Testing

Manual, end-to-end, against a real MCP client:

1. Generate an MCP token in Settings, confirm it's shown once and stored
   hashed.
2. Configure Claude Desktop's MCP config to point at
   `https://meeting-transcriber-i7s9.onrender.com/mcp` with that token.
3. From Claude Desktop: list meetings, search for one, pull its full
   transcript, ask for a summary, confirm it can call `save_summary`.
4. Reload the meeting's page on the website and confirm the summary
   appears.
5. Confirm ownership scoping: a token from user A cannot list or read
   user B's meetings (tested directly against the route, since a second
   real Google/email account is easy to create locally).
6. Revoke the token in Settings, confirm the next tool call is rejected.
7. `npm audit` in both `/` and `backend/` after the dependency changes.
