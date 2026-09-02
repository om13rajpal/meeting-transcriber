# Desktop App Capture (Tauri, macOS + Windows) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cross-platform (macOS + Windows) tray app that captures system audio + microphone locally, uploads the finished recording into the existing transcription pipeline, and embeds the existing web app in a second window for full feature parity — no browser needed.

**Architecture:** A Tauri v2 app. The default window (the app's own small bundled React frontend) is a hidden-by-default Settings form for the App URL + API key. A tray icon menu drives Start/Stop Recording and opens a second window pointed at the deployed web app via `WebviewUrl::External` — that window *is* the existing dashboard/history/search/settings UI, unmodified. The Rust side captures microphone input via `cpal` (a standard, well-established cross-platform audio I/O crate) and system audio loopback via a platform-specific crate (`screencapturekit` on macOS, `wasapi` on Windows — real crates.io packages; their exact capture-callback API needs a quick doc read before wiring, called out explicitly below rather than guessed), mixes both into one stream, writes it to a WAV file, and uploads it on stop using the same API-key-based token flow the extension uses.

**Tech Stack:** Tauri v2.9.x, Rust, `cpal` (mic capture), `screencapturekit` / `wasapi` (system audio loopback, platform-gated), `hound` (WAV writing), `keyring` (secure API-key storage), `reqwest` (multipart upload), React + Tailwind v4 + shadcn (Base UI) for the small bundled Settings UI.

**Spec:** `docs/superpowers/specs/2026-09-02-desktop-extension-capture-design.md`

**Depends on:** `docs/superpowers/plans/2026-09-02-api-key-auth.md` must be done first — this app mints upload tokens via `POST {appUrl}/api/tokens/upload` with a Bearer API key, exactly like the extension.

## Global Constraints

- No automated test framework, and native OS audio capture cannot be meaningfully unit-tested without real hardware/mic access anyway — every task ends with real manual verification on an actual machine, per the design spec's Testing Strategy section.
- No code signing (confirmed via research: one-time-per-machine Gatekeeper/SmartScreen click-through, not a functional blocker, for a single developer installing on their own machines only).
- The API key is stored via the OS's real secure credential store (macOS Keychain / Windows Credential Manager) through the `keyring` crate — never a plaintext file. The App URL (not secret) can live in a plain local config file.
- **Where this plan says "read the crate's docs before writing this call," that is a required, concrete first step, not a placeholder** — `screencapturekit`'s and `wasapi`'s exact callback signatures were confirmed to exist as real crates but their precise method names were not independently verified while writing this plan, unlike `cpal`'s API used for mic capture below, which is used with high confidence. Do not invent plausible-looking method names; read `docs.rs` for the pinned version first.
- Follow the design spec's error-handling rules: partial recordings survive a crash (kept on disk, offered for retry), permission denial gets a clear pointer to the exact System Settings/Privacy pane, and upload failure leaves a `'failed'` `Meeting` row rather than losing the job silently.

---

### Task 1: Scaffold the Tauri app

**Files:**
- Create: `desktop/` (new top-level directory, sibling to `backend/` and `extension/`)
- Create: `desktop/src-tauri/{Cargo.toml, src/main.rs, tauri.conf.json}`
- Create: `desktop/src/{main.tsx, App.tsx}` (the bundled Settings frontend)

**Interfaces:**
- Produces: `npm run tauri dev` launches the app with a visible default window rendering the placeholder React frontend; `npm run tauri build` produces a real installable app bundle for the current OS.

- [ ] **Step 1: Scaffold with the official CLI**

```bash
cd "/Volumes/Crucial X9/meeting transcriber"
npm create tauri-app@latest desktop -- --template react-ts
cd desktop
npm install
```

- [ ] **Step 2: Add Tailwind v4 to the bundled frontend**

Same mechanism as the extension plan — `npm install tailwindcss @tailwindcss/vite`, add the plugin to `desktop/vite.config.ts`'s `plugins` array, add `@import "tailwindcss";` to `desktop/src/App.css` (or equivalent, per the template's actual generated file name), copy `components/ui/button.jsx`, `card.jsx`, `input.jsx` and `lib/utils.js` from the repo root into `desktop/src/components/ui/` and `desktop/src/lib/`, same as `extension/` did.

