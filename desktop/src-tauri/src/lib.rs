// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod capture;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, State};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

// Service/user names under which the API key is stored in the OS keychain
// (Keychain Access on macOS, Credential Manager on Windows). The key itself
// is never written to disk in plaintext - only the App URL goes to the JSON
// config file below.
const SERVICE: &str = "meeting-transcriber";
const KEY_USER: &str = "api-key";

// CLAUDE.md's "External API calls" rule: every outbound call needs a
// timeout. `HTTP_CONNECT_TIMEOUT` is set on the shared `reqwest::Client` in
// `upload_recording`, so it applies to all three of that function's calls
// (mint token, upload, mark-failed) uniformly - including the multipart
// upload, which deliberately gets no other timeout: a large recording can
// legitimately take minutes to upload, and capping its *total* duration
// would abort a slow-but-working upload. The two small JSON calls (mint
// token, mark-failed) layer `JSON_REQUEST_TIMEOUT` on top, per-request,
// since those should fail fast on a connection that connected but then
// went quiet, not hang indefinitely.
const HTTP_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const JSON_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Serialize, Deserialize)]
struct StoredConfig {
    app_url: String,
}

fn config_path() -> std::path::PathBuf {
    let mut dir = dirs::config_dir().expect("config dir not found");
    dir.push("meeting-transcriber");
    fs::create_dir_all(&dir).ok();
    dir.push("config.json");
    dir
}

#[derive(Serialize)]
struct SettingsResponse {
    app_url: String,
    has_api_key: bool,
}

