# MCP Server for Transcript Access and Summaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `POST /mcp` route to the existing Render-deployed backend so an MCP client (Claude Desktop, etc.) can list/search/read the user's meeting transcripts and save a generated summary back onto the meeting record, using a new, narrowly-scoped credential separate from the desktop app's existing `ApiKey`.

**Architecture:** A new `McpToken` model (schema-identical frontend/backend, same pattern as `ApiKey`) is minted from a new Settings section. The backend exposes `POST /mcp` using `@modelcontextprotocol/sdk`'s stateless Streamable HTTP transport, authenticated by a new `authenticateMcpToken()` helper, with four tools (`list_meetings`, `search_meetings`, `get_meeting`, `save_summary`) that read/write the existing `Meeting` collection directly. `Meeting.summary`/`summaryGeneratedAt` are new fields, surfaced on the meeting page.

**Tech Stack:** Node/Express (backend), Next.js Server Actions (frontend), Mongoose, `@modelcontextprotocol/sdk` (new backend dependency), `zod` (new backend dependency, required by the SDK's tool schemas).

**Spec:** `docs/superpowers/specs/2026-09-13-mcp-server-design.md`

## Global Constraints

- Every tool/action resolves `userId` from an authenticated token, never a client-supplied id. A meeting that exists but isn't the caller's returns the same "not found" as one that doesn't exist.
- `McpToken` is a separate model from `ApiKey` - never widen what the existing `ApiKey` (used by the desktop app) can do.
- The backend never calls an LLM itself. It only serves data and stores back a summary the connected MCP client produced. No AI-chat feature is being added to this app.
- Only the SHA-256 hash of a raw token is ever stored; the raw value is returned exactly once, at creation.
- No internals (stack traces, Mongo errors, filesystem paths) ever reach a tool response or HTTP error body - log server-side, return a generic message.
- **This repo has no automated test suite** (no `test` script in either `package.json`; `CLAUDE.md`'s own Testing section documents manual/live verification - Playwright, `mongosh`, `curl` - as the established convention here). Do not introduce a new test framework as part of this plan; every task below is verified manually, the same way every other feature in this codebase has been. Follow the existing pattern rather than the generic "write a failing unit test" step.
- `npm audit` must report 0 vulnerabilities in both `/` and `backend/` after dependency changes.

---

### Task 1: Rename `hashApiKey` to `hashToken`

`McpToken` creation/lookup will reuse this same hashing function on the frontend side (where tokens are minted), so it needs a name that isn't `ApiKey`-specific before a second caller shows up.

**Files:**
- Modify: `app/lib/apiKeys.js`
- Modify: `app/actions/settings.js`

**Interfaces:**
- Produces: `hashToken(rawKey: string): string` (SHA-256 hex digest), exported from `app/lib/apiKeys.js`, replacing `hashApiKey`.

- [ ] **Step 1: Rename the function and update its doc comment**

In `app/lib/apiKeys.js`, replace lines 5-12:

```js
// Shared by both createApiKey() and createMcpToken() (app/actions/settings.js,
// which hash a raw key exactly once, at creation, to store) and the two
// families of Route Handlers/backend auth that hash an incoming Bearer
// token to look it up. Previously defined three times with the exact same
// body - one shared definition means a future change to the hashing
// scheme only has one place to make it.
export function hashToken(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}
```

Also update the call site inside the same file, `authenticateApiKey()`:

```js
  const keyHash = hashToken(rawKey);
```

- [ ] **Step 2: Update the caller in `app/actions/settings.js`**

Change the import (line 8):

```js
import { hashToken } from '@/app/lib/apiKeys';
```

Change the call site inside `createApiKey()` (around line 100):

```js
  const keyHash = hashToken(rawKey);
```

- [ ] **Step 3: Verify no leftover references and lint clean**

Run: `grep -rn "hashApiKey" app/ backend/`
Expected: no matches.

Run: `npm run lint`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add app/lib/apiKeys.js app/actions/settings.js
git commit -m "Rename hashApiKey to hashToken ahead of McpToken reusing it"
```

---

### Task 2: `McpToken` model (frontend + backend)

**Files:**
- Create: `app/lib/models/McpToken.js`
- Create: `backend/models/McpToken.js`

**Interfaces:**
- Produces: default-exported Mongoose model `McpToken` with fields `{ userId, keyHash, label, createdAt, lastUsedAt }`, identical shape on both sides (same pattern as `ApiKey`).

- [ ] **Step 1: Create the frontend model**

`app/lib/models/McpToken.js`:

```js
import 'server-only';
import mongoose from 'mongoose';

// A separate credential from ApiKey, deliberately - not a scope flag on
// it. ApiKey (used by the desktop app) can never read transcript content;
// this token exists specifically to grant that to an MCP client (Claude
// Desktop, etc.), and keeping it a distinct model means a leaked ApiKey
// still can't do what this can. Same shape and hashing scheme as ApiKey
// (see app/lib/apiKeys.js's hashToken()) - only the raw key's prefix
// differs ("mcp_" vs "mtk_") so a leaked key's origin is identifiable at
// a glance.
const mcpTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  keyHash: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: null }
});