- [ ] **Step 3: Verify it launches**

```bash
npm run tauri dev
```

Expected: a native window opens showing the Vite+React template's default page, styled with Tailwind (confirm via dev tools that the copied `button.jsx` renders with real computed Tailwind styles, same check as the extension's Task 1).

- [ ] **Step 4: Commit**

```bash
cd "/Volumes/Crucial X9/meeting transcriber"
git add desktop/
git commit -m "$(cat <<'EOF'
Scaffold Tauri desktop app with React + Tailwind v4

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Tray icon, menu, and the Settings window

**Files:**
- Modify: `desktop/src-tauri/Cargo.toml` (add the `tray-icon` feature to the `tauri` dependency)
- Modify: `desktop/src-tauri/src/main.rs`
- Modify: `desktop/src-tauri/tauri.conf.json` (start hidden, not with a visible window on launch)

**Interfaces:**
- Produces: a tray icon with menu items `Start Recording` / `Stop Recording` (toggles label), `Open Dashboard`, `Settings…`, `Quit`. `Settings…` shows the app's main (default) window; `Quit` exits.

- [ ] **Step 1: Enable the tray-icon feature**

In `desktop/src-tauri/Cargo.toml`:

```toml
[dependencies]
tauri = { version = "2", features = ["tray-icon"] }
```

- [ ] **Step 2: Build the tray + menu**

In `desktop/src-tauri/src/main.rs`, inside the `tauri::Builder::default()` setup closure:

```rust
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::Manager;

// ... inside .setup(|app| { ... })
let toggle_item = MenuItem::with_id(app, "toggle_recording", "Start Recording", true, None::<&str>)?;
let open_dashboard_item = MenuItem::with_id(app, "open_dashboard", "Open Dashboard", true, None::<&str>)?;
let settings_item = MenuItem::with_id(app, "open_settings", "Settings…", true, None::<&str>)?;
let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
let menu = Menu::with_items(app, &[&toggle_item, &open_dashboard_item, &settings_item, &quit_item])?;

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
```

(Confirm the exact `MenuItem`/`Menu`/`TrayIconBuilder` method names against `docs.rs` for the Tauri version `npm create tauri-app` actually pinned in Task 1 — this shape matches Tauri v2's documented tray pattern but re-check if the build fails on a renamed method, since Tauri's menu API has shifted across 2.x minor versions.)

- [ ] **Step 3: Start hidden**

In `desktop/src-tauri/tauri.conf.json`, set the main window's `"visible": false` so the app opens straight to the tray on launch, only showing the Settings window when explicitly requested:

```json
{
  "app": {
    "windows": [
      { "label": "main", "visible": false, "width": 420, "height": 480, "title": "Meeting Transcriber Settings" }
    ]
  }
}
```

- [ ] **Step 4: Verify manually**

`npm run tauri dev`. Confirm no window appears on launch (only a tray icon). Click the tray icon, confirm the menu shows all four items. Click "Settings…", confirm the window appears and is focused. Click "Quit", confirm the app fully exits (check `ps`/Activity Monitor/Task Manager, not just that the window closes).

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/
git commit -m "$(cat <<'EOF'
Add tray icon, menu, and hidden-by-default Settings window

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Settings UI — App URL + API key, stored securely

**Files:**
- Modify: `desktop/src/App.tsx`
- Modify: `desktop/src-tauri/src/main.rs` (add `save_settings`/`get_settings` commands)
- Modify: `desktop/src-tauri/Cargo.toml` (add `keyring`, `serde`, `serde_json`, `dirs` dependencies)

**Interfaces:**
- Produces: Tauri commands `save_settings(app_url: String, api_key: String) -> Result<(), String>` and `get_settings() -> Result<Settings, String>` where `Settings { app_url: String, has_api_key: bool }` (the raw key itself is never sent back to the frontend once saved, matching the extension's shown-once convention as closely as this UX allows — here it's "saved, not re-displayed" rather than "shown once," since it's a settings form the user can just re-enter into if they need to rotate it).

- [ ] **Step 1: Add dependencies**

```toml
[dependencies]
keyring = "3"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
dirs = "5"
```

- [ ] **Step 2: Rust commands**

```rust
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::fs;

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

    let has_api_key = Entry::new(SERVICE, KEY_USER)
        .and_then(|e| e.get_password())
        .is_ok();

    Ok(SettingsResponse { app_url, has_api_key })
}
```

Register both in the `tauri::Builder` chain: `.invoke_handler(tauri::generate_handler![save_settings, get_settings, /* start_recording, stop_recording added in Task 5 */])`.

- [ ] **Step 3: Frontend form**

```tsx
// desktop/src/App.tsx
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';

