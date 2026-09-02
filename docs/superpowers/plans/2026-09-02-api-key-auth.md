# API Key Auth for Machine Clients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a non-browser client (the desktop app, the Chrome extension) mint an upload token and start a transcription job, using a long-lived personal API key instead of a browser session cookie.

**Architecture:** A new `ApiKey` model stores a hash of each key. The existing `createUploadToken()` Server Action logic is extracted into a shared, auth-agnostic helper (`mintUploadToken`) so both the browser-session path (Server Action) and the new API-key path (Route Handler) call the exact same code to create the `Meeting` row and `UploadToken`. Nothing on the Render backend changes — both paths still hand the client a token that gets consumed by the existing `/api/transcribe` endpoint exactly as today.

**Tech Stack:** Next.js 16 Server Actions + Route Handlers, Mongoose, Node's built-in `crypto` (SHA-256 hashing, matching the project's existing token-generation style in `UploadToken.js`), React 19 + shadcn/ui (Base UI) + Tailwind v4 for the Settings UI.

**Spec:** `docs/superpowers/specs/2026-09-02-desktop-extension-capture-design.md`

## Global Constraints

- No automated test framework exists in this repo (confirmed: no `jest`/`vitest`/`playwright` config, no `*.test.js` files) — per `CLAUDE.md`'s own Testing section, this project verifies features for real (manual browser checks, `curl`, `mongosh`/small Node scripts) rather than with a unit-test suite. Every task below ends with a concrete manual verification step, not an automated test, to match this project's actual convention rather than introducing a new one unilaterally.
- Every DB query must filter by the authenticated `userId` — never trust a client-supplied id (`CLAUDE.md` Security section).
- Never return internals (stack traces, raw Mongoose errors) from a Server Action or Route Handler — generic, client-safe messages only.
- The raw API key is shown to the user exactly once, at creation. Only its SHA-256 hash is ever stored.
- `app/lib/` files are server-only (each existing file there starts with `import 'server-only'`); Server Action files use `'use server'` instead — match whichever convention the file you're creating needs.

---

### Task 1: `ApiKey` model

**Files:**
- Create: `app/lib/models/ApiKey.js`

**Interfaces:**
- Produces: default-exported Mongoose model `ApiKey` with fields `{ userId: ObjectId (ref User, required, indexed), keyHash: String (required, unique, indexed), label: String (required), createdAt: Date, lastUsedAt: Date | null }`.

- [ ] **Step 1: Write the model**

```js
import 'server-only';
import mongoose from 'mongoose';

// A long-lived credential for a non-browser client (the desktop app, the
// Chrome extension) to mint upload tokens without a browser session
// cookie. Deliberately long-lived, unlike UploadToken - see
// "Authentication for machine clients" in the design spec for why that's
// still a bounded, low-blast-radius grant: it can only ever do what a
// logged-in browser tab can already do (start one transcription job at a
// time), never a general-purpose account credential.
//
// Only the SHA-256 hash of the raw key is ever stored - the raw key is
// shown to the user once, at creation, in app/actions/settings.js, and
// is not recoverable after that (matching how a password is never stored
// in plaintext either).
const apiKeySchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  keyHash: { type: String, required: true, unique: true },
  label: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
  lastUsedAt: { type: Date, default: null }
});

export default mongoose.models.ApiKey || mongoose.model('ApiKey', apiKeySchema);
```

- [ ] **Step 2: Verify it loads without error**

Run: `node -e "require('dotenv').config(); const mongoose = require('mongoose'); mongoose.connect(process.env.MONGODB_URI).then(async () => { const ApiKey = require('./app/lib/models/ApiKey').default; console.log(ApiKey.modelName, Object.keys(ApiKey.schema.paths)); process.exit(0); })"`

Expected: prints `ApiKey` followed by a list including `userId`, `keyHash`, `label`, `createdAt`, `lastUsedAt` — confirms the schema registers cleanly against the real database connection, no syntax/import errors.