#[tauri::command]
fn save_settings(app_url: String, api_key: String) -> Result<(), String> {
    let config = StoredConfig { app_url };
    let json = serde_json::to_string(&config).map_err(|e| e.to_string())?;
    fs::write(config_path(), json).map_err(|e| e.to_string())?;

    // Only touch the keychain entry if a new key was actually entered - an
    // empty field means "keep whatever's already saved", not "clear it".
    if !api_key.is_empty() {
        let entry = Entry::new(SERVICE, KEY_USER).map_err(|e| e.to_string())?;
        entry.set_password(&api_key).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_settings() -> Result<SettingsResponse, String> {
    let app_url = fs::read_to_string(config_path())
        .ok()
        .and_then(|s| serde_json::from_str::<StoredConfig>(&s).ok())
        .map(|c| c.app_url)
        .unwrap_or_default();

    // Only ever report presence, never the raw key - the frontend has no
    // legitimate use for it once it's saved.
    let has_api_key = Entry::new(SERVICE, KEY_USER)
        .and_then(|e| e.get_password())
        .is_ok();

    Ok(SettingsResponse { app_url, has_api_key })
}

// NOTE: no automated tests here on purpose. An earlier version of this file
// had a #[cfg(test)] module that exercised save_settings/get_settings and
// Entry::new(SERVICE, KEY_USER) directly - but that means it wrote to the
// exact same production Keychain service/username and the exact same real
// dirs::config_dir() config file the real running app uses, with no
// cleanup. This project has no CI (see CLAUDE.md - manual verification is
// the standard here), so that module would only ever run if a developer
// typed `cargo test` by hand - and if they ever did that on a machine where
// a real API key/App URL had already been saved through the actual app, it
// would silently clobber that real saved credential and config with test
// fixture values. Giving the tests distinct test-only identifiers would
// require adding test-only path-override plumbing into config_path() in
// production code purely to make that possible, which is exactly the kind
// of speculative complexity this codebase avoids elsewhere. The real
// verification for this file (a genuine macOS Keychain round-trip via
// `cargo test` against a scratch value, independently confirmed with the
// `security` CLI, plus a real dirs::config_dir() config file read back with
// `cat`) was done manually once and is documented in
// .superpowers/sdd/2026-09-02-desktop-app-capture/task-3-report.md instead.

// The tray toggle's view of the current recording, held for the life of
// the app in Tauri's managed state.
//
// Plain `Option<capture::RecordingHandle>` (as the plan sketched) is not
// enough on its own: `capture::start_recording` can block for minutes (see
// its doc comment in capture/mod.rs - on a fresh machine it waits on the
// macOS Screen Recording permission prompt, with no cancellation path), so
// it has to run on a spawned thread rather than inside the menu event
// handler. That leaves a real window - between the click and the spawned
// thread reporting back - where the state is neither "idle" nor "holding a
// handle". `Starting`/`Stopping` name that window explicitly, so a second
// click landing in it is a deliberate no-op (logged, not silently
// launching a second overlapping recording session) rather than an
// unrepresentable state.
enum RecordingSlot {
    Idle,
    Starting,
    Recording(capture::RecordingHandle),
    Stopping,
}

// `generation` closes a narrow, self-healing race between the tray label
// and `slot`: the "write the new state" and "write the matching label"
// halves of a transition are necessarily two separate operations (holding
// `slot`'s lock across `set_toggle_label` would deadlock - see the comment
// on `set_toggle_label_if_current` below), so a background thread's label
// write can be delayed by OS scheduling and land *after* a later
// transition's own label write, clobbering it with stale text even though
// `slot` itself was never wrong. `generation` is bumped once per
// transition, atomically together with the `slot` write (inside the same
// critical section, so its ordering matches the mutex's - see each call
// site), and captured at that moment; a label write only applies if its
// captured generation is still current when it actually runs, so a
// superseded write becomes a silent no-op instead of an overwrite.
struct RecordingState {
    slot: Mutex<RecordingSlot>,
    generation: AtomicU64,
}

impl RecordingState {
    fn new() -> Self {
        Self {
            slot: Mutex::new(RecordingSlot::Idle),
            generation: AtomicU64::new(0),
        }
    }
}

/// Where the next recording's WAV file goes. A fresh, timestamped path
/// inside the app's own data directory - `app_data_dir()` (not `.unwrap()`,
/// per this project's no-panics-on-a-failure-path rule) so a permissions
/// problem with that directory surfaces as the same client-safe error
/// path as any other `start_recording` failure, instead of a stray panic
/// on the recording-session thread.
fn recording_output_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve the app data directory: {e}"))?;
    fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create the app data directory: {e}"))?;
    Ok(dir.join(format!("recording-{}.wav", chrono::Utc::now().timestamp())))
}

/// Sets the tray toggle's label. `MenuItem::set_text` is safe to call from
/// any thread - Tauri's menu handles are `Send`/`Sync` wrappers that always
/// dispatch the actual mutation onto the main thread internally (see
/// `tauri::menu::normal::MenuItem::set_text`, which goes through
/// `run_item_main_thread!`) - so both the recording-session spawned thread
/// and the menu event handler itself can call this directly without
/// reaching for `app.run_on_main_thread(...)`.
fn set_toggle_label<R: tauri::Runtime>(item: &MenuItem<R>, text: &str) {
    if let Err(e) = item.set_text(text) {
        eprintln!("failed to update tray menu label: {e}");
    }
}

/// Same as `set_toggle_label`, but only applies if `expected_generation`
/// still matches `generation`'s live value at the moment this runs - i.e.
/// only if no newer transition has committed since `expected_generation`
/// was captured. See the comment on `RecordingState::generation` for why
/// this check exists: without it, a label write from an older transition
/// can be delayed (crossing threads, or just OS scheduling) long enough to
/// land after - and overwrite - a newer transition's own label write, even
/// though the underlying `RecordingSlot` was never actually wrong. This is
/// deliberately a plain `load` outside any lock, not a check-and-set: the
/// generation only ever *decides whether to write the label*, it is never
/// itself required to stay in sync with a concurrent writer, so a relaxed
/// read-then-maybe-write here is enough (worst case on a true tie is one
/// harmless extra write of the correct text).
fn set_toggle_label_if_current<R: tauri::Runtime>(
    item: &MenuItem<R>,
    text: &str,
    generation: &AtomicU64,
    expected_generation: u64,
) {
    if generation.load(Ordering::SeqCst) != expected_generation {
        return;
    }
    set_toggle_label(item, text);
}

/// Response shape of `POST /api/tokens/upload` - see
/// `app/lib/uploadTokens.js`'s `mintUploadToken` on the frontend, which is
/// what actually builds this JSON (`{ token, backendUrl, meeting: { id,
/// ... } }`). The `rename_all` matters: that route returns camelCase
/// (`backendUrl`), and without it serde would look for a literal
/// `backend_url` key and this would fail to deserialize on every call.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TokenResult {
    token: String,
    backend_url: String,
    meeting: MeetingRef,
}

#[derive(serde::Deserialize)]
struct MeetingRef {
    id: String,
}

