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
  },
});
