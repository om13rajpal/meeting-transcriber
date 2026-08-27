# Meeting Transcriber

A private, self-hosted web app for transcribing meeting recordings that mix Hindi and English (Hinglish). Upload an MP4 or MP3, and it extracts the audio if needed, transcribes it with Deepgram, and keeps a private, searchable history of every meeting per user.

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
- Optional personal access tokens for authenticating non browser clients

## Tech stack

- Node.js and Express, no frontend framework, no build step
- MongoDB with Mongoose for users, meetings, and sessions
- Deepgram for speech to text
- ffmpeg and ffprobe for audio extraction and normalization
- Vanilla HTML, CSS, and JavaScript on the client

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
   - `SESSION_SECRET`: a long random string used to sign session cookies
   - `PORT`: the port to run the server on, for example `3210`

3. Start MongoDB if it is not already running.

4. Start the app:

   ```
   npm start
   ```

5. Open `http://localhost:3210` in your browser, sign up, and upload a recording.

## Project structure

```
server.js              Entry point: session setup and route mounting
db.js                   MongoDB connection
models/                 Mongoose schemas for User and Meeting
middleware/auth.js      Session and personal access token authentication
routes/                 Auth, meetings, transcription, and share endpoints
services/deepgram.js    Audio extraction and the Deepgram integration
public/                 Static assets, client scripts, and the login and signup pages
views/                  Server rendered pages that require authentication
uploads/                Scratch space for files during transcription
```

## Security notes

- Passwords are hashed with bcrypt
- Session cookies are HTTP only and use the `secure` flag in production
- Every meeting lookup is scoped to the signed in user, and requests for another user's meeting return a generic not found response
- Share links use a long random token and can be revoked at any time
