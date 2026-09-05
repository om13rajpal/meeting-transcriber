# Desktop app: native recordings view (replaces embedded dashboard)

**Status:** Approved for planning
**Author:** Om Rajpal + Claude
**Date:** 2026-09-05

## Context and goals

The desktop app (see `2026-09-02-desktop-extension-capture-design.md`) was
originally built to "also serve as a full native shell for the existing
web app" - a tray item called "Open Dashboard" opens a second window that
embeds `transcriber.omrajpal.in` directly via a Tauri `WebviewWindow`.

In practice this makes the desktop app feel like two disconnected things
bolted together rather than one coherent tool:

- The desktop app itself has no login concept - it authenticates via a
  single long-lived API key (see `CLAUDE.md`'s "API key auth for machine
  clients") pasted once into Settings. That key can only mint an upload
  token, report a failure, and validate itself. It has zero read
  capability - no meeting list, no status, no confirmation anything
  worked.
- To actually see whether a recording transcribed, the user has to open
  "Dashboard," which embeds the *entire* website and requires its own
  separate browser-session login - a completely different auth context
  from the API key, with no bridge between the two beyond both happening
  to point at the same account.
- This reads as "the desktop app doesn't work" even when the underlying
  upload pipeline is fine, because the app itself is blind to its own
  results.

This design supersedes the "full native shell" goal from the prior spec.
Goal: the desktop app becomes self-sufficient for the one question it's
actually good at answering locally - "did my recording work?" - via a
small native view of recent meeting status, fed by a narrow new read-only
API surface. Actually reading a transcript remains a website task, opened
in the user's normal browser, not re-built natively or embedded.

### Non-goals

- No transcript text, search, tags, sharing, or any other website feature
  reimplemented natively. This is a status list, not a second frontend.
- No change to the desktop app's auth model (still a single API key, no
  login screen). This design only adds one read-only capability to that
  existing key.
- No change to the Chrome extension. It has no embedded-dashboard problem
  to begin with and is out of scope here.

## Design

### 1. New backend endpoint: `GET /api/tokens/meetings`

New Route Handler, `app/api/tokens/meetings/route.js`, authenticated
identically to the existing `/api/tokens/upload`, `/api/tokens/mark-failed`,
and `/api/tokens/validate` routes (`authenticateApiKey(request)` from
`app/lib/apiKeys.js`; 401 with a generic message on an invalid/missing
key, same pattern as those three).

