// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
mod capture;

use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
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

struct RecordingState(Mutex<RecordingSlot>);

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

    let client = reqwest::Client::new();
    let file_name = format!(
        "Desktop recording {}",
        chrono::Local::now().format("%Y-%m-%d %H:%M")
    );

    let token_response = match client
        .post(format!("{}/api/tokens/upload", settings.app_url))
        .bearer_auth(&api_key)
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
        .manage(RecordingState(Mutex::new(RecordingSlot::Idle)))
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
                        let mut guard = state.0.lock().unwrap();
                        match &*guard {
                            RecordingSlot::Idle => {
                                *guard = RecordingSlot::Starting;
                                drop(guard);
                                set_toggle_label(&toggle_item, "Starting…");

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
                                            *state.0.lock().unwrap() =
                                                RecordingSlot::Recording(handle);
                                            set_toggle_label(&toggle_handle, "Stop Recording");
                                        }
                                        Err(e) => {
                                            *state.0.lock().unwrap() = RecordingSlot::Idle;
                                            set_toggle_label(&toggle_handle, "Start Recording");
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
                                drop(guard);
                                let handle = match previous {
                                    RecordingSlot::Recording(handle) => handle,
                                    _ => unreachable!("guarded by the match above"),
                                };
                                set_toggle_label(&toggle_item, "Stopping…");

                                let app_handle = app.clone();
                                let toggle_handle = toggle_item.clone();
                                std::thread::spawn(move || {
                                    let result = capture::stop_recording(handle);
                                    let state: State<RecordingState> = app_handle.state();
                                    *state.0.lock().unwrap() = RecordingSlot::Idle;
                                    set_toggle_label(&toggle_handle, "Start Recording");

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
                        // Wired to the real external-URL window in Task 7.
                        println!("open_dashboard clicked");
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
