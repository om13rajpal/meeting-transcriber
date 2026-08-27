import 'server-only';
import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { getSessionUserId } from '@/app/lib/session';
import { isGoogleConfigured, buildGoogleAuthorizationUrl, GOOGLE_CALLBACK_PATH } from '@/app/lib/oauth';

const STATE_COOKIE = 'oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000; // just long enough for a consent screen, short enough to bound a stale-state replay

// The one deliberate Route Handler in an app that otherwise has none (see
// "no Route Handlers" elsewhere in CLAUDE.md): Google redirects the
// browser here with a plain GET, which can't be a Server Action (those
// only respond to POSTs this app itself sends, not a third party's
// redirect).
export async function GET(request) {
  const userId = await getSessionUserId();
  if (userId) {
    return NextResponse.redirect(new URL('/', request.url));
  }

  const appUrl = process.env.APP_URL;
  if (!isGoogleConfigured() || !appUrl) {
    return NextResponse.redirect(new URL('/login?error=oauth_unavailable', request.url));
  }

  const state = crypto.randomBytes(24).toString('hex');
  const authUrl = buildGoogleAuthorizationUrl({
    state,
    redirectUri: `${appUrl}${GOOGLE_CALLBACK_PATH}`
  });

  const response = NextResponse.redirect(authUrl);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: STATE_TTL_MS / 1000,
    path: '/'
  });
  return response;
}