- [ ] **Step 3: Commit**

```bash
git add app/lib/models/ApiKey.js
git commit -m "$(cat <<'EOF'
Add ApiKey model for machine-client authentication

Stores only a SHA-256 hash of each key, never the raw value, matching
how passwords are handled elsewhere in this app.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Extract `mintUploadToken` as a shared, auth-agnostic helper

**Files:**
- Create: `app/lib/uploadTokens.js`
- Modify: `app/actions/transcribe.js` (replace the body of `createUploadToken` with a call to the new helper)

**Interfaces:**
- Consumes: `Meeting`, `UploadToken`, `User` models (existing); `toSummary` from `app/lib/meetings.js` (existing).
- Produces: `export async function mintUploadToken({ userId, fileName })` returning either `{ token, backendUrl, meeting }` (same shape `createUploadToken()` already returns today) or `{ error: string }`. Takes a plain `userId` string/ObjectId directly — no session lookup inside it, so both the cookie-session path and the future API-key path can call it after they've each resolved `userId` their own way.

- [ ] **Step 1: Write the shared helper**

```js
import 'server-only';
import UploadToken from '@/app/lib/models/UploadToken';
import Meeting from '@/app/lib/models/Meeting';
import User from '@/app/lib/models/User';
import { toSummary } from '@/app/lib/meetings';

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes: long enough to start an upload, short enough to bound exposure

// The auth-agnostic core of "mint an upload token and create the Meeting
// row up front" - see CLAUDE.md's "Upload token flow" for why the
// Meeting is created here, before any bytes are sent. Callers
// (app/actions/transcribe.js's createUploadToken for the browser-session
// path, app/api/tokens/upload/route.js for the API-key path) are
// responsible for resolving `userId` through whichever auth mechanism
// they use, then calling this - so there is exactly one place that
// creates a Meeting + UploadToken pair, no matter which client asked.
export async function mintUploadToken({ userId, fileName }) {
  const user = await User.findById(userId).select('email webhooks').lean();
  if (!user) {
    return { error: 'Your session is no longer valid. Please log in again.' };
  }

  const title = typeof fileName === 'string' && fileName.trim() ? fileName.trim() : undefined;
  const meeting = await Meeting.create({
    userId,
    userEmail: user.email,
    userWebhooks: user.webhooks || [],
    title,
    originalName: title,
    speakerNames: {},
    status: 'processing'
  });

  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
  const tokenDoc = await UploadToken.create({ userId, meetingId: meeting._id, expiresAt });

  const backendUrl = process.env.NEXT_PUBLIC_TRANSCRIBE_BACKEND_URL;
  if (!backendUrl) {
    await meeting.deleteOne().catch(() => {});
    return { error: 'Transcription backend is not configured.' };
  }

  return { token: tokenDoc._id, backendUrl, meeting: toSummary(meeting) };
}
```

- [ ] **Step 2: Update `createUploadToken` to delegate to it**

Replace the full body of `app/actions/transcribe.js` with:

```js
'use server';

import { verifySession } from '@/app/lib/dal';
import { connectToDatabase } from '@/app/lib/db';
import { mintUploadToken } from '@/app/lib/uploadTokens';

const TOKEN_TTL_MS = 15 * 60 * 1000; // kept here as documentation of the contract; the real value lives in uploadTokens.js

