import 'server-only';
import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/app/lib/db';
import { authenticateApiKey } from '@/app/lib/apiKeys';
import { markMeetingFailedCore } from '@/app/lib/meetings';

// Companion to /api/tokens/upload - lets a machine client report its
// own upload failure promptly instead of leaving the row at
// 'processing' until sweepStaleJobs() eventually notices, 30 minutes
// later. See "Job status" in CLAUDE.md for why prompt, accurate status
// matters here.
export async function POST(request) {
  await connectToDatabase();

  const apiKey = await authenticateApiKey(request);
  if (!apiKey) {
    return NextResponse.json({ error: 'Invalid or revoked API key.' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  if (!body?.meetingId) {
    return NextResponse.json({ error: 'meetingId is required.' }, { status: 400 });
  }

  const result = await markMeetingFailedCore({ meetingId: body.meetingId, userId: apiKey.userId, message: body.message });
  return NextResponse.json(result);
}
