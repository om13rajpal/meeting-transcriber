import 'server-only';
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/app/lib/db';
import ApiKey from '@/app/lib/models/ApiKey';
import { markMeetingFailedCore } from '@/app/actions/meetings';

function hashApiKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// Companion to /api/tokens/upload - lets a machine client report its
// own upload failure promptly instead of leaving the row at
// 'processing' until sweepStaleJobs() eventually notices, 30 minutes
// later. See "Job status" in CLAUDE.md for why prompt, accurate status
// matters here.
export async function POST(request) {
  const authHeader = request.headers.get('authorization') || '';
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) {
    return NextResponse.json({ error: 'Missing or invalid Authorization header.' }, { status: 401 });
  }

  await connectToDatabase();

  const keyHash = hashApiKey(match[1].trim());
  const apiKey = await ApiKey.findOne({ keyHash });
  if (!apiKey) {
    return NextResponse.json({ error: 'Invalid or revoked API key.' }, { status: 401 });
  }
  apiKey.lastUsedAt = new Date();
  await apiKey.save();

  const body = await request.json().catch(() => ({}));
  if (!body?.meetingId) {
    return NextResponse.json({ error: 'meetingId is required.' }, { status: 400 });
  }

  const result = await markMeetingFailedCore({ meetingId: body.meetingId, userId: apiKey.userId, message: body.message });
  return NextResponse.json(result);
}
