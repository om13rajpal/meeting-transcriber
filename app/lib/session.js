import 'server-only';
import { cookies } from 'next/headers';
import { connectToDatabase } from '@/app/lib/db';
import Session from '@/app/lib/models/Session';

const COOKIE_NAME = 'session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export async function createSession(userId) {
  await connectToDatabase();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const session = await Session.create({ userId, expiresAt });

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, session._id, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires: expiresAt,
    path: '/'
  });
}

// Returns the signed-in user's id, or null. Does not redirect: callers that
// need to enforce auth should use requireUserId() from dal.js instead.
export async function getSessionUserId() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (!token) return null;

  await connectToDatabase();
  const session = await Session.findById(token);
  return session ? session.userId : null;
}

// The current tab's own session token (the raw cookie value, which doubles
// as the Session document's _id - see createSession above). Used when an
// action needs to sign out every OTHER device without also signing out the
// device that just proved it's the account owner (see updatePassword in
// app/actions/auth.js). Returns null if there's no session cookie at all.
export async function getCurrentSessionToken() {
  const cookieStore = await cookies();
  return cookieStore.get(COOKIE_NAME)?.value || null;
}

export async function deleteSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value;
  if (token) {
    await connectToDatabase();
    await Session.findByIdAndDelete(token).catch(() => null);
  }
  cookieStore.delete(COOKIE_NAME);
}
