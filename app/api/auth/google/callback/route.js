import 'server-only';
import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/app/lib/db';
import User from '@/app/lib/models/User';
import { createSession } from '@/app/lib/session';
import { exchangeGoogleCode, fetchGoogleProfile, GOOGLE_CALLBACK_PATH } from '@/app/lib/oauth';

const STATE_COOKIE = 'oauth_state';

export async function GET(request) {
  const loginUrl = (error) => new URL(`/login${error ? `?error=${error}` : ''}`, request.url);
  const response = (url) => {
    const res = NextResponse.redirect(url);
    res.cookies.delete(STATE_COOKIE);
    return res;
  };

  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const providerError = searchParams.get('error');

  const expectedState = request.cookies.get(STATE_COOKIE)?.value;

  // The user declined consent on Google's screen - not an error worth
  // logging, just a normal "changed their mind" outcome.
  if (providerError) {
    return response(loginUrl(providerError === 'access_denied' ? undefined : 'oauth_failed'));
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    return response(loginUrl('oauth_failed'));
  }

  try {
    await connectToDatabase();

    const appUrl = process.env.APP_URL;
    const redirectUri = `${appUrl}${GOOGLE_CALLBACK_PATH}`;
    const accessToken = await exchangeGoogleCode({ code, redirectUri });
    const profile = await fetchGoogleProfile(accessToken);

    if (!profile) {
      // Google wouldn't vouch for a verified email - don't create or link
      // an account on an identity we can't confirm.
      return response(loginUrl('oauth_unverified'));
    }

    const email = profile.email.trim().toLowerCase();

    let user = await User.findOne({ email });
    if (user) {
      // First time Google is used for an existing account (created by
      // password signup) - link it rather than creating a duplicate
      // account for the same email. The avatar is refreshed on every
      // Google sign-in (cosmetic only, cheap to keep current).
      if (!user.googleId) user.googleId = profile.providerId;
      user.avatarUrl = profile.avatarUrl;
      await user.save();
    } else {
      user = await User.create({ email, googleId: profile.providerId, avatarUrl: profile.avatarUrl });
    }

    await createSession(user._id);
    return response(new URL('/', request.url));
  } catch (error) {
    console.error('Google OAuth callback failed:', error);
    return response(loginUrl('oauth_failed'));
  }
}
