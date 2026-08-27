import 'server-only';
import { NextResponse } from 'next/server';
import { connectToDatabase } from '@/app/lib/db';
import User from '@/app/lib/models/User';
import { createSession } from '@/app/lib/session';
import { OAUTH_PROVIDERS, exchangeCodeForToken, fetchProfile, callbackPath } from '@/app/lib/oauth';

const STATE_COOKIE = 'oauth_state';
const PROVIDER_ID_FIELD = { google: 'googleId', microsoft: 'microsoftId' };

export async function GET(request, { params }) {
  const { provider } = await params;
  const loginUrl = (error) => new URL(`/login${error ? `?error=${error}` : ''}`, request.url);

  if (!OAUTH_PROVIDERS[provider]) {
    return NextResponse.redirect(loginUrl('oauth_failed'));
  }

  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const providerError = searchParams.get('error');

  const expectedState = request.cookies.get(STATE_COOKIE)?.value;
  const response = (url) => {
    const res = NextResponse.redirect(url);
    res.cookies.delete(STATE_COOKIE);
    return res;
  };

  // The user declined consent on the provider's screen - not an error
  // worth logging, just a normal "changed their mind" outcome.
  if (providerError) {
    return response(loginUrl(providerError === 'access_denied' ? undefined : 'oauth_failed'));
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    return response(loginUrl('oauth_failed'));
  }

  try {
    await connectToDatabase();

    const appUrl = process.env.APP_URL;
    const redirectUri = `${appUrl}${callbackPath(provider)}`;
    const accessToken = await exchangeCodeForToken(provider, { code, redirectUri });
    const profile = await fetchProfile(provider, accessToken);

    if (!profile) {
      // The provider wouldn't vouch for a verified email - don't create or
      // link an account on an identity we can't confirm.
      return response(loginUrl('oauth_unverified'));
    }

    const idField = PROVIDER_ID_FIELD[provider];
    const email = profile.email.trim().toLowerCase();

    let user = await User.findOne({ email });
    if (user) {
      // First time this provider is used for an existing account (created
      // by password signup, or a different provider) - link it rather
      // than creating a duplicate account for the same email.
      if (!user[idField]) {
        user[idField] = profile.providerId;
        await user.save();
      }
    } else {
      user = await User.create({ email, [idField]: profile.providerId });
    }

    await createSession(user._id);
    return response(new URL('/', request.url));
  } catch (error) {
    console.error(`OAuth callback (${provider}) failed:`, error);
    return response(loginUrl('oauth_failed'));
  }
}
