import 'server-only';
import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/app/lib/db';
import { authenticateApiKey } from '@/app/lib/apiKeys';
import { listMeetingsForApiKey } from '@/app/lib/meetings';

// Lets the desktop app show its own native "Recent Recordings" status
// list instead of embedding the website - see
// docs/superpowers/specs/2026-09-05-desktop-native-recordings-view-design.md.
// Deliberately read-only and metadata-only (see toApiKeySummary in
// app/lib/meetings.js) - this is the one read capability an API key has.
export async function GET(request) {
  await connectToDatabase();

  const apiKey = await authenticateApiKey(request);
  if (!apiKey) {
    return NextResponse.json({ error: 'Invalid or revoked API key.' }, { status: 401 });
  }

  const meetings = await listMeetingsForApiKey(apiKey.userId);
  return NextResponse.json({ meetings });
}