// Mints a short-lived, single-use token authorizing one direct upload to
// the separate transcription backend, and creates the Meeting row
// (status 'processing') right now, before any bytes are sent - see
// mintUploadToken() in app/lib/uploadTokens.js for the shared logic, and
// CLAUDE.md's "Upload token flow" for the full picture. This wrapper's
// only job is resolving the authenticated user from the browser session
// cookie before delegating.
export async function createUploadToken(fileName) {
  const { userId } = await verifySession();
  await connectToDatabase();
  return mintUploadToken({ userId, fileName });
}
```

(The `TOKEN_TTL_MS` constant re-declaration is dead weight - remove it. It was only ever used inside the old inline body, which is now in `uploadTokens.js`.)

- [ ] **Step 3: Verify the existing upload flow still works**

Run the app locally (`npm run dev` here, `npm start` in `backend/`, both pointed at the same local MongoDB, per `CLAUDE.md`'s Testing section) and upload a real short audio/video file through the dashboard exactly as before. Confirm:
- The "Transcribing..." row appears immediately.
- It reaches `'complete'` with a real transcript.

This is a refactor with no intended behavior change, so this step is a regression check, not new-feature verification.

- [ ] **Step 4: Commit**

```bash
git add app/lib/uploadTokens.js app/actions/transcribe.js
git commit -m "$(cat <<'EOF'
Extract mintUploadToken as an auth-agnostic shared helper

Prepares for a second, API-key-based way to mint upload tokens
(machine clients) without duplicating the Meeting/UploadToken creation
logic. No behavior change for the existing browser-session path.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `/api/tokens/upload` Route Handler

**Files:**
- Create: `app/api/tokens/upload/route.js`

**Interfaces:**
- Consumes: `mintUploadToken` from `app/lib/uploadTokens.js`; `ApiKey` model.
- Produces: `POST /api/tokens/upload` — request: `Authorization: Bearer <rawKey>` header, JSON body `{ fileName?: string }`. Response: `200 { token, backendUrl, meeting }` (same shape as the Server Action) or `401 { error }` / `400 { error }`.

- [ ] **Step 1: Write the route**

```js
import 'server-only';
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/app/lib/db';
import ApiKey from '@/app/lib/models/ApiKey';
import { mintUploadToken } from '@/app/lib/uploadTokens';

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// The one entry point for a non-browser client (desktop app, Chrome
// extension) to mint an upload token. A Route Handler, not a Server
// Action, because this is "a request initiated by something outside
// this app" in the sense CLAUDE.md's Route Handler rule means - not a
// browser POSTing this app's own form/fetch, but a native client
// authenticating with a bearer credential instead of a session cookie.
// See "Authentication for machine clients" in the design spec.
export async function POST(request) {
  const authHeader = request.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return NextResponse.json({ error: 'Missing or invalid Authorization header.' }, { status: 401 });
  }
  const rawKey = match[1].trim();
  if (!rawKey) {
    return NextResponse.json({ error: 'Missing or invalid Authorization header.' }, { status: 401 });
  }

  await connectToDatabase();

  const keyHash = hashApiKey(rawKey);
  const apiKey = await ApiKey.findOne({ keyHash });
  if (!apiKey) {
    // Same "don't leak which part was wrong" instinct as login's
    // generic "Invalid email or password" - a bad key and a revoked key
    // look identical to the caller.
    return NextResponse.json({ error: 'Invalid or revoked API key.' }, { status: 401 });
  }

  apiKey.lastUsedAt = new Date();
  await apiKey.save();

  let fileName;
  try {
    const body = await request.json();
    fileName = body?.fileName;
  } catch {
    fileName = undefined;
  }

  const result = await mintUploadToken({ userId: apiKey.userId, fileName });
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result);
}
```

- [ ] **Step 2: Verify with `curl` against a real key**

This step depends on Task 4 existing to generate a real key first — if doing these tasks in order, come back to this verification after Task 4 and Task 5 are done and you have a real key from the Settings UI. Then:

```bash
curl -i -X POST http://localhost:3000/api/tokens/upload \
  -H "Authorization: Bearer <paste the raw key here>" \
  -H "Content-Type: application/json" \
  -d '{"fileName": "curl-test.wav"}'
```