This is a deliberate, narrow widening of what an API key can do. Per
CLAUDE.md's existing rule, a key "can only ever do what a logged-in
browser tab can already do" and "never act as a general-purpose account
credential (it can't read a transcript...)" - this endpoint must keep
that true. It returns **status metadata only, never transcript content**:

```
GET /api/tokens/meetings
-> 200 { meetings: [{ id, title, status, createdAt, errorMessage }, ...] }
-> 401 { error: "..." }
```

- `app/lib/meetings.js` gets a new `toApiKeySummary(meeting)` mapper,
  deliberately separate from the existing `toSummary()` (which includes a
  `preview` field containing actual transcript text - exactly what this
  surface must never expose). Fields: `id` (string), `title` (falling
  back to `originalName` then `'Untitled recording'`, matching
  `toSummary`'s existing fallback), `status`, `createdAt` (ISO string),
  `errorMessage` (or `null`).
- A new `listMeetingsForApiKey(userId, limit = 20)` follows
  `listMeetings()`'s existing shape exactly: `Meeting.find({ userId })
  .select('-utterances').sort({ createdAt: -1 }).lean()`, capped at
  `limit`, mapped through `toApiKeySummary`. No search/tag filtering -
  this is "recent activity," not a search UI.
- Ownership rule is unchanged: `userId` comes only from the resolved
  `ApiKey` document (`authenticateApiKey`'s return value), never from
  client input, same as every other route.

### 2. Desktop: `get_settings` becomes identity-aware

`get_settings` (`desktop/src-tauri/src/lib.rs`) becomes `async`. When a
key is present in the Keychain, it calls the existing `validate_api_key()`
helper (already implemented for `save_settings`) to fetch the live
`label` from `/api/tokens/validate`, instead of trusting local presence
alone. This also means a key that was revoked *after* being saved is
caught the next time Settings opens, not just at save time.

`SettingsResponse` grows two fields:

```rust
struct SettingsResponse {
    has_api_key: bool,
    label: Option<String>,       // Some(label) only when has_api_key && still valid
    revoked: bool,                // true when a key is saved locally but the app rejects it
}
```

`App.tsx`'s Settings section shows "Connected as: `<label>`" when present,
or "This API key was revoked - add a new one" when `revoked` is true,
replacing the current bare "(saved)" text.

### 3. Desktop: new `fetch_recent_meetings` command

New `#[tauri::command] async fn fetch_recent_meetings() -> Result<Vec<MeetingSummary>, String>`,
built on the same `reqwest` client/timeout pattern as `validate_api_key()`
(`HTTP_CONNECT_TIMEOUT` + `JSON_REQUEST_TIMEOUT`, bearer auth from the
Keychain). Calls `GET {APP_URL}/api/tokens/meetings`.

```rust
struct MeetingSummary {
    id: String,
    title: String,
    status: String,          // "processing" | "complete" | "failed"
    created_at: String,
    error_message: Option<String>,
    meeting_url: String,     // built here as `{APP_URL}/meeting/{id}` - the
                              // frontend never needs to know APP_URL itself,
                              // matching the existing pattern in App.tsx's
                              // doc comment about APP_URL being Rust-only.
}
```

If no key is saved, returns `Err("No API key configured.")` immediately
without a network call - the frontend already knows to show its own
"add a key first" state instead of surfacing this as an error.

### 4. Desktop frontend: two sections, one window

`App.tsx` gains a simple section switcher (two buttons/tabs: "Settings",
"Recent Recordings") inside the existing single `main` window - no new
window, no new Tauri capability entry needed.

**Recent Recordings section:**
- On mount and on becoming visible: call `fetch_recent_meetings`.
- While visible, poll every 10 seconds (`setInterval`, cleared on
  unmount/hidden - this is a tray-adjacent utility window, not something
  that should poll while closed).
- Each row: title, a small status badge (processing / complete / failed,
  color-coded consistently with the website's own status colors),
  relative timestamp, and the error message inline when failed.
- Clicking a row calls `open(meeting_url)` (already-installed
  `@tauri-apps/plugin-opener`, same plugin already a dependency) to
  launch the system default browser at that meeting's page. Normal
  website login applies there - this design does not change or bridge
  that.
- No key saved: show "Add an API key in Settings first" with a button
  that switches to the Settings section, instead of attempting a fetch.
- Fetch failure (network/non-2xx/parse): inline "Couldn't load recent
  recordings" with a manual Retry button. No native dialog - dialogs stay
  reserved for actual recording/upload failures (see the earlier
  `show_error_dialog` work), not a background metadata refresh that will
  simply retry on its own next poll.

### 5. Removed: the embedded dashboard window

- The tray's `"open_dashboard"` menu handler and its
  `WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::External(...))`
  block in `lib.rs` are deleted entirely.
- The tray menu item is renamed from "Open Dashboard" to "Recent
  Recordings," and now shows/focuses the `main` window with that section
  selected (same `window.show()` / `window.set_focus()` pattern the
  existing `"open_settings"` handler already uses).
- The `"dashboard"` entry in `desktop/src-tauri/capabilities/default.json`
  (already scoped to zero permissions, per the earlier investigation) is
  removed since the window no longer exists.
- `tauri.conf.json` needs no change beyond whatever is implied by the
  window removal - the `main` window's existing config is reused as-is
  for both sections.

## Data flow summary

```
Tray "Recent Recordings" or "Settings"
        |
        v
  main window shows, section selected
        |
        +-- Settings section --> get_settings() --> validate_api_key()
        |                         (label / revoked / has_api_key)
        |
        +-- Recordings section --> fetch_recent_meetings()
                                    --> GET /api/tokens/meetings
                                    --> [{id,title,status,createdAt,
                                          errorMessage,meeting_url}]
                                    (repeats every 10s while visible)
                                        |
                                        v
                              click row --> open(meeting_url)
                                            --> system browser
                                            --> website login (if needed)
                                            --> full transcript page
```

## Error handling

| Failure | Behavior |
|---|---|
| No key saved | Recordings section shows "add a key first," no fetch attempted |
| Key revoked (caught at Settings load) | Settings shows "revoked, add a new one" |
| `/api/tokens/meetings` unreachable/non-2xx | Inline "couldn't load," manual Retry - no dialog |
| A specific meeting `status: 'failed'` | Row shows the meeting's own `errorMessage`, same text the website would show |

## Testing

No automated test suite exists for the desktop frontend or Rust command
layer today (consistent with the rest of this codebase - see the existing
"NOTE: no automated tests here on purpose" comment in `lib.rs` regarding
Keychain-touching tests). This feature is verified manually per
`CLAUDE.md`'s testing rules:

1. `cargo check` clean, `tsc`/frontend build clean (both desktop and
   the new backend route via `npm run build` if applicable).
2. With a valid key saved: Recordings section shows real meetings for
   that account, statuses reflect the actual database state, and a
   `processing` row flips to `complete`/`failed` on the next poll after
   the backend finishes.
3. Clicking a row opens the correct meeting page in the default browser.
4. Revoke the key from the website's API Keys settings, reopen desktop
   Settings, confirm the "revoked" state appears.
5. Force `/api/tokens/meetings` to fail (e.g. airplane mode) and confirm
   the inline error + Retry appears, with no native dialog popping up.
6. Confirm the tray's "Open Dashboard" item is gone and "Recent
   Recordings" opens the right section.
