# Desktop app + Chrome extension: local meeting capture

**Status:** Approved for planning
**Author:** Om Rajpal + Claude
**Date:** 2026-09-02

## Context and goals

The existing app (Next.js frontend on Vercel + Express backend on Render,
see root `CLAUDE.md`) only handles meetings the user has already recorded
and manually uploads. The goal of this project is to add automatic,
in-the-moment capture for live Zoom/Meet/Teams calls, for a single user
(Om), at $0 recurring infrastructure cost.

Two clients are in scope:

1. A **cross-platform desktop app** (macOS + Windows) that captures
   system audio + microphone locally while the user is in any call
   their computer plays audio for (browser tab or native app), and
   also serves as a full native shell for the existing web app so the
   user never has to separately open a browser.
2. A **Chrome extension** that captures a Meet/Teams browser tab's
   audio + the user's mic while they're on a call inside Chrome, with
   a polished side-panel UI.

Both clients feed into the **existing, unmodified** ffmpeg → Deepgram
→ MongoDB pipeline described in `CLAUDE.md`'s "Upload token flow" and
"Job status" sections. Neither client does its own transcription.

### Why not a meeting bot

Earlier exploration in this design's history considered a server-side
bot that joins meetings as a fake participant (the Fathom/Fireflies/
Otter/Attendee pattern). Rejected for this project because:

- It requires a persistent or per-meeting compute job (headless Chrome
  + virtual audio + ffmpeg) that Render's free tier (512MB RAM/
  0.1vCPU, 15-min spin-down, no persistent disk) cannot run reliably,
  and every genuinely free alternative (GitHub Actions, Oracle Cloud
  Free Tier) adds real operational complexity (public-repo requirement
  and CI-not-service ToS ambiguity for GitHub Actions; a self-managed
  always-on VM for Oracle) for a single user who is, by definition,
  always present at the meeting anyway.
- Native platform recording (Zoom cloud recording, Google Meet's
  recording API, Teams recording via Graph) all require paid tiers
  (Zoom Pro ≈$14–17/mo; Meet requires Workspace Business Standard+;
  Teams requires a paid M365 license) — none work on a free personal
  account.
- Local capture (this design) needs no server-side bot, no meeting-join
  automation, no headless browser, and nothing shows up in the
  meeting's participant list, matching how Wispr Flow Notetaker works
  (verified via research: system audio + mic capture via macOS
  `ScreenCaptureKit`, no bot).

### Non-goals (explicitly deferred, not part of this design)