export default mongoose.models.McpToken || mongoose.model('McpToken', mcpTokenSchema);
```

- [ ] **Step 2: Create the backend model**

`backend/models/McpToken.js`:

```js
const mongoose = require('mongoose');

// Must match app/lib/models/McpToken.js in the Next.js app exactly - both
// services read/write the same MongoDB collection. Minted by the frontend
// (Settings), verified here (backend/services/mcpAuth.js) since this is
// the service that serves POST /mcp.
const mcpTokenSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  keyHash: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: null }
});

module.exports = mongoose.models.McpToken || mongoose.model('McpToken', mcpTokenSchema);
```

- [ ] **Step 3: Verify both load without error**

Run: `node -e "require('./backend/models/McpToken.js'); console.log('backend model ok')"`
Expected: prints `backend model ok`, no throw (this only exercises schema construction, no DB connection needed).

Run: `node -e "require('@swc/register'); " 2>/dev/null; true` — skip; instead sanity-check the frontend file has no syntax errors via lint:
Run: `npm run lint -- app/lib/models/McpToken.js`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add app/lib/models/McpToken.js backend/models/McpToken.js
git commit -m "Add McpToken model, schema-identical frontend and backend"
```

---

### Task 3: Frontend Settings actions for MCP tokens

**Files:**
- Modify: `app/actions/settings.js`

**Interfaces:**
- Consumes: `hashToken` from `app/lib/apiKeys.js` (Task 1), `McpToken` model (Task 2).
- Produces: `createMcpToken(label: string): Promise<{ rawKey, label, id } | { error }>`, `revokeMcpToken(id: string): Promise<{ ok: boolean }>`, both exported Server Actions.

- [ ] **Step 1: Add the import and create/revoke functions**

Add to the imports at the top of `app/actions/settings.js`:

```js
import McpToken from '@/app/lib/models/McpToken';
```

Append at the end of the file:

```js
// Mirrors createApiKey() above, but for the separate, wider-scoped
// McpToken credential - see "New credential: McpToken" in the design
// spec for why this is a distinct model rather than a capability on
// ApiKey. The "mcp_" prefix (vs. ApiKey's "mtk_") makes a leaked key's
// origin identifiable at a glance.
export async function createMcpToken(label) {
  const { userId } = await verifySession();
  await connectToDatabase();

  const trimmedLabel = typeof label === 'string' && label.trim()
    ? label.trim().slice(0, MAX_LABEL_LENGTH)
    : 'Unnamed MCP client';

  const rawKey = `mcp_${crypto.randomBytes(32).toString('hex')}`;
  const keyHash = hashToken(rawKey);

  const token = await McpToken.create({ userId, keyHash, label: trimmedLabel });

  return { rawKey, label: trimmedLabel, id: String(token._id) };
}

// Ownership-scoped exactly like revokeApiKey() above.
export async function revokeMcpToken(id) {
  const { userId } = await verifySession();
  await connectToDatabase();
  const result = await McpToken.deleteOne({ _id: id, userId }).catch(() => null);
  return { ok: Boolean(result?.deletedCount) };
}
```

- [ ] **Step 2: Verify manually**

Run: `npm run lint`
Expected: no new errors.

Full behavioral verification happens in Task 4 once the UI can call these.

- [ ] **Step 3: Commit**

```bash
git add app/actions/settings.js
git commit -m "Add createMcpToken/revokeMcpToken Server Actions"
```

---

### Task 4: Settings UI - "MCP Access" section

**Files:**
- Modify: `app/settings/page.js`
- Modify: `app/settings/SettingsView.js`

