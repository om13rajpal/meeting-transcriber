import 'server-only';
import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/app/lib/db';
import { authenticateApiKey } from '@/app/lib/apiKeys';

// Lets the desktop app and Chrome extension confirm a key is real and not
// revoked at the moment it's entered in Settings, instead of the user only
// finding out it was wrong later when an upload silently fails somewhere
// past where they'd notice. Deliberately has no other effect - unlike
// /api/tokens/upload, this never mints a token or creates a Meeting row,
// so it's safe to call as often as the user edits the field.
export async function POST(request) {
  await connectToDatabase();

  const apiKey = await authenticateApiKey(request);
  if (!apiKey) {
    return NextResponse.json({ valid: false, error: 'Invalid or revoked API key.' }, { status: 401 });
  }

  return NextResponse.json({ valid: true, label: apiKey.label });
}