- **Calendar-based auto-detection** ("is this your 3pm meeting with
  X, Y, Z?", attendee-name suggestions for the speaker dropdown) —
  phase 2, layered on top of this once capture is solid.
- **Live in-call transcript** (speaker-labeled text updating during
  the meeting) — phase 3. Deepgram's streaming API supports this
  (confirmed in research) but needs a new backend WebSocket relay,
  which is real additional work, not a toggle.
- **Video capture** — audio only, per explicit requirement.
- **Code signing / notarization** — skipped. Confirmed via research
  that unsigned-app friction on both macOS (System Settings →
  Privacy & Security → "Open Anyway", one-time per app) and Windows
  (SmartScreen "More info → Run anyway", one-time per file) is a
  one-time click-through per machine, not a functional blocker, for a
  single developer installing on their own machines only. Saves
  ~$100–400+/year in certificate costs.
- **Multi-tenant / multi-user support** for these two clients. The
  existing web app remains multi-user-capable; the desktop app and
  extension are built and reasoned about as single-user tools.

## Architecture overview

```
┌─────────────────────────┐        ┌──────────────────────────┐
│   Desktop app (Tauri)   │        │   Chrome extension (WXT) │
│                          │        │                           │
│  ┌────────────────────┐  │        │  ┌─────────────────────┐  │
│  │ Native Rust layer   │  │        │  │ Offscreen document  │  │
│  │ - ScreenCaptureKit  │  │        │  │ - tabCapture         │  │
│  │   (macOS)           │  │        │  │ - getUserMedia (mic) │  │
│  │ - WASAPI loopback   │  │        │  │ - MediaRecorder      │  │
│  │   (Windows)         │  │        │  └──────────┬──────────┘  │
│  │ - mic capture       │  │        │             │              │
│  │ - tray icon/status  │  │        │  ┌──────────▼──────────┐  │
│  └──────────┬──────────┘  │        │  │ Side panel (React,   │  │
│             │              │        │  │ shadcn/Base UI,      │  │
│  ┌──────────▼──────────┐  │        │  │ Tailwind v4 — reused │  │
│  │ Embedded webview     │  │        │  │ from web app)        │  │
│  │ = the existing        │  │        │  └──────────┬──────────┘  │
│  │ Next.js web app       │  │        │             │              │
│  │ (dashboard, history,  │  │        └─────────────┼──────────────┘
│  │ search, settings —    │  │                      │
│  │ unmodified)           │  │                      │
│  └──────────┬────────────┘  │                      │
└─────────────┼────────────────┘                      │
              │  both clients:                          │
              │  1. POST /api/tokens/upload (Bearer <API key>) — NEW
              │  2. POST {backendUrl}/api/transcribe (multipart, unchanged)
              ▼                                          ▼
┌───────────────────────────────────────────────────────────────┐
│         Existing Next.js Server Actions / Route Handlers        │
│         + existing Express/Render backend + MongoDB              │
│         (ffmpeg → Deepgram → Meeting doc — entirely unchanged)   │
└───────────────────────────────────────────────────────────────┘
```

## Stack decisions

| Decision | Choice | Why |
|---|---|---|
| Desktop framework | **Tauri**, not Electron | Direct Rust access to `ScreenCaptureKit`/WASAPI vs. Electron needing a bolted-on native addon; ~3–10MB bundle and ~42MB idle RAM vs. Electron's ~120–200MB/~168MB — matters for an always-running tray app. |
| Desktop UI for existing features | **Embed the existing Next.js web app in Tauri's native webview** (WebKit on macOS, WebView2 on Windows), not a native rebuild | Full feature parity (dashboard, history, search, tags, speaker rename, settings) for near-zero extra work; the app is already responsive/dark-themed. Session cookies persist natively across launches. |
| Extension framework | **WXT** (Vite-based) over Plasmo (aging bundler) or CRXJS (too bare) | Actively maintained, cross-browser, built-in dev-reload/storage/messaging helpers. |
| Extension UI | **Chrome Side Panel**, not classic popup | Persists across tab navigation (a popup dies on any outside click); roomy enough for a live meeting list. |
| Extension design system | **Reuse shadcn/ui (Base UI) + Tailwind v4 components as-is** | shadcn copies components into your own source rather than an opaque package, sidestepping MV3 CSP restrictions; popup/side-panel are normal HTML documents so Tailwind works unmodified. |
| Code signing | **None** | Confirmed one-time-per-machine click-through friction only, no functional blocker, on both OSes for single-developer/single-machine installs. |
| Repo layout | New top-level `desktop/` and `extension/` directories alongside the existing `/` (frontend) and `backend/`, in this same repo | Matches the existing monorepo-ish convention; one repo to manage for a solo project. |

## Authentication for machine clients

Neither client can call `createUploadToken()` (a Next.js Server Action)
directly — Server Actions are browser-session-bound POSTs with an
encrypted action id, not a stable API for a native Rust process or an
extension background script.

**New, additive-only mechanism:**

- **`ApiKey` model** (`app/lib/models/ApiKey.js`): `{ userId, keyHash,
  label, createdAt, lastUsedAt }`. The raw key is shown once at
  creation (like a GitHub PAT) and never stored in plaintext.
- **Settings UI**: a "Personal API keys" section (extends the existing
  webhook-settings dialog pattern in `app/actions/settings.js`) to
  generate and revoke keys. One key is enough for this single-user
  app, but the model supports several (e.g. one per device) since
  revoking one shouldn't log out every client.
- **New Route Handler**: `app/api/tokens/upload/route.js`. Justified
  under `CLAUDE.md`'s existing Route Handler rule ("a GET/request
  initiated by something outside this app") — here, an authenticated
  `Authorization: Bearer <key>` POST from a native client or
  extension, not a browser-driven Server Action. It validates the key
  against `ApiKey`, updates `lastUsedAt`, then calls the **same
  internal helper** `createUploadToken()` already uses to mint an
  `UploadToken` and create the `Meeting` row, and returns the same
  shape the dashboard's Server Action already returns (token, backend
  URL, meeting).
- From there, **both clients upload straight to
  `${backendUrl}/api/transcribe`, entirely unchanged** — same
  single-use token, same ffmpeg + Deepgram pipeline, same
  `status: 'processing' → 'complete'/'failed'` lifecycle, same email/
  webhook notifications. The Render backend needs zero changes.

This keeps the whole feature additive: one new model, one new route,
one new settings section — nothing existing is modified.

## Desktop app design

- **Native Rust capture module**: `ScreenCaptureKit` (macOS 13+) for
  system audio, WASAPI loopback for Windows, plus mic capture via each
  platform's standard input API. Encoded locally (Opus or WAV) as the
  meeting progresses, not held entirely in memory.
- **Tray icon** shows idle/recording state at a glance.
- **A small native window** (not the webview) owns start/stop controls
  and any future "is this your meeting?" prompt — kept native so it's
  never blocked by whatever the embedded webview happens to be
  rendering.
- **The embedded webview** points at the deployed web app
  (`APP_URL`), giving the full existing dashboard/history/search/
  settings UI with no duplicated code. Logging in inside the webview
  persists a real session cookie for that surface, entirely separate
  from the API-key auth the native capture layer uses to upload.
