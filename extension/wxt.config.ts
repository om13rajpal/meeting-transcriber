import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'Meeting Transcriber Capture',
    permissions: ['tabCapture', 'offscreen', 'storage', 'sidePanel', 'activeTab'],
    host_permissions: ['https://meet.google.com/*', 'https://teams.microsoft.com/*'],
    // `action` is load-bearing, not just a toolbar icon: `activeTab` is only
    // ever granted by the user *invoking* the extension, and an action click
    // is the invocation this extension has (it also opens the side panel, via
    // sidePanel.setPanelBehavior({ openPanelOnActionClick: true }) in
    // background.ts). Without an `action` key there is no invocation path at
    // all, so `activeTab` is never granted and
    // chrome.tabCapture.getMediaStreamId({ targetTabId }) always throws. The
    // grant is scoped to whichever tab was active when the icon was clicked
    // and is revoked on navigation, so the user must click the toolbar icon
    // while the Meet/Teams tab is the active tab for capture to be permitted
    // on it.
    action: {},
    // The app URL (for minting an upload token) and the backend URL it
    // returns (for the actual file upload) are user-configured on a
    // self-hosted deployment - there is no fixed domain to put in
    // `host_permissions`. Declaring the broad pattern as *optional* means
    // Chrome shows no scary install-time prompt; the extension asks for it at
    // runtime from the Settings save click (see Settings.tsx), where a real
    // user gesture is available.
    optional_host_permissions: ['https://*/*'],
  },
});
