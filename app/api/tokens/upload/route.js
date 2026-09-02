import 'server-only';
import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/app/lib/db';
import { authenticateApiKey } from '@/app/lib/apiKeys';
import { mintUploadToken } from '@/app/lib/uploadTokens';

// The one entry point for a non-browser client (desktop app, Chrome
// extension) to mint an upload token. A Route Handler, not a Server
// Action, because this is "a request initiated by something outside
// this app" in the sense CLAUDE.md's Route Handler rule means - not a
// browser POSTing this app's own form/fetch, but a native client
// authenticating with a bearer credential instead of a session cookie.
// See "Authentication for machine clients" in the design spec.
export async function POST(request) {
  await connectToDatabase();

  const apiKey = await authenticateApiKey(request);
  if (!apiKey) {
    // Same "don't leak which part was wrong" instinct as login's
    // generic "Invalid email or password" - a missing header, a bad key,
    // and a revoked key all look identical to the caller.
    return NextResponse.json({ error: 'Invalid or revoked API key.' }, { status: 401 });
  }

  let fileName;
  try {
    const body = await request.json();
    fileName = body?.fileName;
  } catch {
    fileName = undefined;
  }

  const result = await mintUploadToken({ userId: apiKey.userId, fileName });
  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json(result);
}