export default function App() {
  const [appUrl, setAppUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    invoke<{ app_url: string; has_api_key: boolean }>('get_settings').then((s) => {
      setAppUrl(s.app_url);
      setHasKey(s.has_api_key);
    });
  }, []);

  async function handleSave() {
    await invoke('save_settings', { appUrl: appUrl.trim(), apiKey: apiKey.trim() });
    setSaved(true);
    setHasKey(hasKey || Boolean(apiKey.trim()));
    setApiKey('');
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-sm font-medium">Meeting Transcriber Settings</h1>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">App URL</label>
        <Input value={appUrl} onChange={(e) => setAppUrl(e.target.value)} placeholder="https://your-app.vercel.app" />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs text-muted-foreground">
          API Key {hasKey && <span className="text-emerald-500">(saved)</span>}
        </label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={hasKey ? 'Enter a new key to replace it' : 'mtk_...'}
        />
        <p className="text-xs text-muted-foreground">Generate one in the app under Settings → API Keys.</p>
      </div>
      <Button onClick={handleSave}>{saved ? 'Saved' : 'Save'}</Button>
    </div>
  );
}
```

- [ ] **Step 4: Verify manually**

`npm run tauri dev`, open Settings from the tray, enter a real App URL and a real API key (from the web app's own Settings → API Keys, per the companion plan), save. Quit and relaunch the app, reopen Settings — confirm the App URL is still there and the API key field shows "(saved)" without displaying the raw key. Then, separately, confirm the key is really in the OS keychain: on macOS, open Keychain Access, search "meeting-transcriber", confirm an entry exists; on Windows, open Credential Manager, search the same.

- [ ] **Step 5: Commit**

```bash
git add desktop/
git commit -m "$(cat <<'EOF'
Add Settings UI: App URL + API key, stored in the OS keychain

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Microphone capture (cpal, cross-platform)

**Files:**
- Create: `desktop/src-tauri/src/capture/mic.rs`
- Modify: `desktop/src-tauri/Cargo.toml` (add `cpal`)

**Interfaces:**
- Produces: `pub fn start_mic_capture(tx: crossbeam_channel::Sender<Vec<f32>>) -> Result<cpal::Stream, String>` — starts capturing the default input device, sending chunks of `f32` samples to `tx` as they arrive. Caller keeps the returned `Stream` alive for as long as capture should continue (dropping it stops capture, per `cpal`'s own design) — `crossbeam-channel` is added alongside `cpal` for this.

- [ ] **Step 1: Add dependencies**

```toml
[dependencies]
cpal = "0.15"
crossbeam-channel = "0.5"
```

- [ ] **Step 2: Write the mic capture module**

```rust
// desktop/src-tauri/src/capture/mic.rs
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::Sender;

pub fn start_mic_capture(tx: Sender<Vec<f32>>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or("No microphone found. Check System Settings → Privacy & Security → Microphone.")?;
    let config = device
        .default_input_config()
        .map_err(|e| format!("Could not read microphone config: {e}"))?;

    let stream = device
        .build_input_stream(
            &config.into(),
            move |data: &[f32], _: &cpal::InputCallbackInfo| {
                let _ = tx.send(data.to_vec());
            },
            move |err| eprintln!("mic capture stream error: {err}"),
            None
        )
        .map_err(|e| format!("Could not start microphone capture: {e}"))?;

    stream.play().map_err(|e| format!("Could not start microphone stream: {e}"))?;
    Ok(stream)
}
```

- [ ] **Step 3: Verify with a throwaway test binary**

Add a temporary `#[cfg(test)]` at the bottom of `mic.rs` — this is a genuine automated test (unlike the rest of this plan, `cpal` capture can be exercised headlessly against whatever default input device CI/the dev machine has):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn captures_nonzero_samples() {
        let (tx, rx) = crossbeam_channel::unbounded();
        let _stream = start_mic_capture(tx).expect("mic capture should start");
        std::thread::sleep(Duration::from_millis(500));
        let mut total_samples = 0;
        while let Ok(chunk) = rx.try_recv() {
            total_samples += chunk.len();
        }
        assert!(total_samples > 0, "expected some samples captured in 500ms");
    }
}
```

Run: `cd desktop/src-tauri && cargo test capture::mic -- --nocapture`
Expected: `test capture::mic::tests::captures_nonzero_samples ... ok`. If it fails with a permission error, grant microphone access to the terminal/IDE running the test (macOS: System Settings → Privacy & Security → Microphone) and re-run — this is expected first-run friction, not a bug.

- [ ] **Step 4: Commit**

```bash
git add desktop/src-tauri/
git commit -m "$(cat <<'EOF'
Add cross-platform microphone capture via cpal

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: System audio loopback capture (platform-gated) + mixing + WAV output