/// Reports a failed upload back to `/api/tokens/mark-failed` so the
/// `Meeting` row doesn't sit at `'processing'` until the backend's 30-minute
/// stale-job sweep notices. Companion to the token mint above - see
/// `app/api/tokens/mark-failed/route.js`, which expects exactly
/// `{ meetingId, message }` alongside the same `Authorization: Bearer`
/// header used to mint the token. Best-effort like every other
/// notification path in this app: a failure to even report the failure is
/// logged, not retried or surfaced further.
async fn report_failure(
    client: &reqwest::Client,
    app_url: &str,
    api_key: &str,
    meeting_id: &str,
    message: &str,
) {
    let result = client
        .post(format!("{app_url}/api/tokens/mark-failed"))
        .bearer_auth(api_key)
        // Small JSON call, should fail fast rather than hang - see the
        // comment on `client` in `upload_recording` for why this needs its
        // own per-request timeout on top of the client's connect timeout.
        .timeout(JSON_REQUEST_TIMEOUT)
        .json(&serde_json::json!({ "meetingId": meeting_id, "message": message }))
        .send()
        .await;
    if let Err(e) = result {
        eprintln!("could not report upload failure to the app: {e}");
    }
}

/// Uploads a finished recording through the API-key-auth flow: mint an
/// upload token against the configured App URL, then post the file
/// straight to the backend's `/api/transcribe`, matching the shape
/// `backend/server.js`'s `multer.single('file')` + `req.body.token`
/// expects. Mirrors the browser dashboard's direct-to-backend upload (see
/// CLAUDE.md's "Upload token flow"), just from Rust instead of
/// `XMLHttpRequest`.
///
/// Takes no `AppHandle` - nothing here needs one today (settings come from
/// the plain `get_settings()`/keychain calls below, not app state or a
/// window). Adding one back speculatively for a hypothetical future native
/// notification isn't this task's job; Task 8 can add it when it actually
/// needs it.
async fn upload_recording(wav_path: PathBuf) {
    let settings = match get_settings() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("upload skipped: could not read settings: {e}");
            return;
        }
    };
    if settings.app_url.is_empty() || !settings.has_api_key {
        eprintln!("upload skipped: App URL or API key not configured");
        return;
    }
    let api_key = match Entry::new(SERVICE, KEY_USER).and_then(|e| e.get_password()) {
        Ok(k) => k,
        Err(e) => {
            eprintln!("upload skipped: could not read the API key from the keychain: {e}");
            return;
        }
    };

    // A connect timeout applies to every request made through this client
    // (see the comment on `HTTP_CONNECT_TIMEOUT` above), including the
    // multipart upload below, without capping how long that upload itself
    // may run. `reqwest::Client::builder().build()` only fails on a broken
    // TLS backend configuration, which isn't something this app's own code
    // can cause - but per this project's no-panics-on-a-failure-path rule,
    // a failure here still falls back to a client with no explicit
    // timeouts rather than panicking, so a token mint at least has a
    // chance instead of the whole upload attempt aborting outright.
    let client = reqwest::Client::builder()
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .build()
        .unwrap_or_else(|e| {
            eprintln!("could not build HTTP client with a connect timeout, falling back to defaults: {e}");
            reqwest::Client::new()
        });
    let file_name = format!(
        "Desktop recording {}",
        chrono::Local::now().format("%Y-%m-%d %H:%M")
    );

    let token_response = match client
        .post(format!("{}/api/tokens/upload", settings.app_url))
        .bearer_auth(&api_key)
        // Small JSON call, should fail fast - see `JSON_REQUEST_TIMEOUT`'s
        // doc comment. The multipart upload further down deliberately does
        // NOT get this same per-request timeout.
        .timeout(JSON_REQUEST_TIMEOUT)
        .json(&serde_json::json!({ "fileName": file_name }))
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            eprintln!("could not reach app to mint upload token: {e}");
            return; // wav_path stays on disk - see Task 8 for the retry path
        }
    };

    if !token_response.status().is_success() {
        eprintln!("token mint failed: {}", token_response.status());
        return;
    }

    let result: TokenResult = match token_response.json().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("could not parse token response: {e}");
            return;
        }
    };

    let file_bytes = match tokio::fs::read(&wav_path).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("could not read recording file: {e}");
            report_failure(
                &client,
                &settings.app_url,
                &api_key,
                &result.meeting.id,
                "Could not read the local recording file.",
            )
            .await;
            return;
        }
    };

    let part = reqwest::multipart::Part::bytes(file_bytes).file_name("recording.wav");
    let form = reqwest::multipart::Form::new()
        .text("token", result.token)
        .part("file", part);

    match client
        .post(format!("{}/api/transcribe", result.backend_url))
        .multipart(form)
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => {
            let _ = tokio::fs::remove_file(&wav_path).await; // only delete on confirmed success
        }
        Ok(r) => {
            eprintln!("upload failed: {}", r.status());
            report_failure(
                &client,
                &settings.app_url,
                &api_key,
                &result.meeting.id,
                &format!("Upload failed with status {}.", r.status()),
            )
            .await;
        }
        Err(e) => {
            eprintln!("upload network error: {e}");
            report_failure(
                &client,
                &settings.app_url,
                &api_key,
                &result.meeting.id,
                "Network error during upload from the desktop app.",
            )
            .await;
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(RecordingState::new())
        .invoke_handler(tauri::generate_handler![
            greet,
            save_settings,
            get_settings
        ])
        .setup(|app| {
            let toggle_item = MenuItem::with_id(
                app,
                "toggle_recording",
                "Start Recording",
                true,
                None::<&str>,
            )?;
            let open_dashboard_item = MenuItem::with_id(
                app,
                "open_dashboard",
                "Open Dashboard",
                true,
                None::<&str>,
            )?;
            let settings_item =
                MenuItem::with_id(app, "open_settings", "Settings…", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[
                    &toggle_item,
                    &open_dashboard_item,
                    &settings_item,
                    &quit_item,
                ],
            )?;

            TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "toggle_recording" => {
                        let state: State<RecordingState> = app.state();
                        let mut guard = state.slot.lock().unwrap();
                        match &*guard {
                            RecordingSlot::Idle => {
                                *guard = RecordingSlot::Starting;
                                // Bumped *while still holding `guard`, in the
                                // same critical section as the `slot` write
                                // above - not after `drop(guard)` below. That
                                // placement is what makes the generation
                                // values come out in the same order the
                                // mutex already serializes `slot`'s writes
                                // in; bumping it separately, unguarded, could
                                // let two threads' bumps land in a different
                                // order than their (correctly mutex-ordered)
                                // `slot` writes did, which would defeat the
                                // whole point.
                                let my_generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
                                // Dropping `guard` here - rather than
                                // holding it across the `set_toggle_label...`
                                // call below - is deliberately load-bearing,
                                // not a style choice: `set_text` blocks on a
                                // round-trip to the main thread, and if this
                                // closure *is* the main thread (which it is -
                                // menu events run there), a later spawned
                                // thread's own attempt to `state.slot.lock()`
                                // while this guard was still held would
                                // deadlock against it. Never fold this into
                                // a `let mut guard = ...; set_toggle_label(...)`
                                // that keeps the guard alive across the call.
                                drop(guard);
                                set_toggle_label_if_current(
                                    &toggle_item,
                                    "Starting…",
                                    &state.generation,
                                    my_generation,
                                );

                                let app_handle = app.clone();
                                let toggle_handle = toggle_item.clone();
                                // capture::start_recording can block for
                                // minutes (an unanswered Screen Recording
                                // permission prompt on first run) - calling
                                // it here on the main thread, where this
                                // whole event handler runs, would freeze the
                                // tray menu and every window for as long as
                                // that takes. A real OS thread is required,
                                // not tauri::async_runtime::spawn: that runs
                                // async tasks on an executor thread, which a
                                // synchronous blocking call would just as
                                // happily freeze.
                                std::thread::spawn(move || {
                                    let result = recording_output_path(&app_handle)
                                        .and_then(|path| capture::start_recording(&path));
                                    let state: State<RecordingState> = app_handle.state();
                                    match result {
                                        Ok(handle) => {
                                            // `drop(guard)` before the label
                                            // call below is load-bearing, not
                                            // a style choice - see the long
                                            // comment on the "Idle" branch
                                            // above. This runs on a spawned
                                            // thread rather than the main
                                            // thread, so the deadlock risk is
                                            // against `set_text`'s own
                                            // internal main-thread round trip
                                            // rather than this closure's own
                                            // thread, but the fix is the
                                            // same: never hold `guard` across
                                            // that call.
                                            let mut guard = state.slot.lock().unwrap();
                                            *guard = RecordingSlot::Recording(handle);
                                            let my_generation =
                                                state.generation.fetch_add(1, Ordering::SeqCst) + 1;
                                            drop(guard);
                                            set_toggle_label_if_current(
                                                &toggle_handle,
                                                "Stop Recording",
                                                &state.generation,
                                                my_generation,
                                            );
                                        }
                                        Err(e) => {
                                            // Same reasoning as the `Ok` arm
                                            // just above.
                                            let mut guard = state.slot.lock().unwrap();
                                            *guard = RecordingSlot::Idle;
                                            let my_generation =
                                                state.generation.fetch_add(1, Ordering::SeqCst) + 1;
                                            drop(guard);
                                            set_toggle_label_if_current(
                                                &toggle_handle,
                                                "Start Recording",
                                                &state.generation,
                                                my_generation,
                                            );
                                            // Task 8 is where this becomes a
                                            // native notification; for now
                                            // the exact permission-denial or
                                            // missing-device message from
                                            // capture::start_recording at
                                            // least reaches the log rather
                                            // than being swallowed.
                                            eprintln!("failed to start recording: {e}");
                                        }
                                    }
                                });
                            }
                            RecordingSlot::Starting => {
                                eprintln!(
                                    "toggle_recording ignored: a recording is already starting"
                                );
                            }
                            RecordingSlot::Stopping => {
                                eprintln!(
                                    "toggle_recording ignored: a recording is already stopping"
                                );
                            }
                            RecordingSlot::Recording(_) => {
                                let previous =
                                    std::mem::replace(&mut *guard, RecordingSlot::Stopping);
                                // Generation bumped before `drop(guard)`
                                // below, same reasoning as the "Idle" branch
                                // above (ordering); `drop(guard)` itself is
                                // load-bearing for the same reason too
                                // (deadlock avoidance against `set_text`'s
                                // main-thread round trip) - never fold this
                                // into a `let mut guard = ...` held across
                                // the `set_toggle_label_if_current` call
                                // below.
                                let my_generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
                                drop(guard);
                                let handle = match previous {
                                    RecordingSlot::Recording(handle) => handle,
                                    _ => unreachable!("guarded by the match above"),
                                };
                                set_toggle_label_if_current(
                                    &toggle_item,
                                    "Stopping…",
                                    &state.generation,
                                    my_generation,
                                );

                                let app_handle = app.clone();
                                let toggle_handle = toggle_item.clone();
                                std::thread::spawn(move || {
                                    let result = capture::stop_recording(handle);
                                    let state: State<RecordingState> = app_handle.state();
                                    // Same load-bearing `drop(guard)`-before-
                                    // the-label-call reasoning as the "Idle"
                                    // branch's long comment above.
                                    let mut guard = state.slot.lock().unwrap();
                                    *guard = RecordingSlot::Idle;
                                    let my_generation =
                                        state.generation.fetch_add(1, Ordering::SeqCst) + 1;
                                    drop(guard);
                                    set_toggle_label_if_current(
                                        &toggle_handle,
                                        "Start Recording",
                                        &state.generation,
                                        my_generation,
                                    );

                                    match result {
                                        Ok(wav_path) => {
                                            tauri::async_runtime::spawn(async move {
                                                upload_recording(wav_path).await;
                                            });
                                        }
                                        Err(e) => {
                                            eprintln!("failed to stop recording: {e}");
                                        }
                                    }
                                });
                            }
                        }
                    }
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
                            match get_settings() {
                                Ok(settings) if settings.app_url.is_empty() => {
                                    // A real case, not a misconfiguration: a
                                    // user who hasn't been through Settings
                                    // yet. Logged, not panicking - a native
                                    // alert is deferred to Task 8's broader
                                    // "clear, non-silent errors" pass rather
                                    // than duplicating similar UI here first.
                                    eprintln!(
                                        "cannot open dashboard: App URL not configured yet"
                                    );
                                }
                                Ok(settings) => match settings.app_url.parse() {
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
                                        // Also a real, reachable case (a
                                        // malformed value saved outside the
                                        // Settings dialog's own validation, or
                                        // a future regression in it) - fail
                                        // the same clear, non-panicking way as
                                        // every other failure path here rather
                                        // than the brief's original
                                        // `.expect(...)`.
                                        eprintln!(
                                            "cannot open dashboard: invalid App URL {:?}: {e}",
                                            settings.app_url
                                        );
                                    }
                                },
                                Err(e) => {
                                    eprintln!(
                                        "cannot open dashboard: could not read settings: {e}"
                                    );
                                }
                            }
                        }
                    }
                    "open_settings" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
