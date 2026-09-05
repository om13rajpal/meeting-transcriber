// Builds the Chrome extension from source and zips its output into
// public/downloads/, so `npm run build`'s /downloads/meeting-transcriber-extension.zip
// static file is always fresh - built from the exact commit being deployed,
// not a stale artifact someone forgot to re-zip by hand. Run from the root
// `build` script (see package.json), before `next build`, so the zip
// already exists in public/ by the time Next generates its static output.
//
// Deliberately never throws past this file's own console.error - a broken
// extension build must not take the whole website deploy down with it (see
// package.json's `build` script, which runs this with `; next build` so
// next build always runs regardless of this script's exit code).
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

const ROOT = path.join(__dirname, '..');
const EXTENSION_DIR = path.join(ROOT, 'extension');
const EXTENSION_OUTPUT_DIR = path.join(EXTENSION_DIR, '.output', 'chrome-mv3');
const DOWNLOADS_DIR = path.join(ROOT, 'public', 'downloads');
const ZIP_PATH = path.join(DOWNLOADS_DIR, 'meeting-transcriber-extension.zip');

function run(command, cwd) {
  execSync(command, { cwd, stdio: 'inherit' });
}

try {
  console.log('[build-extension-zip] Installing extension dependencies...');
  // --ignore-scripts: the extension's own postinstall (`wxt prepare`)
  // generates TypeScript types for editor/tsc support only - `wxt build`
  // doesn't need it (verified locally: a build from a --ignore-scripts
  // install produces an identical .output). Skipping it sidesteps a real
  // failure seen on Vercel's build sandbox, where that hook exited 127
  // ("command not found") even though the exact same install works fine
  // locally - rather than chase that environment mismatch, this avoids
  // depending on a step this build never actually needed.
  run('npm install --ignore-scripts', EXTENSION_DIR);

  console.log('[build-extension-zip] Building extension...');
  run('npm run build', EXTENSION_DIR);

  if (!fs.existsSync(EXTENSION_OUTPUT_DIR)) {
    throw new Error(`Expected extension build output at ${EXTENSION_OUTPUT_DIR}, but it doesn't exist.`);
  }

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
  const zip = new AdmZip();
  // Excludes exFAT AppleDouble sidecar files (`._*`) - this repo lives on
  // an exFAT external volume (see CLAUDE.md's "This repo lives on an
  // exFAT external volume" section), which litters real build output
  // directories with these shadow files. Without this filter they'd ship
  // in the public download, doubling the file count with junk nobody
  // asked for.
  zip.addLocalFolder(EXTENSION_OUTPUT_DIR, '', (entryPath) => !path.basename(entryPath).startsWith('._'));
  zip.writeZip(ZIP_PATH);

  console.log(`[build-extension-zip] Wrote ${ZIP_PATH}`);
} catch (error) {
  console.error('[build-extension-zip] Failed to build the extension zip - the website build will continue without an updated download.');
  console.error(error);
}