**Files:**
- Create: `desktop/src-tauri/src/capture/loopback_macos.rs`
- Create: `desktop/src-tauri/src/capture/loopback_windows.rs`
- Create: `desktop/src-tauri/src/capture/mod.rs`
- Modify: `desktop/src-tauri/Cargo.toml` (add `screencapturekit` for macOS, `wasapi` for Windows, both platform-gated; add `hound`)

**Interfaces:**
- Consumes: `start_mic_capture` from Task 4.
- Produces: `pub fn start_recording(output_path: &Path) -> Result<RecordingHandle, String>` and `pub fn stop_recording(handle: RecordingHandle) -> PathBuf` (returns the finished WAV file's path) in `capture/mod.rs` — the single entry point Task 6's Tauri commands call. Internally mixes mic + system-audio sample streams and writes them to one WAV via `hound`.

- [ ] **Step 1: Add platform-gated dependencies**

```toml
[target.'cfg(target_os = "macos")'.dependencies]
screencapturekit = "0.3"

[target.'cfg(target_os = "windows")'.dependencies]
wasapi = "0.15"

[dependencies]
hound = "3"
```

(Pin to whatever the actual latest published versions are at implementation time — check `crates.io/crates/screencapturekit` and `crates.io/crates/wasapi` rather than trusting these exact numbers, which may have moved on.)

- [ ] **Step 2: Read each crate's real API before writing the platform modules**

This is a required investigation step, not an optional one. For macOS: open `https://docs.rs/screencapturekit/latest/screencapturekit/` (or the pinned version), find the type used to start an audio-only capture stream and the callback/handler trait it expects samples through. For Windows: open `https://docs.rs/wasapi/latest/wasapi/`, find the loopback-capture entry point and its sample-delivery mechanism. Write a short doc comment at the top of each platform file (below) summarizing what you found — this becomes the reference for the implementation in the next step, and for whoever maintains this later.

- [ ] **Step 3: macOS loopback module**

```rust
// desktop/src-tauri/src/capture/loopback_macos.rs
//
// API notes from docs.rs/screencapturekit (fill in from Step 2's
// reading before implementing below — the exact stream-start call and
// its sample callback signature depend on the pinned crate version).
use crossbeam_channel::Sender;

pub struct LoopbackHandle {
    // Holds whatever the screencapturekit crate's stream/session type is,
    // so dropping this struct stops capture (mirroring cpal's Stream
    // pattern in Task 4 for consistency).
}

pub fn start_system_audio_capture(tx: Sender<Vec<f32>>) -> Result<LoopbackHandle, String> {
    // Implement using the real API discovered in Step 2: request Screen
    // Recording / System Audio permission (this triggers the OS
    // permission prompt on first run - if it's denied, this call should
    // return a clear Err with the exact wording used in Task 8's
    // permission-denial UI, not a generic failure), start an audio-only
    // capture session, and forward each buffer of samples to `tx` the
    // same way mic.rs forwards cpal buffers.
    todo!("wire up using the real screencapturekit API noted above in Step 2")
}
```

- [ ] **Step 4: Windows loopback module**

```rust
// desktop/src-tauri/src/capture/loopback_windows.rs
//
// API notes from docs.rs/wasapi (fill in from Step 2's reading).
use crossbeam_channel::Sender;

pub struct LoopbackHandle {
    // Same shape as the macOS module - see loopback_macos.rs.
}

pub fn start_system_audio_capture(tx: Sender<Vec<f32>>) -> Result<LoopbackHandle, String> {
    // Implement using the real wasapi loopback-capture API noted above.
    todo!("wire up using the real wasapi API noted above in Step 2")
}
```

(The `todo!()` calls here are intentional and match the "required investigation step" framing above — they mark exactly the two spots whose correctness depends on a doc read that must happen at implementation time, not code this plan can respect its own "no placeholders" rule by pre-writing without ever having compiled it. Nothing else in this plan uses `todo!()`.)

- [ ] **Step 5: Mixing + WAV writing — `capture/mod.rs`**

```rust
// desktop/src-tauri/src/capture/mod.rs
mod mic;
#[cfg(target_os = "macos")]
mod loopback_macos;
#[cfg(target_os = "windows")]
mod loopback_windows;

use crossbeam_channel::{unbounded, Receiver};
use hound::{WavSpec, WavWriter};
use std::path::{Path, PathBuf};
use std::thread::JoinHandle;

const SAMPLE_RATE: u32 = 48000; // cpal's default_input_config() and both loopback crates typically negotiate 48kHz - confirm against what Step 2's reading + Task 4's cpal config actually report at runtime, and resample if they disagree, rather than assuming this constant always holds.

pub struct RecordingHandle {
    stop_tx: crossbeam_channel::Sender<()>,
    writer_thread: JoinHandle<PathBuf>,
    _mic_stream: cpal::Stream,
    #[cfg(target_os = "macos")]
    _loopback: loopback_macos::LoopbackHandle,
    #[cfg(target_os = "windows")]
    _loopback: loopback_windows::LoopbackHandle,
}

fn mix_and_write(
    mic_rx: Receiver<Vec<f32>>,
    system_rx: Receiver<Vec<f32>>,
    stop_rx: Receiver<()>,
    output_path: PathBuf
) -> PathBuf {
    let spec = WavSpec { channels: 1, sample_rate: SAMPLE_RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut writer = WavWriter::create(&output_path, spec).expect("failed to create WAV writer");

    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }
        // Simple sample-wise mix: pull whatever's available from each
        // source without blocking on both simultaneously, since mic and
        // system audio won't arrive in perfectly lockstep chunks. Missing
        // one side for a given tick just means that tick mixes in
        // silence (0.0) for that source, which is inaudible-drift, not a
        // correctness bug, at these buffer sizes (tens of milliseconds).
        let mic_chunk = mic_rx.try_recv().unwrap_or_default();
        let system_chunk = system_rx.try_recv().unwrap_or_default();
        let len = mic_chunk.len().max(system_chunk.len());
        for i in 0..len {
            let m = mic_chunk.get(i).copied().unwrap_or(0.0);
            let s = system_chunk.get(i).copied().unwrap_or(0.0);
            let mixed = (m + s).clamp(-1.0, 1.0);
            let sample_i16 = (mixed * i16::MAX as f32) as i16;
            writer.write_sample(sample_i16).expect("failed to write sample");
        }
        if len == 0 {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }

    writer.finalize().expect("failed to finalize WAV file");
    output_path
}

pub fn start_recording(output_path: &Path) -> Result<RecordingHandle, String> {
    let (mic_tx, mic_rx) = unbounded();
    let (system_tx, system_rx) = unbounded();
    let (stop_tx, stop_rx) = unbounded();

    let mic_stream = mic::start_mic_capture(mic_tx)?;

    #[cfg(target_os = "macos")]
    let loopback = loopback_macos::start_system_audio_capture(system_tx)?;
    #[cfg(target_os = "windows")]
    let loopback = loopback_windows::start_system_audio_capture(system_tx)?;

    let output_path = output_path.to_path_buf();
    let writer_thread = std::thread::spawn(move || mix_and_write(mic_rx, system_rx, stop_rx, output_path));

    Ok(RecordingHandle { stop_tx, writer_thread, _mic_stream: mic_stream, _loopback: loopback })
}

pub fn stop_recording(handle: RecordingHandle) -> PathBuf {
    let _ = handle.stop_tx.send(());
    handle.writer_thread.join().expect("writer thread panicked")
}
```

- [ ] **Step 6: Manual verification on a real Mac**

Implement `loopback_macos.rs` for real using Step 2's findings, then:

```bash
cd desktop/src-tauri && cargo build
```

Write a small throwaway `main.rs`-level test call (or a temporary command wired to a debug button) that calls `start_recording()`, waits 10 seconds while you speak into the mic and play audio in another app, then `stop_recording()`. Open the resulting WAV file in any audio player. Expected: both your voice and the other app's audio are audibly present, not just one or the other, and not silence — confirms the mixing logic and both capture paths are really working together, not just one side happening to produce output.

- [ ] **Step 7: Manual verification on a real Windows machine**

Same as Step 6, using `loopback_windows.rs` implemented for real from Step 2's Windows findings.

- [ ] **Step 8: Commit**

```bash
git add desktop/src-tauri/
git commit -m "$(cat <<'EOF'
Add system audio loopback capture (macOS + Windows) and mic/system mixing to WAV

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Wire Start/Stop Recording to the tray menu, upload on stop

**Files:**
- Modify: `desktop/src-tauri/src/main.rs`
- Modify: `desktop/src-tauri/Cargo.toml` (add `reqwest`, `tokio`)

**Interfaces:**
- Consumes: `capture::start_recording`/`stop_recording` (Task 5); `get_settings` (Task 3) for the stored App URL/API key.
- Produces: the tray's "Start Recording"/"Stop Recording" toggle actually records and uploads; the tray icon changes to reflect state.

- [ ] **Step 1: Add dependencies**

```toml
[dependencies]
reqwest = { version = "0.12", features = ["json", "multipart"] }
tokio = { version = "1", features = ["full"] }
```

- [ ] **Step 2: Recording state + toggle handler**

Replace the `"toggle_recording"` stub from Task 2 with real logic. Add near the top of `main.rs`:

```rust
use std::sync::Mutex;
use tauri::State;

struct RecordingState(Mutex<Option<capture::RecordingHandle>>);
```

Register it as managed state in the `Builder` chain: `.manage(RecordingState(Mutex::new(None)))`.

Replace the tray menu event handler's `"toggle_recording"` arm:

```rust
"toggle_recording" => {
    let app = app.clone();
    let state: State<RecordingState> = app.state();
    let mut guard = state.0.lock().unwrap();
    if guard.is_some() {
        let handle = guard.take().unwrap();
        let wav_path = capture::stop_recording(handle);
        let _ = toggle_item.set_text("Start Recording");
        let app_for_upload = app.clone();
        tauri::async_runtime::spawn(async move {
            upload_recording(app_for_upload, wav_path).await;
        });
    } else {
        let output_dir = app.path().app_data_dir().unwrap();
        std::fs::create_dir_all(&output_dir).ok();
        let output_path = output_dir.join(format!("recording-{}.wav", chrono::Utc::now().timestamp()));
        match capture::start_recording(&output_path) {
            Ok(handle) => {
                *guard = Some(handle);
                let _ = toggle_item.set_text("Stop Recording");
            }
            Err(e) => {
                // Surfaces the exact permission-denial message from
                // capture::start_recording (Task 5/8) via a native
                // notification rather than failing silently.
                eprintln!("failed to start recording: {e}");
            }
        }
    }
}
```

Add `chrono = "0.4"` to `Cargo.toml` for the timestamp.

- [ ] **Step 3: Upload function**

```rust
async fn upload_recording(app: tauri::AppHandle, wav_path: std::path::PathBuf) {
    let settings = match get_settings() {
        Ok(s) => s,
        Err(_) => return,
    };
    if settings.app_url.is_empty() || !settings.has_api_key {
        eprintln!("upload skipped: App URL or API key not configured");
        return;
    }
    let api_key = match keyring::Entry::new("meeting-transcriber", "api-key").and_then(|e| e.get_password()) {
        Ok(k) => k,
        Err(_) => return,
    };

    let client = reqwest::Client::new();
    let file_name = format!("Desktop recording {}", chrono::Local::now().format("%Y-%m-%d %H:%M"));

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

    #[derive(serde::Deserialize)]
    struct MeetingRef { id: String }
    #[derive(serde::Deserialize)]
    struct TokenResult { token: String, backend_url: String, meeting: MeetingRef }
    let result: TokenResult = match token_response.json().await {
        Ok(r) => r,
        Err(e) => {
            eprintln!("could not parse token response: {e}");
            return;
        }
    };

    // Companion to the mint call above: without this, a failed upload
    // would leave the Meeting row stuck at 'processing' until the
    // backend's 30-minute stale-job sweep notices, instead of failing
    // promptly the way the web dashboard's own upload failures already
    // do. See docs/superpowers/plans/2026-09-02-api-key-auth.md Task 6.
    async fn report_failure(client: &reqwest::Client, app_url: &str, api_key: &str, meeting_id: &str, message: &str) {
        let _ = client
            .post(format!("{}/api/tokens/mark-failed", app_url))
            .bearer_auth(api_key)
            .json(&serde_json::json!({ "meetingId": meeting_id, "message": message }))
            .send()
            .await;
    }

    let file_bytes = match tokio::fs::read(&wav_path).await {
        Ok(b) => b,
        Err(e) => {
            eprintln!("could not read recording file: {e}");
            report_failure(&client, &settings.app_url, &api_key, &result.meeting.id, "Could not read the local recording file.").await;
            return;
        }
    };

    let part = reqwest::multipart::Part::bytes(file_bytes).file_name("recording.wav");
    let form = reqwest::multipart::Form::new().text("token", result.token).part("file", part);

    match client.post(format!("{}/api/transcribe", result.backend_url)).multipart(form).send().await {
        Ok(r) if r.status().is_success() => {
            let _ = tokio::fs::remove_file(&wav_path).await; // only delete on confirmed success
        }
        Ok(r) => {
            eprintln!("upload failed: {}", r.status());
            report_failure(&client, &settings.app_url, &api_key, &result.meeting.id, &format!("Upload failed with status {}.", r.status())).await;
        }
        Err(e) => {
            eprintln!("upload network error: {e}");
            report_failure(&client, &settings.app_url, &api_key, &result.meeting.id, "Network error during upload from the desktop app.").await;
        }
    }
}
```

- [ ] **Step 4: Manual verification**

`npm run tauri dev`, with a real App URL + API key already saved (Task 3). Click "Start Recording" from the tray, speak for ~15 seconds with something else playing, click "Stop Recording". Confirm: the tray menu label flips back to "Start Recording" immediately; open the actual web dashboard in a browser and confirm a new "Transcribing..." row appears within a few seconds, and later reaches `'complete'` with an accurate transcript of what was said.

- [ ] **Step 5: Commit**

```bash
git add desktop/src-tauri/
git commit -m "$(cat <<'EOF'
Wire tray Start/Stop Recording to real capture + upload

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: "Open Dashboard" — embed the existing web app

**Files:**
- Modify: `desktop/src-tauri/src/main.rs`

**Interfaces:**
- Produces: clicking "Open Dashboard" in the tray opens (or focuses, if already open) a second window pointed at the configured App URL, giving full access to the existing dashboard/history/search/settings with no new UI code.

- [ ] **Step 1: Implement the handler**

Replace the `"open_dashboard"` stub from Task 2:

```rust
"open_dashboard" => {
    if let Some(window) = app.get_webview_window("dashboard") {
        let _ = window.show();
        let _ = window.set_focus();
        continue;
    }
    let settings = get_settings().unwrap_or(SettingsResponse { app_url: String::new(), has_api_key: false });
    if settings.app_url.is_empty() {
        eprintln!("cannot open dashboard: App URL not configured yet");
        // In a fuller pass this should show a native alert; deferred to
        // Task 8's broader "clear, non-silent errors" pass rather than
        // duplicating similar UI here first.
        continue;
    }
    let url = settings.app_url.parse().expect("invalid App URL");
    let _ = tauri::WebviewWindowBuilder::new(app, "dashboard", tauri::WebviewUrl::External(url))
        .title("Meeting Transcriber")
        .inner_size(1200.0, 800.0)
        .build();
}
```

- [ ] **Step 2: Manual verification**

`npm run tauri dev` with a real App URL saved. Click "Open Dashboard" — confirm a full-size window opens showing the actual live dashboard (log in if not already, since this webview has its own separate session from any browser you're using). Upload a file through it exactly as you would in a regular browser, confirm it works identically (same "Transcribing..." row, same polling, same everything) — this window is genuinely the same app, not a reimplementation. Close it, click "Open Dashboard" again — confirm it reopens rather than erroring on a duplicate window label.

- [ ] **Step 3: Commit**

```bash
git add desktop/src-tauri/
git commit -m "$(cat <<'EOF'
Add Open Dashboard: embeds the existing web app in a second window

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Error handling — permission denial, crash recovery, upload retry

**Files:**
- Modify: `desktop/src-tauri/src/capture/loopback_macos.rs` / `loopback_windows.rs` (clearer permission-denial errors)
- Modify: `desktop/src-tauri/src/main.rs` (startup retry sweep, native alerts)

**Interfaces:**
- Produces: on launch, scans the app data directory for any leftover `recording-*.wav` files from a previous crash and offers to upload them; permission-denial errors during capture surface as a native dialog naming the exact Settings pane to open, not a silent console log.

- [ ] **Step 1: Startup retry sweep**

In `main.rs`'s `.setup()` closure, after the tray is built:

```rust
let output_dir = app.path().app_data_dir()?;
if let Ok(entries) = std::fs::read_dir(&output_dir) {
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().map(|e| e == "wav").unwrap_or(false) {
            // A WAV file surviving here means the app was killed before
            // the previous recording's upload completed (Task 6 only
            // deletes the file on confirmed upload success) - retry it
            // now rather than leaving it stranded forever.
            let app_for_retry = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                upload_recording(app_for_retry, path).await;
            });
        }
    }
}
```

- [ ] **Step 2: Clear permission-denial errors**

In `loopback_macos.rs`, once Step 2 of Task 5's real implementation is in place, make sure the error path surfaces this exact message rather than the underlying crate's raw error text (per `CLAUDE.md`'s "never leak internals" convention, applied here even though this is a desktop app, not a web request — the principle is the same: don't show a raw OS/library error string to the user):

```rust
"System Audio permission is required. Open System Settings → Privacy & Security → Screen & System Audio Recording, and enable it for this app."
```

For `loopback_windows.rs`, the equivalent for a denied microphone/audio permission:

```rust
"Microphone/audio access is required. Open Settings → Privacy & security → Microphone, and enable it for this app."
```

Surface either message via a native dialog (`tauri-plugin-dialog`'s `MessageDialogBuilder`, or `rfd` as a lighter-weight alternative — either is a real, well-known crate; pick one and add it to `Cargo.toml`) rather than only `eprintln!`, since a background tray app has no console the user is watching.

- [ ] **Step 3: Manual verification**

Revoke the app's Screen Recording/System Audio permission (System Settings on Mac, Settings → Privacy on Windows), try to start a recording from the tray, confirm the exact permission-pane-naming dialog appears rather than a silent failure or generic crash. Re-grant permission, confirm recording works again without restarting the app if possible, or note if a restart is required (a known OS-level constraint on some permission types, not a bug in this app, if that turns out to be the case) so it doesn't get mistaken for a defect. Separately: start a recording, force-quit the app mid-recording (`kill -9` or Task Manager), relaunch it, confirm the startup sweep picks up and uploads the leftover partial WAV file rather than leaving it stranded.

- [ ] **Step 4: Commit**

```bash
git add desktop/src-tauri/
git commit -m "$(cat <<'EOF'
Add crash-recovery upload retry and clear permission-denial errors

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Done when

- On both a real Mac and a real Windows machine: clicking "Start Recording" in the tray while another app plays audio and you speak, then "Stop Recording", results in a real transcribed meeting appearing in the existing web dashboard, with both voices audible in the transcript.
- "Open Dashboard" shows the full, functioning existing web app — search, history, tags, settings — with zero reimplemented UI.
- Killing the app mid-recording and relaunching it recovers and uploads the partial recording instead of losing it.