Expected: `200` with a JSON body containing `token`, `backendUrl`, and `meeting` (with `meeting.status === 'processing'`). Then confirm in the dashboard that a "Transcribing..." row named "curl-test.wav" appeared even though nothing was ever uploaded to it (expected — this only mints the token and creates the row; it doesn't upload a file). Also verify the failure path:

```bash
curl -i -X POST http://localhost:3000/api/tokens/upload -H "Authorization: Bearer not-a-real-key"
```

Expected: `401` with `{"error":"Invalid or revoked API key."}`.

- [ ] **Step 3: Commit**

```bash
git add app/api/tokens/upload/route.js
git commit -m "$(cat <<'EOF'
Add /api/tokens/upload Route Handler for API-key clients

Lets the desktop app and Chrome extension mint upload tokens using a
long-lived API key instead of a browser session cookie, reusing the
existing mintUploadToken helper unchanged.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: `createApiKey` / `listApiKeys` / `revokeApiKey` Server Actions

**Files:**
- Modify: `app/actions/settings.js`

**Interfaces:**
- Consumes: `ApiKey` model, `verifySession` from `app/lib/dal.js`.
- Produces: `createApiKey(label)` → `{ rawKey, label } | { error }`; `listApiKeys()` → `{ keys: [{ id, label, createdAt, lastUsedAt }] }`; `revokeApiKey(id)` → `{ ok: true }`.

- [ ] **Step 1: Add the actions**

Add to the top of `app/actions/settings.js` (alongside the existing imports):

```js
import crypto from 'crypto';
import ApiKey from '@/app/lib/models/ApiKey';
```

Append these three functions to the end of the file:

```js
const MAX_LABEL_LENGTH = 60;

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// Shown to the caller exactly once, in the response of this action -
// never stored in plaintext, never retrievable again after this call
// returns. If it's lost, the only recovery is revoking it and creating
// a new one.
export async function createApiKey(label) {
  const { userId } = await verifySession();
  await connectToDatabase();

  const trimmedLabel = typeof label === 'string' && label.trim()
    ? label.trim().slice(0, MAX_LABEL_LENGTH)
    : 'Unnamed device';

  const rawKey = `mtk_${crypto.randomBytes(32).toString('hex')}`;
  const keyHash = hashApiKey(rawKey);

  await ApiKey.create({ userId, keyHash, label: trimmedLabel });

  return { rawKey, label: trimmedLabel };
}

export async function listApiKeys() {
  const { userId } = await verifySession();
  await connectToDatabase();

  const keys = await ApiKey.find({ userId }).select('label createdAt lastUsedAt').sort({ createdAt: -1 }).lean();
  return {
    keys: keys.map((k) => ({
      id: String(k._id),
      label: k.label,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt || null
    }))
  };
}

// Ownership-scoped the same way every other mutation in this app is -
// deleteOne with both _id and userId in the filter means a key that
// exists but isn't yours simply matches zero documents, not a 403.
export async function revokeApiKey(id) {
  const { userId } = await verifySession();
  await connectToDatabase();
  await ApiKey.deleteOne({ _id: id, userId });
  return { ok: true };
}
```

- [ ] **Step 2: Verify with a small Node script**

Per `CLAUDE.md`'s Testing section convention of using small Node scripts against the real database:

```bash
node -e "
require('dotenv').config();
const mongoose = require('mongoose');
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const ApiKey = require('./app/lib/models/ApiKey').default;
  const crypto = require('crypto');
  const rawKey = 'mtk_' + crypto.randomBytes(32).toString('hex');
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
  const doc = await ApiKey.create({ userId: new mongoose.Types.ObjectId(), keyHash, label: 'verify-script' });
  console.log('created', doc._id.toString());
  const found = await ApiKey.findOne({ keyHash });
  console.log('found by hash:', Boolean(found));
  await ApiKey.deleteOne({ _id: doc._id });
  console.log('cleaned up');
  process.exit(0);
});
"
```

Expected: prints a created id, `found by hash: true`, then `cleaned up` — confirms the hash-and-lookup mechanics work before wiring up the UI in the next task. (The Server Actions themselves get exercised end-to-end once the Settings UI exists — Task 5.)

- [ ] **Step 3: Commit**

```bash
git add app/actions/settings.js
git commit -m "$(cat <<'EOF'
Add createApiKey/listApiKeys/revokeApiKey server actions

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: "API Keys" section in Settings UI

