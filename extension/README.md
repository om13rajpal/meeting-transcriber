# Meeting Transcriber Capture (Chrome extension)

A companion Chrome extension (WXT + React + Tailwind v4) that captures Google
Meet/Teams tab audio + mic and uploads it into the Meeting Transcriber
pipeline (see the repo root `CLAUDE.md`). Capture/upload logic isn't built
yet - this is currently just the scaffold: a side panel entrypoint proving
the Tailwind v4 + shadcn/ui pipeline renders correctly.

`components/ui/` and `lib/utils.js` are copies of the frontend's shadcn/ui
(Base UI) components, kept in sync by hand rather than shared as a package -
see `docs/superpowers/plans/2026-09-02-chrome-extension-capture.md` at the
repo root for why.

```bash
npm install
npm run dev     # opens Chrome with the extension loaded unpacked
npm run build   # produces .output/chrome-mv3/
```
