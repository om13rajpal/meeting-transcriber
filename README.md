# Meeting Transcriber

A private, self-hosted app for transcribing meeting recordings that mix Hindi and English (Hinglish). Upload an MP4 or MP3, and it extracts the audio if needed, transcribes it with Deepgram, and keeps a private, searchable history of every meeting per user.

The app is two separately deployed services:

- **Frontend**: a Next.js app (this repository's root) for auth, the dashboard, meeting history, search, and share links. Meant to run on Vercel.
- **Backend** (`backend/`): a small Express service that handles file uploads, audio extraction with ffmpeg, and the Deepgram call. It exists as a separate service because Vercel's serverless functions cap request bodies at about 4.5MB, which a meeting recording will almost always exceed, and because ffmpeg needs a real filesystem and isn't available in that runtime. Meant to run on Render (or any host that supports a long-running Docker container).

The browser uploads the recording directly to the backend, authorized by a short-lived, single-use token minted by the frontend, so the file itself never passes through Vercel. The backend responds as soon as the job is recorded in MongoDB and keeps transcribing in the background; the dashboard and meeting page show a "Transcribing..." state and poll until it finishes, so a page reload or a dropped connection during transcription never loses the job.

## Features

- Email and password authentication with sessions stored in MongoDB, plus optional Google sign-in
- Forgot password, with a single-use emailed reset link that also signs every other device out
- Upload multiple MP4s or MP3s at once, each uploading and transcribing independently with its own progress, cancel, and retry
- Transcription via Deepgram's Nova 3 model with `language=multi` for accurate Hindi/English code switching
- Per meeting cost tracking: the model used and what it cost, shown right away as an estimate and automatically upgraded to Deepgram's actual billed amount once available, plus a "this month" total on the dashboard
- Simple tags on each meeting (add/remove from the meeting page), searchable from the same dashboard search box as titles and transcripts
- Deepgram requests opt out of their model improvement program (`mip_opt_out`), so recordings are not used for training
- Per user meeting history with a dashboard and full text search across titles, transcripts, and tags, with the matching snippet highlighted in the results and a jump straight to that line on the meeting page
- Bulk select meetings on the dashboard to delete or tag several at once
- Editable meeting titles and per speaker renaming, both saved to the database
- Speaker diarized transcript view alongside a plain text view
- Merge speakers that diarization split apart (or that were otherwise miscounted) into one
- Export a transcript as `.txt`, `.srt`, or `.vtt`
- Shareable, read only links for individual meetings that can be revoked at any time
- Email notification (via Resend) the moment a meeting finishes transcribing or fails, so you don't have to keep a tab open watching for it
- Optional webhooks (as many as you like): send a meeting's transcript to Discord, Slack, Microsoft Teams, or your own URL (n8n, Zapier, a custom agent) as raw JSON, the moment it finishes or fails
- Per-notification delivery status (email and every webhook) shown on the meeting page, with a one-click Resend if any of them failed
- Speaker rename autocomplete, suggesting names you've used in past meetings

## Tech stack

- Next.js 16 (App Router) and React 19, plain JavaScript, no build config beyond what Next.js provides
- Server Components for data reads and Server Actions for mutations; no separate API layer on the frontend
- A standalone Express backend for the one thing that needs a real server: file upload plus ffmpeg plus Deepgram
- MongoDB with Mongoose, shared by both services
- shadcn/ui (built on Base UI) and Tailwind CSS v4 for the interface
- Deepgram for speech to text
- ffmpeg and ffprobe for audio extraction and normalization
- Resend for outbound email notifications

## Requirements

- Node.js 18 or later
- MongoDB running locally or a connection string to a hosted instance (for example MongoDB Atlas)
- ffmpeg and ffprobe available on your PATH (only needed to run the backend locally; production uses the Dockerfile, which installs them)
- A Deepgram API key
- A Resend API key and a verified sending domain (optional - email notifications are skipped quietly if `RESEND_API_KEY` isn't set)
- A Google Cloud Console OAuth client (optional - the "Continue with Google" button simply doesn't render until `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set)
- Docker, if you want to build the backend's production image locally

## Local setup

You need both services running to actually transcribe something; the frontend alone can sign up, log in, and browse an (empty) dashboard.

### Backend

```
cd backend
npm install
cp .env.example .env
```

Fill in `.env`:

- `DEEPGRAM_API_KEY`: your Deepgram API key
- `DEEPGRAM_PROJECT_ID`: optional, from the Deepgram console - lets the backend fetch each meeting's actual billed cost instead of only an estimate
- `DEEPGRAM_RATE_PER_MINUTE_USD`: optional, the per-minute rate used for the estimated cost shown immediately after a meeting finishes; defaults to `0.0071`
- `MONGODB_URI`: same database the frontend uses, for example `mongodb://127.0.0.1:27017/meeting-transcriber`
- `PORT`: defaults to `10000`
- `ALLOWED_ORIGINS`: comma-separated origins allowed to call this backend directly from a browser, for example `http://localhost:3000`
- `RESEND_API_KEY`, `EMAIL_FROM`, `FRONTEND_URL`: optional, for the completion/failure notification email; leave `RESEND_API_KEY` blank to skip it entirely

```
npm start
```

### Frontend

From the repository root:

```
npm install
cp .env.example .env
```

Fill in `.env`:

- `MONGODB_URI`: the same connection string as the backend
- `NEXT_PUBLIC_TRANSCRIBE_BACKEND_URL`: where the backend is running, for example `http://localhost:10000`
- `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL`: optional, for the notification email sent when an upload fails before ever reaching the backend, and for password reset emails; leave `RESEND_API_KEY` blank to skip email entirely
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: optional, for "Continue with Google". Create an OAuth client (Web application) in Google Cloud Console, with `${APP_URL}/api/auth/google/callback` as an authorized redirect URI; leave both blank to leave the button off

```
npm run dev
```

Open `http://localhost:3000`, sign up, and upload a recording.

## Deployment

- **Frontend on Vercel**: deploy the repository root as a standard Next.js project. Set `MONGODB_URI`, `NEXT_PUBLIC_TRANSCRIBE_BACKEND_URL` (the backend's public URL), and optionally `RESEND_API_KEY`, `EMAIL_FROM`, `APP_URL` (this app's own public URL), `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` as environment variables.
- **Backend on Render**: create a Docker-based web service pointed at the `backend/` directory (Render's "Root Directory" setting). Set `DEEPGRAM_API_KEY`, `MONGODB_URI`, `ALLOWED_ORIGINS` (the frontend's public URL), and optionally `RESEND_API_KEY`, `EMAIL_FROM`, `FRONTEND_URL` (this app's own public URL), `DEEPGRAM_PROJECT_ID`, `DEEPGRAM_RATE_PER_MINUTE_USD` as environment variables. Render builds and runs `backend/Dockerfile`, which installs ffmpeg.

## Project structure

```
app/
  actions/            Server Actions: auth.js (incl. password reset), meetings.js (rename, merge speakers, share links, delete), settings.js (webhooks), transcribe.js (token minting), search.js
  api/auth/google/      The only Route Handlers in the app: OAuth redirect + callback
  lib/                 db.js, session.js, dal.js, meetings.js, email.js, webhook.js, oauth.js, models/
  login/, signup/, forgot-password/, reset-password/[token]/  Public auth pages
  meeting/[id]/         Meeting detail page (protected)
  share/[token]/        Public, read only shared meeting view
  page.js, Dashboard.js Dashboard (protected); uploads directly to the backend, webhooks settings dialog
  OAuthButtons.js       "Continue with Google" button, shown when configured
components/ui/         shadcn UI primitives

backend/
  server.js             Express app: health check and POST /api/transcribe
  services/deepgram.js   ffmpeg extraction + Deepgram call with retry
  services/email.js      Completion/failure notification email via Resend
  services/webhook.js    Completion/failure notification webhooks (generic JSON, Discord, Slack, Teams)
  models/                Meeting.js and UploadToken.js, kept schema-identical to the frontend's copies
  Dockerfile              Installs ffmpeg, runs the service
```

## Security notes

- Passwords are hashed with bcrypt
- Sessions are a random token stored in MongoDB, referenced by an httpOnly cookie; the cookie itself carries no data
- Every meeting lookup is scoped to the signed in user, and requests for another user's meeting return a generic not found response
- Uploads are authorized by a random, single-use token that expires after 15 minutes; the backend's CORS policy only allows the configured frontend origin
- Share links use a long random token and can be revoked at any time
- Password reset links are single-use, expire after an hour, and never reveal whether an email is registered; completing a reset signs out every other active session
- Webhook URLs are checked against localhost, private/link-local IPs, and non-http(s) schemes before being saved (a basic deterrent appropriate for a single-user app, not a hardened SSRF defense)
- Discord/Slack/Teams webhook formats are picked explicitly per URL, not auto-detected from the URL itself, since a Teams Workflows webhook URL isn't distinguishable from any other Power Automate flow
- Google sign-in only accepts an email Google itself marked verified, and links to an existing account by that email rather than trusting any client-supplied identifier; the OAuth flow is CSRF-protected with a random `state` value in a short-lived httpOnly cookie
