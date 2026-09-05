# Desktop Native Recordings View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the desktop app's embedded-website "Open Dashboard" window with a native "Recent Recordings" status list, fed by one new narrow read-only API-key endpoint, so the app can answer "did it work?" on its own.

**Architecture:** A new `GET /api/tokens/meetings` Route Handler (authenticated like the existing `/api/tokens/*` routes) returns bounded metadata (id, title, status, createdAt, errorMessage - never transcript text) for the API key's own user. The desktop app polls it from a new native section in its existing Settings window, and clicking a row opens that meeting's page in the system browser instead of an embedded webview. The embedded "dashboard" window and its tray item are removed.

**Tech Stack:** Next.js Route Handler (JS, Mongoose) for the backend piece; Rust (Tauri v2, `reqwest`, `serde`) + React/TypeScript for the desktop piece.

**Spec:** `docs/superpowers/specs/2026-09-05-desktop-native-recordings-view-design.md`

## Global Constraints

- Never expose transcript text through the new endpoint - metadata only (`id`, `title`, `status`, `createdAt`, `errorMessage`).
- Ownership is always `userId`-scoped from the resolved `ApiKey` document, never client input (existing project-wide rule, `CLAUDE.md` "Security (non-negotiable)").
- No automated test suite exists anywhere in this codebase (frontend, backend, desktop, or extension) - confirmed by searching the repo before writing this plan. Every task below is verified manually (`curl`, `cargo check`, `tsc`, or an actual click-through), matching this project's existing convention (see `lib.rs`'s own "NOTE: no automated tests here on purpose" comment and `CLAUDE.md`'s testing section). Do not introduce a test framework as part of this work.
- Desktop Tauri commands that return data to the frontend keep **snake_case** field names all the way through (matching the existing `SettingsResponse { has_api_key: bool }` / `s.has_api_key` convention) - do not add `#[serde(rename_all = "camelCase")]` to any struct serialized *out* to the frontend. Structs deserializing the backend's camelCase JSON *in* still need `rename_all = "camelCase")]`, matching the existing `TokenResult` struct.
- One refinement from the spec: the spec sketched `SettingsResponse.revoked: bool`. This plan instead uses `label: Option<String>` + `error: Option<String>` (present exactly one of them once `has_api_key` is true) - this carries the actual validation failure message (which may be "revoked," or may be "app unreachable") instead of collapsing every failure into one ambiguous boolean. Behavior described in the spec (show a clear message when the saved key no longer validates) is preserved; only the field shape is more precise.

---

### Task 1: Backend - minimal API-key-safe meeting summary + list query

**Files:**
- Modify: `app/lib/meetings.js` (add two new exported functions; do not touch `toSummary`/`toDetail`/`listMeetings`)

**Interfaces:**
- Produces: `toApiKeySummary(meeting)` returning `{ id, title, status, createdAt, errorMessage }`; `listMeetingsForApiKey(userId, limit = 20)` returning `Promise<Array<ReturnType<typeof toApiKeySummary>>>`. Task 2 imports both.

- [ ] **Step 1: Read the existing `toSummary` and `listMeetings` for the exact conventions to match**

Run: `grep -n "export function toSummary\|export async function listMeetings" -A 20 "app/lib/meetings.js"`

Confirm `toSummary` computes `title: meeting.title || meeting.originalName || 'Untitled recording'` and `createdAt: meeting.createdAt.toISOString()`, and `listMeetings` uses `Meeting.find(filter).select('-utterances').sort({ createdAt: -1 }).lean()`. The new functions below reuse these exact patterns.

- [ ] **Step 2: Add `toApiKeySummary` and `listMeetingsForApiKey`**

Add this immediately after the existing `toSummary` function in `app/lib/meetings.js`:

```javascript
// Deliberately separate from toSummary(), which includes a `preview` field
// containing actual transcript text - exactly what an API-key client must
// never receive (see CLAUDE.md's "API key auth for machine clients": a key
// "can't read a transcript"). This mapper is metadata-only.
export function toApiKeySummary(meeting) {
  return {
    id: String(meeting._id),
    title: meeting.title || meeting.originalName || 'Untitled recording',
    status: meeting.status || 'complete',
    createdAt: meeting.createdAt.toISOString(),
    errorMessage: meeting.errorMessage || null
  };
}

// Feeds the desktop app's native "Recent Recordings" view (GET
// /api/tokens/meetings) - the one read capability an API key has, and
// deliberately narrow: no search, no tags, capped at `limit`, same
// ownership/.lean()/.select() shape as listMeetings() above.
export async function listMeetingsForApiKey(userId, limit = 20) {
  await connectToDatabase();
  const meetings = await Meeting.find({ userId })
    .select('-utterances')
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
  return meetings.map(toApiKeySummary);
}
```

- [ ] **Step 3: Verify it loads without syntax errors**

Run: `cd "/Volumes/Crucial X9/meeting transcriber" && node -e "require('./app/lib/meetings.js')" 2>&1 | tail -20`

Expected: no `SyntaxError`. (This file uses ESM `export`, so a plain `node -e require` will fail with `Cannot use import statement` - if so, instead run `npx next lint --file app/lib/meetings.js 2>&1 | tail -30` or simply proceed to Task 2 and let the Next.js build in that task's verification step catch any syntax error. Either check is acceptable; don't block on this step if `node -e` isn't a valid way to load an ESM file in this project.)

- [ ] **Step 4: Commit**

```bash
cd "/Volumes/Crucial X9/meeting transcriber"
git add app/lib/meetings.js
git commit -m "Add API-key-safe meeting summary for the desktop app's recordings view"
```

---

### Task 2: Backend - `GET /api/tokens/meetings` Route Handler

**Files:**
- Create: `app/api/tokens/meetings/route.js`

**Interfaces:**
- Consumes: `authenticateApiKey(request)` from `app/lib/apiKeys.js` (returns the `ApiKey` document or `null` - existing function, see `app/api/tokens/validate/route.js` for the exact usage pattern); `listMeetingsForApiKey(userId, limit)` from Task 1.
- Produces: `GET /api/tokens/meetings` → `200 { meetings: [...] }` or `401 { error: "..." }`. Task 4 (Rust) consumes this shape.

- [ ] **Step 1: Read the existing validate route as the pattern to match exactly**

Run: `cat "app/api/tokens/validate/route.js"`

- [ ] **Step 2: Write the route handler**

Create `app/api/tokens/meetings/route.js`:

```javascript
import 'server-only';
import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/app/lib/db';
import { authenticateApiKey } from '@/app/lib/apiKeys';
import { listMeetingsForApiKey } from '@/app/lib/meetings';

// Lets the desktop app show its own native "Recent Recordings" status
// list instead of embedding the website - see
// docs/superpowers/specs/2026-09-05-desktop-native-recordings-view-design.md.
// Deliberately read-only and metadata-only (see toApiKeySummary in
// app/lib/meetings.js) - this is the one read capability an API key has.
export async function GET(request) {
  await connectToDatabase();

  const apiKey = await authenticateApiKey(request);
  if (!apiKey) {
    return NextResponse.json({ error: 'Invalid or revoked API key.' }, { status: 401 });
  }

  const meetings = await listMeetingsForApiKey(apiKey.userId);
  return NextResponse.json({ meetings });
}
```

- [ ] **Step 3: Verify with a local dev server**

Run:
```bash
cd "/Volumes/Crucial X9/meeting transcriber" && npm run dev &
sleep 5
curl -s -w "\nHTTP %{http_code}\n" http://localhost:3000/api/tokens/meetings
```

Expected: `HTTP 401` with `{"error":"Invalid or revoked API key."}` (no key sent). Then stop the dev server: `kill %1` (or find/kill the `next dev` process another way).

- [ ] **Step 4: Verify the success path with a real key**

Get a real API key from `/settings` on the running dev server (log in, Settings → API Keys → generate one), then:

```bash
curl -s -w "\nHTTP %{http_code}\n" -H "Authorization: Bearer <the-key>" http://localhost:3000/api/tokens/meetings
```

Expected: `HTTP 200` and `{"meetings":[...]}` - an array (empty is fine if that account has no meetings yet), with each item (if any) containing exactly `id`, `title`, `status`, `createdAt`, `errorMessage` and **no** `transcript`/`preview`/`utterances` field.

- [ ] **Step 5: Commit**

```bash
cd "/Volumes/Crucial X9/meeting transcriber"
git add app/api/tokens/meetings/route.js
git commit -m "Add GET /api/tokens/meetings: read-only meeting status for API-key clients"
```

---

### Task 3: Desktop Rust - `validate_api_key` returns the label; `get_settings` becomes identity-aware

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: existing `APP_URL`, `HTTP_CONNECT_TIMEOUT`, `JSON_REQUEST_TIMEOUT`, `SERVICE`, `KEY_USER` constants (all already defined above `validate_api_key` in this file).
- Produces: `validate_api_key(api_key: &str) -> Result<String, String>` (label on success). `SettingsResponse { has_api_key: bool, label: Option<String>, error: Option<String> }`. `get_settings` is now `async`. Task 6 (frontend) consumes this exact `SettingsResponse` shape.

- [ ] **Step 1: Read the current `validate_api_key`, `SettingsResponse`, `save_settings`, `get_settings`**

Run: `grep -n "struct SettingsResponse" -A 3 desktop/src-tauri/src/lib.rs` and `grep -n "async fn validate_api_key" -A 30 desktop/src-tauri/src/lib.rs` and `grep -n "fn save_settings\|fn get_settings" -A 15 desktop/src-tauri/src/lib.rs` to confirm the exact current text before editing (it must match what's quoted in Step 2/3 below, or adjust the match target).

- [ ] **Step 2: Replace `SettingsResponse` and `validate_api_key`**

Replace:
```rust
#[derive(Serialize)]
struct SettingsResponse {
    has_api_key: bool,
}
```
with:
```rust
#[derive(Serialize)]
struct SettingsResponse {
    has_api_key: bool,
    // Exactly one of these is Some once has_api_key is true: the key's
    // label on a successful live validate, or the validate failure
    // message (revoked, network error, etc.) otherwise - see the plan's
    // Global Constraints for why this replaced a plain `revoked: bool`.
    label: Option<String>,
    error: Option<String>,
}
```

Replace the whole existing `validate_api_key` function body with a version that returns the label on success instead of `()`:

```rust
async fn validate_api_key(api_key: &str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let response = client
        .post(format!("{APP_URL}/api/tokens/validate"))
        .bearer_auth(api_key)
        .timeout(JSON_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Could not reach {APP_URL} to check the API key: {e}"))?;

    let status = response.status();

    #[derive(Deserialize)]
    struct ValidateResponse {
        valid: bool,
        label: Option<String>,
        error: Option<String>,
    }
    let body: ValidateResponse = response
        .json()
        .await
        .map_err(|e| format!("Could not parse the app's response: {e}"))?;

    if status.is_success() && body.valid {
        return Ok(body.label.unwrap_or_default());
    }
    Err(body.error.unwrap_or_else(|| "That API key was rejected by the app.".to_string()))
}
```

This keeps `save_settings`'s existing `validate_api_key(&api_key).await?;` call working unchanged - discarding the `Ok(String)` value at that call site is fine as-is, no edit needed there.

- [ ] **Step 3: Replace `get_settings`**

Replace:
```rust
#[tauri::command]
fn get_settings() -> Result<SettingsResponse, String> {
    // Only ever report presence, never the raw key - the frontend has no
    // legitimate use for it once it's saved.
    let has_api_key = Entry::new(SERVICE, KEY_USER)
        .and_then(|e| e.get_password())
        .is_ok();

    Ok(SettingsResponse { has_api_key })
}
```
with:
```rust
#[tauri::command]
async fn get_settings() -> Result<SettingsResponse, String> {
    // Only ever report presence, never the raw key - the frontend has no
    // legitimate use for it once it's saved.
    let stored_key = Entry::new(SERVICE, KEY_USER).and_then(|e| e.get_password()).ok();
    let Some(api_key) = stored_key else {
        return Ok(SettingsResponse {
            has_api_key: false,
            label: None,
            error: None,
        });
    };

    // Re-validates live on every Settings open (not just at save time) so
    // a key revoked from the website since the last launch is caught here
    // instead of silently failing much later during an actual upload.
    match validate_api_key(&api_key).await {
        Ok(label) => Ok(SettingsResponse {
            has_api_key: true,
            label: Some(label),
            error: None,
        }),
        Err(message) => Ok(SettingsResponse {
            has_api_key: true,
            label: None,
            error: Some(message),
        }),
    }
}
```

- [ ] **Step 4: Compile-check**

Run: `cd "desktop/src-tauri" && CARGO_TARGET_DIR=/tmp/mt-cargo-target cargo check 2>&1 | tail -60`

(Using a `CARGO_TARGET_DIR` off the project's exFAT volume avoids a known AppleDouble-sidecar-file panic on this specific machine - see the earlier session's investigation. Reuse `/tmp/mt-cargo-target` for every subsequent `cargo check`/`cargo build` in this plan so incremental compilation isn't wasted.)

Expected: `Finished` with no errors (the pre-existing `field 'stream' is never read` warning in `capture/mic.rs` is unrelated and fine to see).

- [ ] **Step 5: Commit**

```bash
cd "/Volumes/Crucial X9/meeting transcriber"
git add desktop/src-tauri/src/lib.rs
git commit -m "Desktop: get_settings live-validates the saved API key and returns its label"
```

---

### Task 4: Desktop Rust - `fetch_recent_meetings` command

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `APP_URL`, `HTTP_CONNECT_TIMEOUT`, `JSON_REQUEST_TIMEOUT`, `SERVICE`, `KEY_USER` (existing constants); the `/api/tokens/meetings` response shape from Task 2 (`{ meetings: [{id,title,status,createdAt,errorMessage}] }`).
- Produces: `#[tauri::command] async fn fetch_recent_meetings() -> Result<Vec<MeetingSummary>, String>` where `MeetingSummary` has snake_case fields `id, title, status, created_at, error_message, meeting_url` (all `String`/`Option<String>`, matching the Global Constraints rule on outgoing struct casing). Task 6 (frontend) consumes this exact shape and these exact field names.

- [ ] **Step 1: Add the command**

Add this new code directly after `validate_api_key` (from Task 3) in `desktop/src-tauri/src/lib.rs`:

```rust
/// Raw shape of `GET /api/tokens/meetings` - see
/// `app/api/tokens/meetings/route.js`. `rename_all = "camelCase"` matters
/// here (matches `TokenResult`'s existing reasoning above): the JSON has
/// `createdAt`/`errorMessage`, not `created_at`/`error_message`.
#[derive(Deserialize)]
struct MeetingsApiResponse {
    meetings: Vec<ApiMeetingItem>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiMeetingItem {
    id: String,
    title: String,
    status: String,
    created_at: String,
    error_message: Option<String>,
}

/// Sent to the frontend - snake_case field names, matching
/// `SettingsResponse`'s existing convention of not renaming outgoing
/// structs to camelCase (the frontend reads `has_api_key` as-is today).
#[derive(Serialize)]
struct MeetingSummary {
    id: String,
    title: String,
    status: String,
    created_at: String,
    error_message: Option<String>,
    // Built here, not on the frontend, so the frontend never needs to
    // know APP_URL - same reasoning as APP_URL being a Rust-only constant
    // everywhere else in this file.
    meeting_url: String,
}

#[tauri::command]
async fn fetch_recent_meetings() -> Result<Vec<MeetingSummary>, String> {
    let api_key = Entry::new(SERVICE, KEY_USER)
        .and_then(|e| e.get_password())
        .map_err(|_| "No API key configured.".to_string())?;

    let client = reqwest::Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new());

    let response = client
        .get(format!("{APP_URL}/api/tokens/meetings"))
        .bearer_auth(&api_key)
        .timeout(JSON_REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("Could not reach {APP_URL}: {e}"))?;

    if !response.status().is_success() {
        return Err(format!("The app rejected the request ({}).", response.status()));
    }

    let body: MeetingsApiResponse = response
        .json()
        .await
        .map_err(|e| format!("Could not parse the app's response: {e}"))?;

    Ok(body
        .meetings
        .into_iter()
        .map(|m| MeetingSummary {
            meeting_url: format!("{APP_URL}/meeting/{}", m.id),
            id: m.id,
            title: m.title,
            status: m.status,
            created_at: m.created_at,
            error_message: m.error_message,
        })
        .collect())
}
```

- [ ] **Step 2: Register the command with Tauri**

Find:
```rust
        .invoke_handler(tauri::generate_handler![
            greet,
            save_settings,
            get_settings
        ])
```
Replace with:
```rust
        .invoke_handler(tauri::generate_handler![
            greet,
            save_settings,
            get_settings,
            fetch_recent_meetings
        ])
```

- [ ] **Step 3: Compile-check**

Run: `cd "desktop/src-tauri" && CARGO_TARGET_DIR=/tmp/mt-cargo-target cargo check 2>&1 | tail -60`

Expected: `Finished` with no new errors/warnings beyond the pre-existing `mic.rs` one.

- [ ] **Step 4: Commit**

```bash
cd "/Volumes/Crucial X9/meeting transcriber"
git add desktop/src-tauri/src/lib.rs
git commit -m "Desktop: add fetch_recent_meetings command"
```

---

### Task 5: Desktop Rust - remove the embedded dashboard window, add native navigation

**Files:**
- Modify: `desktop/src-tauri/src/lib.rs`
- Modify: `desktop/src-tauri/tauri.conf.json`

**Interfaces:**
- Produces: tray emits a Tauri event named `"navigate"` with string payload `"settings"` or `"recordings"`. Task 6 (frontend) listens for this exact event name and these exact payload values.

- [ ] **Step 1: Add the `Emitter` trait import**

Find the `use tauri::{AppHandle, Manager, State};` line near the top of `desktop/src-tauri/src/lib.rs` and change it to:
```rust
use tauri::{AppHandle, Emitter, Manager, State};
```

- [ ] **Step 2: Rename the tray menu item and remove the dashboard window code**

Find:
```rust
            let open_dashboard_item = MenuItem::with_id(
                app,
                "open_dashboard",
                "Open Dashboard",
                true,
                None::<&str>,
            )?;
```
Replace with:
```rust
            let show_recordings_item = MenuItem::with_id(
                app,
                "show_recordings",
                "Recent Recordings",
                true,
                None::<&str>,
            )?;
```

Find:
```rust
            let menu = Menu::with_items(
                app,
                &[
                    &toggle_item,
                    &open_dashboard_item,
                    &settings_item,
                    &quit_item,
                ],
            )?;
```
Replace with:
```rust
            let menu = Menu::with_items(
                app,
                &[
                    &toggle_item,
                    &show_recordings_item,
                    &settings_item,
                    &quit_item,
                ],
            )?;
```

Find this entire match arm (it should be the only `"open_dashboard" =>` arm in the file):
```rust
                    "open_dashboard" => {
                        // Reuse an already-open dashboard window rather than
                        // creating a second one - `WebviewWindowBuilder::build`
                        // errors on a duplicate label, and a user clicking the
                        // tray item twice almost certainly means "bring it to
                        // front", not "open it again". No `RecordingSlot`-style
                        // state machine is needed here (unlike
                        // "toggle_recording" above): opening a window is a
                        // single synchronous, idempotent call with no
                        // in-between state to race against.
                        if let Some(window) = app.get_webview_window("dashboard") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        } else {
                            // APP_URL is a compile-time constant, not a
                            // user-entered Settings value, so a parse
                            // failure here would be a genuine bug in this
                            // app rather than something the user could
                            // "fix in Settings" - kept as a real Result
                            // match anyway (not `.expect()`), matching this
                            // codebase's no-panics-on-a-failure-path rule,
                            // but the error text says so plainly rather
                            // than pointing at a Settings field that no
                            // longer exists.
                            match APP_URL.parse() {
                                Ok(url) => {
                                    if let Err(e) = tauri::WebviewWindowBuilder::new(
                                        app,
                                        "dashboard",
                                        tauri::WebviewUrl::External(url),
                                    )
                                    .title("Meeting Transcriber")
                                    .inner_size(1200.0, 800.0)
                                    .build()
                                    {
                                        eprintln!("failed to open dashboard window: {e}");
                                    }
                                }
                                Err(e) => {
                                    eprintln!("cannot open dashboard: invalid APP_URL constant {APP_URL:?}: {e}");
                                    show_error_dialog(app, "Internal error: the app's URL is misconfigured.");
                                }
                            }
                        }
                    }
```
and replace the whole arm with:
```rust
                    "show_recordings" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = app.emit("navigate", "recordings");
                        }
                    }
```

- [ ] **Step 3: Make "Settings" navigate the frontend to the settings section too**

Find:
```rust
                    "open_settings" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
```
Replace with:
```rust
                    "open_settings" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                            let _ = app.emit("navigate", "settings");
                        }
                    }
```

- [ ] **Step 4: Update the window title and size in `tauri.conf.json`**

In `desktop/src-tauri/tauri.conf.json`, find:
```json
      {
        "label": "main",
        "title": "Meeting Transcriber Settings",
        "width": 420,
        "height": 480,
        "visible": false
      }
```
Replace with:
```json
      {
        "label": "main",
        "title": "Meeting Transcriber",
        "width": 420,
        "height": 560,
        "visible": false
      }
```

(Title is now generic since the window hosts two sections, not just Settings. Height grows slightly to fit the recordings list without immediate scrolling.)

- [ ] **Step 5: Compile-check**

Run: `cd "desktop/src-tauri" && CARGO_TARGET_DIR=/tmp/mt-cargo-target cargo check 2>&1 | tail -60`

Expected: `Finished` with no errors. If you see `error[E0599]: no method named 'emit' found`, confirm Step 1's `use tauri::{AppHandle, Emitter, Manager, State};` was actually applied.

- [ ] **Step 6: Commit**

```bash
cd "/Volumes/Crucial X9/meeting transcriber"
git add desktop/src-tauri/src/lib.rs desktop/src-tauri/tauri.conf.json
git commit -m "Desktop: remove embedded dashboard window, add native navigate event"
```

---

### Task 6: Desktop frontend - Settings/Recordings sections in `App.tsx`

**Files:**
- Modify: `desktop/src/App.tsx` (full rewrite)

**Interfaces:**
- Consumes: `invoke<SettingsResponse>("get_settings")`, `invoke("save_settings", { apiKey })`, `invoke<MeetingSummary[]>("fetch_recent_meetings")` (all from Tasks 3-4); `listen<Section>("navigate", ...)` events with payload `"settings" | "recordings"` (from Task 5); `openUrl` from `@tauri-apps/plugin-opener` (already an installed dependency, unused elsewhere in this file today).

- [ ] **Step 1: Confirm the opener plugin's export name**

Run: `grep -n "export declare function openUrl" "desktop/node_modules/@tauri-apps/plugin-opener/dist-js/index.d.ts"`

Expected: a match - confirms the function is named `openUrl`, not `open`.

- [ ] **Step 2: Replace the full contents of `desktop/src/App.tsx`**

```tsx
// Settings UI: API key (OS keychain, never plaintext on disk, never
// re-displayed once saved) plus a native "Recent Recordings" status list
// fed by GET /api/tokens/meetings - see
// docs/superpowers/specs/2026-09-05-desktop-native-recordings-view-design.md
// for why this replaced the old embedded-website "Open Dashboard" window:
// the desktop app now answers "did it work?" on its own, and only sends
// you to the browser to actually read a transcript.
import { useEffect, useState, type ChangeEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import "./App.css";

interface SettingsResponse {
  has_api_key: boolean;
  label: string | null;
  error: string | null;
}

interface MeetingSummary {
  id: string;
  title: string;
  status: "processing" | "complete" | "failed";
  created_at: string;
  error_message: string | null;
  meeting_url: string;
}

type Section = "settings" | "recordings";

function SettingsSection({ onSaved }: { onSaved: () => void }) {
  const [apiKey, setApiKey] = useState("");
  const [current, setCurrent] = useState<SettingsResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  function refresh() {
    invoke<SettingsResponse>("get_settings").then(setCurrent);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleSave() {
    setSaveError(null);
    setSaving(true);
    try {
      await invoke("save_settings", { apiKey });
      setApiKey("");
      refresh();
      onSaved();
    } catch (e: unknown) {
      setSaveError(typeof e === "string" ? e : "Could not save the API key.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-sm font-medium">Meeting Transcriber Settings</h1>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">API Key</label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setApiKey(e.target.value.trim())}
          placeholder={current?.has_api_key ? "Enter a new key to replace it" : "mtk_..."}
        />
        <p className="text-xs text-muted-foreground">
          Generate one in the app under Settings → API Keys.
        </p>
      </div>
      <Button onClick={handleSave} disabled={saving}>
        {saving ? "Saving..." : "Save"}
      </Button>
      {saveError && <p className="text-xs text-destructive">{saveError}</p>}
      {current?.has_api_key && current.label && (
        <p className="text-xs text-emerald-500">Connected as: {current.label}</p>
      )}
      {current?.has_api_key && current.error && (
        <p className="text-xs text-destructive">
          This API key was rejected: {current.error}. Add a new one above.
        </p>
      )}
    </div>
  );
}

function statusColor(status: MeetingSummary["status"]) {
  if (status === "complete") return "text-emerald-500";
  if (status === "failed") return "text-destructive";
  return "text-muted-foreground";
}

function relativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function RecordingsSection({
  hasApiKey,
  onGoToSettings,
}: {
  hasApiKey: boolean;
  onGoToSettings: () => void;
}) {
  const [meetings, setMeetings] = useState<MeetingSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const result = await invoke<MeetingSummary[]>("fetch_recent_meetings");
      setMeetings(result);
      setLoadError(null);
    } catch (e: unknown) {
      setLoadError(typeof e === "string" ? e : "Could not load recent recordings.");
    }
  }

  useEffect(() => {
    if (!hasApiKey) return;
    load();
    // Polls only while this section is actually visible - a hidden tray
    // window has no reason to keep hitting the backend every 10s.
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, 10000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasApiKey]);

  if (!hasApiKey) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-muted-foreground">Add an API key in Settings first.</p>
        <Button variant="outline" onClick={onGoToSettings}>
          Go to Settings
        </Button>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-destructive">{loadError}</p>
        <Button variant="outline" onClick={load}>
          Retry
        </Button>
      </div>
    );
  }

  if (meetings === null) {
    return (
      <div className="p-4">
        <p className="text-xs text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (meetings.length === 0) {
    return (
      <div className="p-4">
        <p className="text-xs text-muted-foreground">No recordings yet.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-4">
      {meetings.map((meeting) => (
        <button
          key={meeting.id}
          onClick={() => openUrl(meeting.meeting_url)}
          className="flex flex-col items-start gap-0.5 rounded border border-border p-2 text-left hover:bg-accent"
        >
          <span className="text-xs font-medium">{meeting.title}</span>
          <span className={`text-xs ${statusColor(meeting.status)}`}>
            {meeting.status} · {relativeTime(meeting.created_at)}
          </span>
          {meeting.status === "failed" && meeting.error_message && (
            <span className="text-xs text-destructive">{meeting.error_message}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function App() {
  const [section, setSection] = useState<Section>("settings");
  const [hasApiKey, setHasApiKey] = useState(false);

  useEffect(() => {
    invoke<SettingsResponse>("get_settings").then((s) => setHasApiKey(s.has_api_key));
    const unlisten = listen<Section>("navigate", (event) => setSection(event.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  return (
    <div className="flex flex-col">
      <div className="flex border-b border-border">
        <button
          className={`flex-1 p-2 text-xs ${section === "settings" ? "font-medium" : "text-muted-foreground"}`}
          onClick={() => setSection("settings")}
        >
          Settings
        </button>
        <button
          className={`flex-1 p-2 text-xs ${section === "recordings" ? "font-medium" : "text-muted-foreground"}`}
          onClick={() => setSection("recordings")}
        >
          Recent Recordings
        </button>
      </div>
      {section === "settings" ? (
        <SettingsSection onSaved={() => setHasApiKey(true)} />
      ) : (
        <RecordingsSection hasApiKey={hasApiKey} onGoToSettings={() => setSection("settings")} />
      )}
    </div>
  );
}

export default App;
```

- [ ] **Step 3: Typecheck**

Run: `cd "desktop" && npx tsc --noEmit 2>&1 | tail -60`

Expected: no errors. If `openUrl` reports a missing type declaration, re-check Step 1's output - the import path must match exactly.

- [ ] **Step 4: Commit**

```bash
cd "/Volumes/Crucial X9/meeting transcriber"
git add desktop/src/App.tsx
git commit -m "Desktop: native Settings/Recent Recordings sections replacing the dashboard embed"
```

---

### Task 7: Update `CLAUDE.md`

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add the new route to the "API key auth for machine clients" section**

Find this paragraph in `CLAUDE.md`:
```
- **Two new Route Handlers**, `app/api/tokens/upload/route.js` and
  `app/api/tokens/mark-failed/route.js` - justified under the Route
```
Change `**Two new Route Handlers**` to `**Three Route Handlers**` in that sentence, and find the later bullet:
```
  reaches (it can't read a transcript, change a password, or
  touch anything `UploadToken`/`markMeetingFailedCore` don't already
  reach).
```
Immediately after that bullet point's paragraph (same list item, same indentation), add a new sentence: `A third route, GET /api/tokens/meetings, is the one deliberate exception: a narrow, read-only capability returning only { id, title, status, createdAt, errorMessage } for the key's own user (see app/lib/meetings.js's toApiKeySummary, kept separate from toSummary specifically because toSummary's preview field carries real transcript text) - added so the desktop app can show its own recording status without embedding the website. Still never exposes transcript content.`

- [ ] **Step 2: Update the File layout section**

Find:
```
- `app/api/tokens/upload/route.js`, `app/api/tokens/mark-failed/route.js`:
  the API-key Route Handlers for machine clients - see "API key auth for
  machine clients".
```
Replace with:
```
- `app/api/tokens/upload/route.js`, `app/api/tokens/mark-failed/route.js`,
  `app/api/tokens/validate/route.js`, `app/api/tokens/meetings/route.js`:
  the API-key Route Handlers for machine clients - see "API key auth for
  machine clients".
```

- [ ] **Step 3: Commit**

```bash
cd "/Volumes/Crucial X9/meeting transcriber"
git add CLAUDE.md
git commit -m "Document GET /api/tokens/meetings in CLAUDE.md"
```

---

### Task 8: Build, reinstall, and verify end to end

**Files:** none modified - build and manual verification only.

- [ ] **Step 1: Deploy the backend changes**

```bash
cd "/Volumes/Crucial X9/meeting transcriber"
git push origin main
```

Wait for the Vercel deploy to finish (`vercel ls` should show a new `Ready` deployment for `meeting-transcriber`), then confirm:

```bash
curl -s -w "\nHTTP %{http_code}\n" https://transcriber.omrajpal.in/api/tokens/meetings
```

Expected: `HTTP 401` (route exists, no key sent).

- [ ] **Step 2: Rebuild the desktop app**

```bash
cd "/Volumes/Crucial X9/meeting transcriber/desktop" && CARGO_TARGET_DIR=/tmp/mt-cargo-target npx tauri build 2>&1 | tail -40
```

Expected: `Finished 2 bundles at: ... Meeting Transcriber.app ... .dmg` (the `CARGO_TARGET_DIR` override avoids the exFAT AppleDouble panic noted in Task 3).

- [ ] **Step 3: Reinstall**

```bash
osascript -e 'tell application "Meeting Transcriber" to quit' 2>&1
pkill -f "/Applications/Meeting Transcriber.app/Contents/MacOS/desktop" 2>/dev/null
sleep 1
rm -rf "/Applications/Meeting Transcriber.app"
cp -R "/tmp/mt-cargo-target/release/bundle/macos/Meeting Transcriber.app" "/Applications/Meeting Transcriber.app"
open "/Applications/Meeting Transcriber.app"
sleep 2
ps aux | grep "MacOS/desktop" | grep -v grep
```

Expected: the process is running.

- [ ] **Step 4: Manual click-through**

1. Click the tray icon → "Settings…". Confirm the window opens on the Settings tab and shows "Connected as: `<your key's label>`" (or the empty/error state if no key is saved yet - save one if needed).
2. Click the "Recent Recordings" tab (or quit and reopen via the tray's "Recent Recordings" item, which should open directly onto this tab). Confirm real meetings from your account appear with correct statuses.
3. Click a completed meeting row. Confirm it opens that exact meeting's page in your default browser (prompting login there if needed - expected, unrelated to this feature).
4. Confirm the tray menu no longer has an "Open Dashboard" item.
5. Start and stop a real recording; wait for it to finish uploading; confirm the Recent Recordings list picks up the new row (within 10 seconds of the tab being visible) without needing to reopen the window.
