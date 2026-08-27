import 'server-only';

// Google-only for now (see CLAUDE.md's "Sign in with Google" section for
// why this isn't a generic multi-provider abstraction: it was one until
// Microsoft sign-in was dropped for lack of Azure access, and a generic
// shape for a single provider is exactly the premature abstraction this
// codebase avoids elsewhere - re-genericize if a second provider actually
// gets added back, not before).
const GOOGLE = {
  clientId: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  scope: 'openid email profile'
};

export function isGoogleConfigured() {
  return Boolean(GOOGLE.clientId && GOOGLE.clientSecret);
}

export const GOOGLE_CALLBACK_PATH = '/api/auth/google/callback';

export function buildGoogleAuthorizationUrl({ state, redirectUri }) {
  const params = new URLSearchParams({
    client_id: GOOGLE.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE.scope,
    state
  });
  return `${GOOGLE.authUrl}?${params.toString()}`;
}

export async function exchangeGoogleCode({ code, redirectUri }) {
  const body = new URLSearchParams({
    client_id: GOOGLE.clientId,
    client_secret: GOOGLE.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });

  const resp = await fetch(GOOGLE.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!resp.ok) {
    throw new Error(`Google token exchange failed (${resp.status})`);
  }
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error('Google token exchange returned no access_token');
  }
  return data.access_token;
}

// Returns { providerId, email } for a verified account, or null if Google
// won't vouch for the email - only trust an email Google itself says it
// verified, so someone can't claim an address that isn't really theirs.
export async function fetchGoogleProfile(accessToken) {
  const resp = await fetch(GOOGLE.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!resp.ok) {
    throw new Error(`Google profile fetch failed (${resp.status})`);
  }
  const data = await resp.json();
  if (!data.verified_email || !data.email) return null;
  return { providerId: data.id, email: data.email };
}

const OAUTH_ERROR_MESSAGES = {
  oauth_unavailable: 'Sign-in with Google is not set up yet.',
  oauth_unverified: 'That Google account has no verified email address to sign in with.',
  oauth_failed: 'Something went wrong signing you in. Please try again.'
};

// Shared by the login and signup pages, which both link to /api/auth/google
// and land back here with ?error=... on failure.
export function oauthErrorMessage(code) {
  return OAUTH_ERROR_MESSAGES[code] || null;
}