**Files:**
- Modify: `app/settings/page.js` (pass initial keys down)
- Modify: `app/settings/SettingsView.js` (new nav entry + `ApiKeysSection` component)

**Interfaces:**
- Consumes: `listApiKeys`, `createApiKey`, `revokeApiKey` from `app/actions/settings.js`.

- [ ] **Step 1: Pass initial keys from the page**

In `app/settings/page.js`, add the import and fetch, and pass the prop:

```js
import { verifySession } from '@/app/lib/dal';
import { connectToDatabase } from '@/app/lib/db';
import User from '@/app/lib/models/User';
import ApiKey from '@/app/lib/models/ApiKey';
import SettingsView from './SettingsView';

export const metadata = { title: 'Settings - Meeting Transcriber' };

export default async function SettingsPage() {
  const { userId } = await verifySession();

  await connectToDatabase();
  const user = await User.findById(userId).lean();
  const apiKeys = await ApiKey.find({ userId }).select('label createdAt lastUsedAt').sort({ createdAt: -1 }).lean();

  return (
    <SettingsView
      userEmail={user?.email || ''}
      avatarUrl={user?.avatarUrl || null}
      hasGoogle={Boolean(user?.googleId)}
      hasPassword={Boolean(user?.passwordHash)}
      initialWebhooks={user?.webhooks || []}
      initialApiKeys={apiKeys.map((k) => ({
        id: String(k._id),
        label: k.label,
        createdAt: k.createdAt,
        lastUsedAt: k.lastUsedAt || null
      }))}
    />
  );
}
```

- [ ] **Step 2: Add the nav entry and section component**

In `app/settings/SettingsView.js`:

1. Add `Laptop` to the `lucide-react` import line, and add the imports for the new actions:

```js
import { Plus, X, Loader2, LogOut, KeyRound, Webhook as WebhookIcon, User, ChevronRight, Laptop, Copy, Check } from 'lucide-react';
import { logout, updatePassword } from '@/app/actions/auth';
import { saveWebhooks, createApiKey, revokeApiKey } from '@/app/actions/settings';
```

2. Add to `SECTIONS`:

```js
const SECTIONS = [
  { id: 'account', label: 'Account', icon: User },
  { id: 'password', label: 'Password', icon: KeyRound },
  { id: 'webhooks', label: 'Webhooks', icon: WebhookIcon },
  { id: 'api-keys', label: 'API Keys', icon: Laptop }
];
```

3. Add the section component, right after `WebhooksSection`:

```js
function formatRelativeDate(value) {
  if (!value) return 'Never used';
  const date = new Date(value);
  return `Last used ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

