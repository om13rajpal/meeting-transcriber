# Meeting Transcriber

A private, self-hosted app for transcribing meeting recordings that mix Hindi and English (Hinglish). Upload an MP4 or MP3, and it extracts the audio if needed, transcribes it with Deepgram, and keeps a private, searchable history of every meeting per user.

The app is two separately deployed services:

- **Frontend**: a Next.js app (this repository's root) for auth, the dashboard, meeting history, search, and share links. Meant to run on Vercel.
- **Backend** (`backend/`): a small Express service that handles file uploads, audio extraction with ffmpeg, and the Deepgram call. It exists as a separate service because Vercel's serverless functions cap request bodies at about 4.5MB, which a meeting recording will almost always exceed, and because ffmpeg needs a real filesystem and isn't available in that runtime. Meant to run on Render (or any host that supports a long-running Docker container).

The browser uploads the recording directly to the backend, authorized by a short-lived, single-use token minted by the frontend, so the file itself never passes through Vercel.

## Features

- Email and password authentication with sessions stored in MongoDB
- Upload an MP4 or MP3; video files have their audio automatically extracted with ffmpeg
- Transcription via Deepgram's Nova 3 model with `language=multi` for accurate Hindi/English code switching
- Deepgram requests opt out of their model improvement program (`mip_opt_out`), so recordings are not used for training
- Per user meeting history with a dashboard and full text search across titles and transcripts
- Editable meeting titles and per speaker renaming, both saved to the database
- Speaker diarized transcript view alongside a plain text view
- Export a transcript as `.txt`, `.srt`, or `.vtt`
- Shareable, read only links for individual meetings that can be revoked at any time

## Tech stack

- Next.js 16 (App Router) and React 19, plain JavaScript, no build config beyond what Next.js provides
- Server Components for data reads and Server Actions for mutations; no separate API layer on the frontend
- A standalone Express backend for the one thing that needs a real server: file upload plus ffmpeg plus Deepgram
- MongoDB with Mongoose, shared by both services
- shadcn/ui (built on Base UI) and Tailwind CSS v4 for the interface
- Deepgram for speech to text
- ffmpeg and ffprobe for audio extraction and normalization

## Requirements

- Node.js 18 or later
- MongoDB running locally or a connection string to a hosted instance (for example MongoDB Atlas)
- ffmpeg and ffprobe available on your PATH (only needed to run the backend locally; production uses the Dockerfile, which installs them)
- A Deepgram API key
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
- `MONGODB_URI`: same database the frontend uses, for example `mongodb://127.0.0.1:27017/meeting-transcriber`
- `PORT`: defaults to `10000`
- `ALLOWED_ORIGINS`: comma-separated origins allowed to call this backend directly from a browser, for example `http://localhost:3000`

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

```
npm run dev
```

Open `http://localhost:3000`, sign up, and upload a recording.

## Deployment

- **Frontend on Vercel**: deploy the repository root as a standard Next.js project. Set `MONGODB_URI` and `NEXT_PUBLIC_TRANSCRIBE_BACKEND_URL` (the backend's public URL) as environment variables.
- **Backend on Render**: create a Docker-based web service pointed at the `backend/` directory (Render's "Root Directory" setting). Set `DEEPGRAM_API_KEY`, `MONGODB_URI`, and `ALLOWED_ORIGINS` (the frontend's public URL) as environment variables. Render builds and runs `backend/Dockerfile`, which installs ffmpeg.

## Project structure

```
app/
  actions/            Server Actions: auth.js, meetings.js, transcribe.js (token minting), search.js
  lib/                 db.js, session.js, dal.js, meetings.js, models/
  login/, signup/      Public auth pages
  meeting/[id]/         Meeting detail page (protected)
  share/[token]/        Public, read only shared meeting view
  page.js, Dashboard.js Dashboard (protected); uploads directly to the backend
components/ui/         shadcn UI primitives

backend/
  server.js             Express app: health check and POST /api/transcribe
  services/deepgram.js   ffmpeg extraction + Deepgram call with retry
  models/                Meeting.js and UploadToken.js, kept schema-identical to the frontend's copies
  Dockerfile              Installs ffmpeg, runs the service
```

## Security notes

- Passwords are hashed with bcrypt
- Sessions are a random token stored in MongoDB, referenced by an httpOnly cookie; the cookie itself carries no data
- Every meeting lookup is scoped to the signed in user, and requests for another user's meeting return a generic not found response
- Uploads are authorized by a random, single-use token that expires after 15 minutes; the backend's CORS policy only allows the configured frontend origin
- Share links use a long random token and can be revoked at any time