**Interfaces:**
- Consumes: `createMcpToken`, `revokeMcpToken` (Task 3).
- Produces: a fifth Settings section, `initialMcpTokens` prop shape `{ id, label, createdAt, lastUsedAt }[]`, matching `initialApiKeys`'s shape exactly so `McpAccessSection` can copy `ApiKeysSection`'s implementation.

- [ ] **Step 1: Fetch and pass MCP tokens from the Server Component**

In `app/settings/page.js`, add the import:

```js
import McpToken from '@/app/lib/models/McpToken';
```

Add alongside the existing `apiKeys` query:

```js
  const mcpTokens = await McpToken.find({ userId }).select('label createdAt lastUsedAt').sort({ createdAt: -1 }).lean();
```

Pass it to `SettingsView`, alongside the existing `initialApiKeys` prop:

```js
      initialMcpTokens={mcpTokens.map((t) => ({
        id: String(t._id),
        label: t.label,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt || null
      }))}
```

- [ ] **Step 2: Add the `McpAccessSection` component**

In `app/settings/SettingsView.js`, update the import line to also pull in the two new actions:

```js
import { saveWebhooks, createApiKey, revokeApiKey, createMcpToken, revokeMcpToken } from '@/app/actions/settings';
```

Add `Sparkles` to the `lucide-react` import list (used as this section's nav icon, distinct from `Laptop` for API Keys):

```js
import { Plus, X, Loader2, LogOut, KeyRound, Webhook as WebhookIcon, User, ChevronRight, Laptop, Sparkles, Copy, Check, ArrowLeft } from 'lucide-react';
```

Add a new entry to `SECTIONS` (after `'api-keys'`):

```js
const SECTIONS = [
  { id: 'account', label: 'Account', icon: User },
  { id: 'password', label: 'Password', icon: KeyRound },
  { id: 'webhooks', label: 'Webhooks', icon: WebhookIcon },
  { id: 'api-keys', label: 'API Keys', icon: Laptop },
  { id: 'mcp', label: 'MCP Access', icon: Sparkles }
];
```

Add the new component, right after `ApiKeysSection`'s closing brace:

```js
function McpAccessSection({ initialTokens }) {
  const [tokens, setTokens] = useState(initialTokens);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [newRawKey, setNewRawKey] = useState(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate() {
    setCreating(true);
    try {
      const result = await createMcpToken(label);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setNewRawKey(result.rawKey);
      setTokens((prev) => [{ id: result.id, label: result.label, createdAt: new Date().toISOString(), lastUsedAt: null }, ...prev]);
      setLabel('');
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id) {
    try {
      const result = await revokeMcpToken(id);
      if (!result?.ok) {
        toast.error('Could not revoke this token.');
        return;
      }
      setTokens((prev) => prev.filter((t) => t.id !== id));
      toast.success('MCP token revoked.');
    } catch {
      toast.error('Could not revoke this token.');
    }
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(newRawKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>MCP Access</CardTitle>
        <CardDescription>
          Lets an MCP client (like Claude Desktop) read your meeting transcripts and save a generated
          summary back to a meeting. Unlike an API key, this token can read your transcript content -
          only create one for a client you trust.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {newRawKey && (
          <div
            className="flex flex-col gap-2 rounded-[var(--cr-radius-md)] p-3"
            style={{ background: 'var(--cr-ink-raised)', border: '1px solid var(--cr-rule-strong)' }}
          >
            <p className="text-sm font-medium">Copy this token now — it won&apos;t be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-black/20 px-2 py-1.5 font-mono text-xs">{newRawKey}</code>
              <Button variant="outline" size="icon-sm" onClick={handleCopy}>
                {copied ? <Check /> : <Copy />}
                <span className="sr-only">Copy</span>
              </Button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Input
            placeholder='Label, e.g. "Claude Desktop"'
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button onClick={handleCreate} disabled={creating} className="shrink-0">
            {creating && <Loader2 className="animate-spin" />}
            <Plus /> New token
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          {tokens.length === 0 && <p className="text-sm text-muted-foreground">No MCP tokens yet.</p>}
          {tokens.map((token) => (
            <div key={token.id} className="flex items-center gap-3 rounded-[var(--cr-radius-md)] border border-[var(--cr-rule-strong)] px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{token.label}</div>
                <div className="text-xs text-muted-foreground">{formatRelativeDate(token.lastUsedAt)}</div>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRevoke(token.id)}
                    >
                      <X />
                      <span className="sr-only">Revoke</span>
                    </Button>
                  }
                />
                <TooltipContent>Revoke this token</TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

Update the top-level `SettingsView` function signature and render body to thread the new prop through:

```js
export default function SettingsView({ userEmail, avatarUrl, hasGoogle, hasPassword, initialWebhooks, initialApiKeys, initialMcpTokens }) {
```

```js
            {active === 'api-keys' && <ApiKeysSection initialKeys={initialApiKeys} />}
            {active === 'mcp' && <McpAccessSection initialTokens={initialMcpTokens} />}
```

- [ ] **Step 2: Verify live in the browser**

Run: `npm run dev` (frontend) with a local MongoDB already running (`mongod` or your usual local instance) and `backend`'s own `npm start` not required for this step.

Using the Playwright MCP tools (`browser_navigate`, `browser_snapshot`, `browser_type`, `browser_click`):
1. Log in (or sign up a throwaway test account).
2. Navigate to `/settings`, click "MCP Access" in the nav.
3. Type a label, click "New token", confirm the raw key banner appears and the new row shows up in the list.
4. Reload `/settings` and confirm the token is still listed (fetched from the DB, not just local state) with the label but never the raw key again.
5. Click Revoke, confirm the row disappears and a second reload doesn't bring it back.

- [ ] **Step 3: Commit**

```bash
git add app/settings/page.js app/settings/SettingsView.js
git commit -m "Add MCP Access section to Settings UI"
```

---

### Task 5: `Meeting.summary` field and display

**Files:**
- Modify: `app/lib/models/Meeting.js`
- Modify: `backend/models/Meeting.js`
- Modify: `app/lib/meetings.js`
- Modify: `app/meeting/[id]/MeetingDetail.js`

**Interfaces:**
- Produces: `Meeting.summary: String`, `Meeting.summaryGeneratedAt: Date` on both schemas; `toDetail()` includes `summary: string | null` and `summaryGeneratedAt: string | null` (ISO string).

- [ ] **Step 1: Add the fields to both Meeting schemas**

In `app/lib/models/Meeting.js`, add after the `tags` field (before `shareToken`):

```js
  // Written only by the MCP server (backend/mcp/server.js's save_summary
  // tool) - no website UI writes this directly. Absent (undefined) on
  // every meeting until an MCP client generates one; MeetingDetail.js
  // shows nothing when it's unset rather than an empty-state placeholder.
  summary: String,
  summaryGeneratedAt: Date,
```

Make the identical addition, in the identical position, to `backend/models/Meeting.js`.

- [ ] **Step 2: Expose it from `toDetail()`**

In `app/lib/meetings.js`, inside `toDetail()`, add alongside the other simple fields (right after the `tags` line):

```js
    summary: meeting.summary || null,
    summaryGeneratedAt: meeting.summaryGeneratedAt ? meeting.summaryGeneratedAt.toISOString() : null,
```

- [ ] **Step 3: Render it in `MeetingDetail.js`**

Insert a new block between the tags row (ending at line 605, `</div>`) and the transcript `CardContent` (starting at line 607), so it reads:

```js
          </div>

          {meeting.summary && (
            <div className="mx-4 mt-3 rounded-[var(--cr-radius-md)] border border-[var(--cr-rule-strong)] p-3" style={{ background: 'var(--cr-ink-raised)' }}>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Summary</div>
              <p className="text-sm whitespace-pre-wrap">{meeting.summary}</p>
            </div>
          )}

          <CardContent className="px-4 pt-4 pb-4">
```

- [ ] **Step 4: Verify manually**

With a local MongoDB running and at least one completed test meeting, set a summary by hand:

```bash
mongosh "$MONGODB_URI" --eval '
  db.meetings.updateOne(
    { _id: ObjectId("<a real completed meeting id from your dev DB>") },
    { $set: { summary: "Test summary text.", summaryGeneratedAt: new Date() } }
  )
'
```

Load that meeting's page (`npm run dev` running) and confirm the "Summary" block renders above the transcript. Load a different meeting with no `summary` field and confirm nothing extra renders there.

- [ ] **Step 5: Commit**

```bash
git add app/lib/models/Meeting.js backend/models/Meeting.js app/lib/meetings.js "app/meeting/[id]/MeetingDetail.js"
git commit -m "Add Meeting.summary field and render it on the meeting page"
```

---

### Task 6: Backend MCP token auth helper

**Files:**
- Create: `backend/services/mcpAuth.js`

**Interfaces:**
- Consumes: `McpToken` model (Task 2).
- Produces: `authenticateMcpToken(req): Promise<McpTokenDocument | null>`, used by Task 7's `/mcp` route.

- [ ] **Step 1: Write the helper**

`backend/services/mcpAuth.js`:

```js
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
```

- [ ] **Step 2: Verify with a throwaway script**

With a local MongoDB running and at least one `McpToken` row created via the Settings UI (Task 4), run a quick manual check:

```bash
cd backend
node -e "
require('dotenv').config();
const mongoose = require('mongoose');
const { authenticateMcpToken } = require('./services/mcpAuth');
(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const fakeReqNoAuth = { headers: {} };
  console.log('no header ->', await authenticateMcpToken(fakeReqNoAuth));
  const fakeReqBadToken = { headers: { authorization: 'Bearer not-a-real-token' } };
  console.log('bad token ->', await authenticateMcpToken(fakeReqBadToken));
  process.exit(0);
})();
"
```

Expected: both print `null`. (A real-token success case is exercised end-to-end in Task 8.)

- [ ] **Step 3: Commit**

```bash
git add backend/services/mcpAuth.js
git commit -m "Add backend McpToken bearer-auth helper"
```

---

### Task 7: `/mcp` route and the four MCP tools

**Files:**
- Modify: `backend/package.json`
- Create: `backend/mcp/server.js`
- Modify: `backend/server.js`

**Interfaces:**
- Consumes: `authenticateMcpToken` (Task 6), `Meeting` model (existing, plus Task 5's new fields).
- Produces: `buildMcpServer(userId: string): McpServer`, exported from `backend/mcp/server.js`; mounted as `POST /mcp` in `backend/server.js`.

- [ ] **Step 1: Add dependencies**

```bash
cd backend
npm install @modelcontextprotocol/sdk zod
```

Expected: `backend/package.json`'s `dependencies` now includes `@modelcontextprotocol/sdk` and `zod`; `backend/package-lock.json` updated.

- [ ] **Step 2: Write the MCP server and its four tools**

`backend/mcp/server.js`:

```js
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { z } = require('zod');
const Meeting = require('../models/Meeting');

const SEARCH_SNIPPET_CONTEXT_CHARS = 60;
const MAX_SUMMARY_LENGTH = 4000;

// Escapes user input for safe use inside a RegExp - mirrors
// app/lib/meetings.js's escapeRegex() on the frontend. Duplicated rather
// than shared: this is a separate Node service with no access to the
// frontend's module graph.
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Mirrors app/lib/meetings.js's buildSnippet() - shows the transcript text
// around a search match instead of nothing, so a hit deep into a long
// meeting is still visible in the tool result. Returns null if the query
// isn't found in the transcript itself (it may have matched the title or
// a tag instead).
function buildSnippet(transcript, query) {
  if (!transcript || !query) return null;
  const idx = transcript.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;

  const start = Math.max(0, idx - SEARCH_SNIPPET_CONTEXT_CHARS);
  const end = Math.min(transcript.length, idx + query.length + SEARCH_SNIPPET_CONTEXT_CHARS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < transcript.length ? '…' : '';
  return `${prefix}${transcript.slice(start, end).trim()}${suffix}`;
}

function toListItem(meeting) {
  return {
    id: String(meeting._id),
    title: meeting.title || meeting.originalName || 'Untitled recording',
    createdAt: meeting.createdAt.toISOString(),
    durationSeconds: meeting.durationSeconds || null,
    tags: meeting.tags || [],
    status: meeting.status || 'complete',
    hasSummary: Boolean(meeting.summary)
  };
}

function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

// Builds a fresh McpServer scoped to one already-authenticated user. Every
// tool filters by this userId, never a client-supplied one - same rule as
// findOwnedMeeting()/markMeetingFailedCore() on the frontend. A meeting
// that exists but isn't this user's returns the same "not found" as one
// that doesn't exist at all, matching CLAUDE.md's ownership-leak rule.
function buildMcpServer(userId) {
  const server = new McpServer({ name: 'meeting-transcriber', version: '1.0.0' });

  server.registerTool(
    'list_meetings',
    {
      title: 'List meetings',
      description: 'Lists all of your meetings (newest first): id, title, date, duration, tags, status, and whether a summary already exists. No transcript text - use get_meeting for that.'
    },
    async () => {
      const meetings = await Meeting.find({ userId })
        .select('title originalName createdAt durationSeconds tags status summary')
        .sort({ createdAt: -1 })
        .lean();
      return jsonResult(meetings.map(toListItem));
    }
  );

  server.registerTool(
    'search_meetings',
    {
      title: 'Search meetings',
      description: 'Searches your meetings by title, filename, transcript content, and tags. Returns matches with a short snippet of transcript context.',
      inputSchema: { query: z.string().min(1) }
    },
    async ({ query }) => {
      const pattern = new RegExp(escapeRegex(query), 'i');
      const meetings = await Meeting.find({
        userId,
        $or: [{ title: pattern }, { originalName: pattern }, { transcript: pattern }, { tags: pattern }]
      })
        .select('title originalName createdAt durationSeconds tags status summary transcript')
        .sort({ createdAt: -1 })
        .lean();

      const results = meetings.map((m) => ({
        ...toListItem(m),
        snippet: buildSnippet(m.transcript || '', query)
      }));
      return jsonResult(results);
    }
  );

  server.registerTool(
    'get_meeting',
    {
      title: 'Get meeting transcript',
      description: 'Returns the full transcript and speaker-labeled utterances for one of your meetings, by id.',
      inputSchema: { id: z.string().min(1) }
    },
    async ({ id }) => {
      const meeting = await Meeting.findOne({ _id: id, userId }).lean().catch(() => null);
      if (!meeting) return errorResult('Meeting not found.');

      return jsonResult({
        id: String(meeting._id),
        title: meeting.title || meeting.originalName || 'Untitled recording',
        createdAt: meeting.createdAt.toISOString(),
        durationSeconds: meeting.durationSeconds || null,
        tags: meeting.tags || [],
        transcript: meeting.transcript || '',
        utterances: (meeting.utterances || []).map((u) => ({
          speaker: u.speaker,
          start: u.start,
          end: u.end,
          transcript: u.transcript
        })),
        summary: meeting.summary || null
      });
    }
  );

  server.registerTool(
    'save_summary',
    {
      title: 'Save a summary',
      description: 'Saves a generated summary back onto one of your meetings, so it shows up on the meeting page.',
      inputSchema: { id: z.string().min(1), summary: z.string().min(1).max(MAX_SUMMARY_LENGTH) }
    },
    async ({ id, summary }) => {
      const updated = await Meeting.findOneAndUpdate(
        { _id: id, userId },
        { summary, summaryGeneratedAt: new Date() },
        { new: true }
      ).catch(() => null);
      if (!updated) return errorResult('Meeting not found.');

      return jsonResult({ id: String(updated._id), summaryGeneratedAt: updated.summaryGeneratedAt.toISOString() });
    }
  );

  return server;
}

module.exports = { buildMcpServer };
```

- [ ] **Step 3: Mount `POST /mcp` in `backend/server.js`**

Add the imports near the top, alongside the other `require`s:

```js
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { authenticateMcpToken } = require('./services/mcpAuth');
const { buildMcpServer } = require('./mcp/server');
```

Add the route inside `main()`, after the existing `app.use(express.json());` line and before `app.get('/', ...)`:

```js
  // Stateless Streamable HTTP MCP endpoint - a fresh McpServer + transport
  // per request, scoped to whichever user the bearer token resolves to.
  // No session state kept between requests (sessionIdGenerator: undefined),
  // which is the documented stateless mode for this transport and is all
  // this app's four simple, self-contained tools need. Outside
  // ALLOWED_ORIGINS/CORS on purpose - this is a server-to-server MCP
  // client, not a browser fetch, same category as the frontend's
  // /api/tokens/* Route Handlers.
  app.post('/mcp', async (req, res) => {
    const mcpToken = await authenticateMcpToken(req).catch((error) => {
      console.error('MCP auth failed:', error);
      return null;
    });
    if (!mcpToken) {
      return res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Invalid or missing MCP token.' },
        id: null
      });
    }

    const server = buildMcpServer(String(mcpToken.userId));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('MCP request failed:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal error.' },
          id: null
        });
      }
    }
  });