function ApiKeysSection({ initialKeys }) {
  const [keys, setKeys] = useState(initialKeys);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [newRawKey, setNewRawKey] = useState(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate() {
    setCreating(true);
    try {
      const result = await createApiKey(label);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setNewRawKey(result.rawKey);
      setKeys((prev) => [{ id: 'pending', label: result.label, createdAt: new Date().toISOString(), lastUsedAt: null }, ...prev]);
      setLabel('');
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id) {
    await revokeApiKey(id);
    setKeys((prev) => prev.filter((k) => k.id !== id));
    toast.success('API key revoked.');
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(newRawKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>API Keys</CardTitle>
        <CardDescription>
          Used by the desktop app and Chrome extension to upload recordings without you logging in
          separately on each device. Each key can start transcription jobs on your behalf, nothing more.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {newRawKey && (
          <div
            className="flex flex-col gap-2 rounded-[var(--cr-radius-md)] p-3"
            style={{ background: 'var(--cr-ink-raised)', border: '1px solid var(--cr-rule-strong)' }}
          >
            <p className="text-sm font-medium">Copy this key now — it won&apos;t be shown again.</p>
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
            placeholder="Label, e.g. \"MacBook Pro\""
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button onClick={handleCreate} disabled={creating} className="shrink-0">
            {creating && <Loader2 className="animate-spin" />}
            <Plus /> New key
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          {keys.length === 0 && <p className="text-sm text-muted-foreground">No API keys yet.</p>}
          {keys.map((key) => (
            <div key={key.id} className="flex items-center gap-3 rounded-[var(--cr-radius-md)] border border-[var(--cr-rule-strong)] px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{key.label}</div>
                <div className="text-xs text-muted-foreground">{formatRelativeDate(key.lastUsedAt)}</div>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => handleRevoke(key.id)}
                    >
                      <X />
                      <span className="sr-only">Revoke</span>
                    </Button>
                  }
                />
                <TooltipContent>Revoke this key</TooltipContent>
              </Tooltip>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
```

4. Update the `SettingsView` function signature and render branch:

```js
export default function SettingsView({ userEmail, avatarUrl, hasGoogle, hasPassword, initialWebhooks, initialApiKeys }) {
```

```js
            {active === 'api-keys' && <ApiKeysSection initialKeys={initialApiKeys} />}
```
(added right after the existing `{active === 'webhooks' && ...}` line)

- [ ] **Step 2: Manual verification**

Run `npm run dev`, open `/settings`, click "API Keys" in the nav. Create a key with a label, confirm the raw key is shown with a working copy button, confirm it appears in the list below with "Never used". Refresh the page — confirm the key persists in the list (proves `listApiKeys`/the page's server-side fetch works) and that the raw key is no longer shown anywhere (proves it really isn't stored in plaintext or re-displayed). Click revoke — confirm it disappears from the list and, after a refresh, stays gone.

- [ ] **Step 3: Now go back and finish Task 3 Step 2** (the `curl` verification), using a real key generated here.

- [ ] **Step 4: Commit**

```bash
git add app/settings/page.js app/settings/SettingsView.js
git commit -m "$(cat <<'EOF'
Add API Keys section to Settings UI

Lets the user generate and revoke long-lived keys for the desktop app
and Chrome extension, following the same section-nav pattern as the
existing Webhooks settings.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `/api/tokens/mark-failed` — the API-key equivalent of `markMeetingFailed()`

The design spec commits both the desktop app and the extension to calling "the equivalent of the existing `markMeetingFailed()` path" when their direct-to-backend upload fails after a token was already minted (bad network mid-upload, backend briefly down, etc.) — without this, a failed machine-client upload would sit at `'processing'` for the full 30-minute `sweepStaleJobs()` window instead of failing promptly, unlike the browser dashboard's existing behavior. This task closes that gap.

**Files:**
- Modify: `app/actions/meetings.js` (extract `markMeetingFailedCore`, keep `markMeetingFailed` as a thin session-auth wrapper around it — the same split Task 2 did for `createUploadToken`/`mintUploadToken`)
- Create: `app/api/tokens/mark-failed/route.js`

**Interfaces:**
- Produces: `export async function markMeetingFailedCore({ meetingId, userId, message })` from `app/actions/meetings.js`, returning `{ ok: boolean }`. `POST /api/tokens/mark-failed` — request: `Authorization: Bearer <rawKey>`, JSON body `{ meetingId: string, message?: string }`; response `{ ok: boolean }` or `401`/`400`.

- [ ] **Step 1: Extract the core**

In `app/actions/meetings.js`, replace the existing `markMeetingFailed` function with:

```js
// The auth-agnostic core, mirroring how mintUploadToken() in
// app/lib/uploadTokens.js splits from createUploadToken() - callers
// resolve `userId` through whichever auth mechanism they use
// (session cookie here, API key in the Route Handler below) and this
// does the actual status/notification work exactly once.
export async function markMeetingFailedCore({ meetingId, userId, message }) {
  const meeting = await findOwnedMeeting(meetingId, userId);
  if (!meeting || meeting.status !== 'processing') {
    return { ok: false };
  }

  meeting.status = 'failed';
  meeting.errorMessage = typeof message === 'string' && message ? message : 'Upload failed. Please try again.';
  await meeting.save();
  await sendNotifications(meeting);
  return { ok: true };
}

export async function markMeetingFailed(id, message) {
  const { userId } = await verifySession();
  return markMeetingFailedCore({ meetingId: id, userId, message });
}
```

- [ ] **Step 2: Write the Route Handler**

```js
import 'server-only';
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/app/lib/db';
import ApiKey from '@/app/lib/models/ApiKey';
import { markMeetingFailedCore } from '@/app/actions/meetings';

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// Companion to /api/tokens/upload - lets a machine client report its
// own upload failure promptly instead of leaving the row at
// 'processing' until sweepStaleJobs() eventually notices, 30 minutes
// later. See "Job status" in CLAUDE.md for why prompt, accurate status
// matters here.
export async function POST(request) {
  const authHeader = request.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return NextResponse.json({ error: 'Missing or invalid Authorization header.' }, { status: 401 });
  }

  await connectToDatabase();

  const keyHash = hashApiKey(match[1].trim());
  const apiKey = await ApiKey.findOne({ keyHash });
  if (!apiKey) {
    return NextResponse.json({ error: 'Invalid or revoked API key.' }, { status: 401 });
  }
  apiKey.lastUsedAt = new Date();
  await apiKey.save();

  const body = await request.json().catch(() => ({}));
  if (!body?.meetingId) {
    return NextResponse.json({ error: 'meetingId is required.' }, { status: 400 });
  }

  const result = await markMeetingFailedCore({ meetingId: body.meetingId, userId: apiKey.userId, message: body.message });
  return NextResponse.json(result);
}
```

- [ ] **Step 3: Verify with `curl`**

Using a real key from Settings, first mint a token (as in Task 3's verification) to get a real `meeting.id`, then:

```bash
curl -i -X POST http://localhost:3000/api/tokens/mark-failed \
  -H "Authorization: Bearer <paste the raw key here>" \
  -H "Content-Type: application/json" \
  -d '{"meetingId": "<paste the meeting id from the mint response>", "message": "curl test failure"}'
```

Expected: `200 {"ok":true}`. Refresh the dashboard, confirm that meeting's row now shows `'failed'` with "curl test failure" as the error message. Run the same `curl` command again — expected `200 {"ok":false}` (the meeting is no longer `'processing'`, so the second call correctly no-ops rather than re-triggering notifications).

- [ ] **Step 4: Commit**

```bash
git add app/actions/meetings.js app/api/tokens/mark-failed/route.js
git commit -m "$(cat <<'EOF'
Add /api/tokens/mark-failed for machine-client upload failures

Lets the desktop app and Chrome extension report a failed upload
promptly instead of leaving the Meeting row stuck at 'processing'
until the 30-minute stale-job sweep notices.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Done when

- A key generated in Settings, used via `curl -H "Authorization: Bearer <key>"` against `POST /api/tokens/upload`, returns a real `{ token, backendUrl, meeting }` that can be handed to the existing `${backendUrl}/api/transcribe` upload exactly as the browser dashboard already does — full loop verified without touching the Render backend at all.
- Revoking a key immediately makes further `curl` calls with it return `401`.
- The same key can report a failed upload via `POST /api/tokens/mark-failed`, and the affected meeting flips to `'failed'` with a real error message immediately, not after a 30-minute wait.
