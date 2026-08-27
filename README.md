# Meeting Transcriber

A private, self-hosted Next.js app for transcribing meeting recordings that mix Hindi and English (Hinglish). Upload an MP4 or MP3, and it extracts the audio if needed, transcribes it with Deepgram, and keeps a private, searchable history of every meeting per user.

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
- Server Components for data reads and Server Actions for every mutation; no separate API layer
- MongoDB with Mongoose for users, meetings, and sessions
- shadcn/ui (built on Base UI) and Tailwind CSS v4 for the interface
- Deepgram for speech to text
- ffmpeg and ffprobe for audio extraction and normalization

## Requirements

- Node.js 18 or later
- MongoDB running locally or a connection string to a hosted instance
- ffmpeg and ffprobe available on your PATH
- A Deepgram API key

## Setup

1. Install dependencies:

   ```
   npm install
   ```

2. Copy the example environment file and fill in the values:

   ```
   cp .env.example .env
   ```

   Required variables:

   - `DEEPGRAM_API_KEY`: your Deepgram API key
   - `MONGODB_URI`: MongoDB connection string, for example `mongodb://127.0.0.1:27017/meeting-transcriber`

3. Start MongoDB if it is not already running.

4. Start the app:

   ```
   npm run dev
   ```

5. Open `http://localhost:3000` in your browser, sign up, and upload a recording.

To build and run a production instance:

```
npm run build
npm start
```

## Project structure

```
app/
  actions/            Server Actions: auth.js, meetings.js, transcribe.js, search.js
  lib/                 db.js, session.js, dal.js, meetings.js, deepgram.js, models/
  login/, signup/      Public auth pages
  meeting/[id]/         Meeting detail page (protected)
  share/[token]/        Public, read only shared meeting view
  page.js, Dashboard.js Dashboard (protected)
components/ui/         shadcn UI primitives
uploads/                Scratch space for files during transcription
```

## Security notes

- Passwords are hashed with bcrypt
- Sessions are a random token stored in MongoDB, referenced by an httpOnly cookie; the cookie itself carries no data
- Every meeting lookup is scoped to the signed in user, and requests for another user's meeting return a generic not found response
- Share links use a long random token and can be revoked at any time