```

- [ ] **Step 4: Verify with a real MCP client call**

Start the backend locally (`cd backend && npm start`, pointed at your local MongoDB), with a real `McpToken` raw key from Task 4's Settings UI test.

Write a throwaway test script (not part of the app - delete it after Task 8) using the SDK's own client, since that's the most faithful way to exercise the Streamable HTTP transport end-to-end without a full Claude Desktop install:

```bash
cd backend
node -e "
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

(async () => {
  const transport = new StreamableHTTPClientTransport(
    new URL('http://localhost:10000/mcp'),
    { requestInit: { headers: { Authorization: 'Bearer <paste your raw mcp_ token here>' } } }
  );
  const client = new Client({ name: 'manual-test', version: '1.0.0' });
  await client.connect(transport);

  const tools = await client.listTools();
  console.log('tools:', tools.tools.map((t) => t.name));

  const list = await client.callTool({ name: 'list_meetings', arguments: {} });
  console.log('list_meetings:', list.content[0].text);

  process.exit(0);
})();
"
```

Expected: `tools` includes all four names; `list_meetings` returns JSON matching your real dev-database meetings for that user.

Then, with a real completed meeting's id from that output, call `get_meeting` and `save_summary` the same way (`client.callTool({ name: 'get_meeting', arguments: { id: '<id>' } })`, then `save_summary` with a test string), and confirm the meeting page (from Task 5) shows the saved summary after a reload.

Also confirm rejection: repeat the `list_meetings` call with an invalid bearer token and confirm the connection/tool call fails with the 401 defined above.

- [ ] **Step 5: `npm audit`**

Run: `cd backend && npm audit`
Expected: `found 0 vulnerabilities`. If not, resolve before continuing (do not `--force` past a real vulnerability without understanding it first).

- [ ] **Step 6: Commit**

```bash
git add backend/package.json backend/package-lock.json backend/mcp/server.js backend/server.js
git commit -m "Add POST /mcp route with list/search/get/save-summary tools"
```

---

### Task 8: Full end-to-end verification and cleanup

This task has no new code - it re-verifies the whole feature together, including the one thing no earlier task can fully cover on its own: ownership scoping across two different real users, and (if available) a real Claude Desktop connection rather than the manual test script from Task 7.

**Files:** none (verification only).

- [ ] **Step 1: Two-user ownership scoping**

With both the frontend (`npm run dev`) and backend (`cd backend && npm start`) running locally against the same local MongoDB:

1. Sign up two throwaway accounts (User A, User B) via the normal signup flow.
2. As User A, upload or otherwise create at least one completed meeting, and mint an MCP token in Settings.
3. As User B, mint their own MCP token.
4. Using the Task 7 test-script pattern, call `list_meetings` and `search_meetings` with User A's token - confirm only User A's meeting(s) appear.
5. Repeat with User B's token - confirm User B sees no meetings (or only their own, if you created any).
6. Call `get_meeting` for User A's meeting id but using User B's token - confirm it returns the "Meeting not found." error, not User A's data.

- [ ] **Step 2: Revocation**

Revoke User A's MCP token from Settings, then repeat any tool call with that same raw key - confirm it now returns the 401 defined in Task 7.

- [ ] **Step 3: Real MCP client, if available**

If Claude Desktop (or another MCP-capable client) is installed on this machine, configure it to point at the locally running backend (`http://localhost:10000/mcp`) with User A's (non-revoked - mint a fresh one) token, and from that real client:

1. Ask it to list your meetings.
2. Ask it to summarize a specific one.
3. Confirm it can save that summary back (it should call `save_summary` on its own once it has generated the text - if it doesn't do so automatically, explicitly ask it to save the summary).
4. Reload that meeting's page on the website and confirm the summary shows.

If no MCP client is available on this machine to test with, state that explicitly rather than claiming this step passed - the Task 7 SDK-client script already exercises the same protocol path, but a real client is the actual target user experience and should be confirmed before calling this feature done, per this repo's own testing standard.

- [ ] **Step 4: `npm audit` on both services, one more time**

```bash
npm audit
cd backend && npm audit
```

Expected: `found 0 vulnerabilities` in both.

- [ ] **Step 5: Clean up test data**

Remove the throwaway User A/User B accounts, their meetings, and MCP tokens created during this task (via `mongosh` against your local dev database, or the app's own Delete UI) so they don't linger in the dev database. Delete any throwaway test scripts written during Task 7/8 that weren't meant to become part of the app.

- [ ] **Step 6: Final commit (if cleanup touched tracked files)**

Only needed if any tracked file changed during verification (it shouldn't have - this task is verification-only against local/dev data). If nothing is staged, skip this step.
