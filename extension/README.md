# Meeting Transcriber Capture (Chrome extension)

A companion Chrome extension (WXT + React + Tailwind v4) for the Meeting
Transcriber app (see the repo root `CLAUDE.md`). Join a Google Meet or
Teams-web call in Chrome, click **Start recording** in the extension's side
panel, and it captures that tab's audio mixed with your microphone, then
uploads the finished recording straight into the existing transcription
pipeline. Nothing about transcription lives here: it mints an upload token from
the web app with an API key, then uploads to the same backend the web
dashboard already uploads to, so the meeting shows up in your dashboard exactly
as a manually-uploaded file would.

`components/ui/` and `lib/utils.js` are copies of the frontend's shadcn/ui
(Base UI) components, kept in sync by hand rather than shared as a package -
see `docs/superpowers/plans/2026-09-02-chrome-extension-capture.md` at the
repo root for why.

## Build and load

```bash
npm install
npm run build   # produces .output/chrome-mv3/
```

Then in Chrome: open `chrome://extensions`, turn on **Developer mode**, click
**Load unpacked**, and select `extension/.output/chrome-mv3/`.

(`npm run dev` also works and opens its own Chrome instance with the extension
loaded and hot-reloading, which is the nicer loop while changing code.)

## First-run setup

1. In the main web app, go to **Settings → API Keys** and generate a key
   (`mtk_...`). Copy it - it's only shown once.
2. Click the extension's toolbar icon to open its side panel, then click
   **Settings**.
3. Enter your **App URL** (the deployed frontend, e.g.
   `https://your-app.vercel.app`) and paste the **API key**, then click
   **Save**. That one click also does the two permission grants the extension
   can't ask for later:
   - Chrome asks for network access to sites over HTTPS. This is what lets the
     recording reach your app and its backend at all; declining it means
     uploads fail. It's requested broadly because the backend's URL isn't
     known until the app returns it at upload time, and there is no user
     gesture available mid-recording to prompt for a second, narrower grant.
   - Chrome asks for **microphone** access. This has to happen here, from the
     visible side panel: the actual recording runs in an offscreen document,
     which has no UI and cannot show a permission prompt of its own. Granting
     once here is what makes the offscreen document's later capture work.
4. Add the extension's own origin to the **backend's** `ALLOWED_ORIGINS`. The
   host-permission grant above only makes the *extension's* fetch calls
   cross-origin-capable; `backend/server.js`'s `cors()` allowlist is a
   separate, additional gate. Find the extension's id on `chrome://extensions`
   and add `chrome-extension://<extension-id>` to the backend's
   `ALLOWED_ORIGINS` env var (comma-separated), then redeploy/restart the
   backend. Without this the upload is rejected by CORS even with everything
   else configured correctly.

## Recording

Open the meeting tab, then **click the extension's toolbar icon while that tab
is the active tab**. This isn't only about opening the side panel: it's the
invocation that grants `activeTab` for that tab, and `chrome.tabCapture` can't
capture a tab without it. The grant is revoked on navigation, so if a start
attempt fails with an `activeTab`-shaped error, click the icon again from the
meeting tab and retry.

The side panel shows whether a call is detected, a Start/Stop button, and the
upload status once you stop. Closing the meeting tab mid-recording stops the
recorder and still uploads what was captured, flagged in the panel as
interrupted.

## Known constraint

This extension was built and reviewed without ever being loaded into a real
browser - unpacked-extension loading was blocked in the development
environment, so every MV3 runtime behaviour here (tabCapture, offscreen
documents, permission prompts, service-worker eviction) is reasoned about from
the platform's documented semantics rather than observed. It type-checks and
builds cleanly, but smoke-test the full flow for real (record a short call, see
the transcript land in the dashboard) before relying on it.