- **On stop**: finalizes the local audio file, requests an upload
  token via the new Route Handler (using the stored API key, read from
  the OS keychain via Tauri's keyring plugin, never plaintext on
  disk), uploads to the backend, and the embedded webview's existing
  dashboard polling picks up the new `'processing'` row automatically
  — no new UI needed for that part, it already works today.

## Chrome extension design

- **WXT** project under `extension/`, MV3.
- **Content script** on `meet.google.com` and `teams.microsoft.com`
  call pages shows a small "Record this meeting" affordance.
- **Offscreen document** (required by MV3 for `tabCapture` — service
  workers can't touch `MediaStream`/DOM directly) does the actual
  `chrome.tabCapture` (remote participants' mixed tab audio) +
  `getUserMedia` (mic) capture via `MediaRecorder`. Starting capture
  requires a user gesture (a Chrome API constraint, not a workaround-
  able limitation) — the extension surfaces this as the visible
  "Record" click, which is also an honest, visible signal that
  recording is active.
- **Side panel** (React, shadcn/Base UI, Tailwind v4 — reused
  components) shows recording status, recent meetings, and the same
  API-key-based settings as the desktop app.
- **Same upload path**: on stop, request a token from
  `/api/tokens/upload` with the stored key, upload to
  `{backendUrl}/api/transcribe}`.

## Error handling and edge cases

Following the existing app's own conventions (`CLAUDE.md`'s Job Status
and Security sections) rather than inventing new patterns:

- **Upload failure** (network drop, expired/revoked API key, backend
  unreachable): both clients call the equivalent of the existing
  `markMeetingFailed()` path. Because the `Meeting` row is created at
  token-mint time (before the file transfer, mirroring the existing
  upload-token flow), a crash mid-upload leaves a `'failed'` row with
  a client-safe `errorMessage`, never a silently lost recording.
- **Recording interrupted** (app killed, laptop sleeps, OS permission
  revoked mid-call, extension's tab closed/navigated away — a real
  `tabCapture` limitation): the partial local audio file is kept on
  disk/in extension storage and offered for retry-upload on next
  launch/reopen, not silently discarded. The UI states plainly that
  the recording stopped early rather than uploading a truncated file
  unlabeled.
- **OS permission denial** (Screen Recording/System Audio not
  granted): a clear inline prompt pointing at the exact System
  Settings pane, not a silent failure or generic error.
- **Invalid/expired/revoked API key**: generic client-safe error,
  consistent with the "never leak internals" rule already in
  `CLAUDE.md`'s Security section — the UI prompts to regenerate a key
  in Settings.
- **Backend down / Deepgram down**: identical to today's behavior —
  the existing `sweepStaleJobs()` eventually marks a hung
  `'processing'` row `'failed'` even if a client-side notification is
  missed.

## Security considerations

- API keys are hashed at rest (same principle as password hashing
  elsewhere in this app), shown once, revocable individually, and
  stored client-side only in OS-native secure storage (Tauri
  keyring / `chrome.storage` is used only because MV3 extensions have
  no OS keychain access — acceptable given the key only grants
  "mint an upload token for this user," the same low-blast-radius
  scope the existing single-use `UploadToken` already has).
- No new server-side attack surface beyond the one new Route Handler,
  which does exactly what the existing authenticated Server Action
  does, gated by a different credential type.
- Consistent with `CLAUDE.md`'s existing rule against turning
  short-lived tokens into long-lived reusable credentials without
  reason: the **API key** is intentionally long-lived (a device has to
  keep working without the user re-authenticating constantly), but it
  is scoped to nothing more than "mint one single-use upload token,"
  identical in power to what the browser dashboard can already do
  while logged in — it is not a general-purpose account credential.

## Testing strategy

Per `CLAUDE.md`'s existing testing conventions (real verification, not
just "it compiles"):

- Desktop app: manual verification on both a real Mac and a real
  Windows machine — recording a real short call (or a local audio
  source, since ScreenCaptureKit/WASAPI capture *anything* playing,
  not only meeting apps specifically), confirming the uploaded meeting
  appears and transcribes correctly, and confirming the embedded
  webview's dashboard/search/settings behave identically to the
  regular browser.
- Extension: a real Playwright pass is not applicable to a MV3
  extension's native capture APIs (no browser can automate
  `tabCapture` meaningfully), so verification is manual: load the
  unpacked extension, join a real (or test) Meet/Teams call, record,
  confirm upload and transcription.
- Both: explicitly test the failure paths described above (kill the
  app mid-recording, revoke the API key, disconnect network mid-
  upload) rather than only the happy path.

## Build order

1. `ApiKey` model + `/api/tokens/upload` Route Handler + Settings UI
   section (small, testable against the existing web app alone before
   either client exists).
2. Desktop app: native capture module (start with macOS, then
   Windows) + webview embedding + tray + upload flow.
3. Chrome extension: offscreen capture + side panel + upload flow.
4. Phase 2 (separate future design): calendar-based meeting detection.
5. Phase 3 (separate future design): live in-call transcript via
   Deepgram streaming + a new backend WebSocket relay.
