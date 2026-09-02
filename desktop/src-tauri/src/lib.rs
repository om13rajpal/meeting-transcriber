// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

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

// Real verification, not a mock: these tests hit the actual macOS Keychain
// (via `keyring`'s real platform backend) and the actual filesystem under
// `dirs::config_dir()` - no fakes/stubs substituted in. Run with
// `cargo test -- --test-threads=1` since both tests touch the same
// (SERVICE, KEY_USER) real keychain entry and would otherwise race.
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keychain_round_trip() {
        let entry = Entry::new(SERVICE, KEY_USER).expect("failed to create keyring entry");
        let test_value = "test-api-key-round-trip-12345";
        entry
            .set_password(test_value)
            .expect("failed to set password in real Keychain");
        let retrieved = entry
            .get_password()
            .expect("failed to read password back from real Keychain");
        assert_eq!(retrieved, test_value, "round-tripped value did not match");
    }

    #[test]
    fn settings_commands_round_trip() {
        // Exercises the exact save_settings/get_settings Tauri commands the
        // frontend calls, not a reimplementation of their logic.
        let url = "https://example-desktop-test.vercel.app";
        let key = "mtk_test_do_not_use_1234567890";

        save_settings(url.to_string(), key.to_string()).expect("save_settings failed");

        let settings = get_settings().expect("get_settings failed");
        assert_eq!(settings.app_url, url);
        assert!(settings.has_api_key, "has_api_key should be true after saving a key");

        // The config file must hold the App URL but never the raw API key.
        let raw = fs::read_to_string(config_path()).expect("config file was not written");
        assert!(raw.contains(url), "config file missing the App URL");
        assert!(
            !raw.contains(key),
            "raw API key leaked into the plaintext config file"
        );
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
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
                        // Wired to real start/stop logic in Task 5 - stubbed here
                        // just to prove the menu event loop works end to end first.
                        println!("toggle_recording clicked");
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
