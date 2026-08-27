import 'server-only';

// Both providers speak standard OAuth 2.0 Authorization Code flow with the
// same field names for the token exchange, so one generic implementation
// below (buildAuthorizationUrl / exchangeCodeForToken / fetchProfile)
// covers both - only the endpoints, scope, and how to pull a verified
// email out of the user-info response differ per provider.
export const OAUTH_PROVIDERS = {
  google: {
    name: 'Google',
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
    scope: 'openid email profile',
    // Only trust an email Google itself says it verified - otherwise
    // someone could claim an email address that isn't really theirs.
    extractProfile: (data) => {
      if (!data.verified_email || !data.email) return null;
      return { providerId: data.id, email: data.email };
    }
  },
  microsoft: {
    name: 'Microsoft',
    clientId: process.env.MICROSOFT_CLIENT_ID,
    clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
    // "common" accepts both personal Microsoft accounts and work/school
    // (Azure AD) accounts, which is the broadest fit for a personal app
    // where either kind is plausible.
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
    scope: 'openid email profile User.Read',
    // Microsoft Graph's /me has no separate "verified" flag the way
    // Google does - `mail` is only populated once a mailbox exists and is
    // itself the verified-by-Microsoft address; `userPrincipalName` (the
    // sign-in identity) is the fallback for accounts where `mail` is
    // null, which is common for personal Microsoft accounts.
    extractProfile: (data) => {
      const email = data.mail || data.userPrincipalName;
      if (!email) return null;
      return { providerId: data.id, email };
    }
  }
};

export function isProviderConfigured(provider) {
  const config = OAUTH_PROVIDERS[provider];
  return Boolean(config?.clientId && config?.clientSecret);
}

const OAUTH_ERROR_MESSAGES = {
  oauth_unavailable: 'Sign-in with that provider is not set up yet.',
  oauth_unverified: 'That account has no verified email address to sign in with.',
  oauth_failed: 'Something went wrong signing you in. Please try again.'
};

// Shared by the login and signup pages, which both link out to the same
// /api/auth/[provider] flow and land back here with ?error=... on failure.
export function oauthErrorMessage(code) {
  return OAUTH_ERROR_MESSAGES[code] || null;
}

export function callbackPath(provider) {
  return `/api/auth/${provider}/callback`;
}

export function buildAuthorizationUrl(provider, { state, redirectUri }) {
  const config = OAUTH_PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: config.scope,
    state
  });
  return `${config.authUrl}?${params.toString()}`;
}

export async function exchangeCodeForToken(provider, { code, redirectUri }) {
  const config = OAUTH_PROVIDERS[provider];
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code'
  });

  const resp = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  if (!resp.ok) {
    throw new Error(`${config.name} token exchange failed (${resp.status})`);
  }
  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`${config.name} token exchange returned no access_token`);
  }
  return data.access_token;
}

// Returns { providerId, email } for a verified account, or null if the
// provider won't vouch for the email (see extractProfile per provider).
export async function fetchProfile(provider, accessToken) {
  const config = OAUTH_PROVIDERS[provider];
  const resp = await fetch(config.userInfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!resp.ok) {
    throw new Error(`${config.name} profile fetch failed (${resp.status})`);
  }
  const data = await resp.json();
  return config.extractProfile(data);
}
