'use server';

import bcrypt from 'bcrypt';
import { redirect } from 'next/navigation';
import { connectToDatabase } from '@/app/lib/db';
import User from '@/app/lib/models/User';
import Session from '@/app/lib/models/Session';
import PasswordResetToken from '@/app/lib/models/PasswordResetToken';
import { createSession, deleteSession } from '@/app/lib/session';
import { sendPasswordResetEmail } from '@/app/lib/email';

const BCRYPT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUMMY_HASH = '$2b$12$invalidsaltinvalidsaltinvalidsaltinvalidsaltuu';
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour: long enough to find the email, short enough to bound exposure

// Shared by login and any future headless/token auth so the timing-safe
// behavior (always run bcrypt.compare, even with no matching user, so
// response timing doesn't reveal whether the email is registered) lives in
// one place.
async function verifyCredentials(email, password) {
  await connectToDatabase();
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const user = normalizedEmail ? await User.findOne({ email: normalizedEmail }) : null;
  // A Google/Microsoft-only account has no passwordHash at all - falling
  // through to DUMMY_HASH here (rather than passing undefined to
  // bcrypt.compare, which throws) keeps that case just as "wrong
  // password" as a real mismatch, both in outcome and in timing.
  const matches = await bcrypt.compare(typeof password === 'string' ? password : '', (user && user.passwordHash) || DUMMY_HASH);
  return matches ? user : null;
}

export async function signup(prevState, formData) {
  const email = String(formData.get('email') || '').trim().toLowerCase();
  const password = String(formData.get('password') || '');

  if (!EMAIL_RE.test(email)) {
    return { error: 'Enter a valid email address.' };
  }
  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters.' };
  }

  await connectToDatabase();
  const existing = await User.findOne({ email });
  if (existing) {
    return { error: 'An account with this email already exists.' };
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const user = await User.create({ email, passwordHash });

  await createSession(user._id);
  redirect('/');
}

export async function login(prevState, formData) {
  const email = String(formData.get('email') || '');
  const password = String(formData.get('password') || '');

  const user = await verifyCredentials(email, password);
  if (!user) {
    return { error: 'Invalid email or password.' };
  }

  await createSession(user._id);
  redirect('/');
}

export async function logout() {
  await deleteSession();
  redirect('/login');
}

// Always returns the same generic message regardless of whether the email
// is registered - same "don't leak existence" rule as login. Only sends an
// email (fire-and-forget best-effort, see app/lib/email.js) if it is.
export async function requestPasswordReset(prevState, formData) {
  const email = String(formData.get('email') || '').trim().toLowerCase();
  const message = 'If that email has an account, a reset link is on its way.';

  if (!EMAIL_RE.test(email)) {
    return { message };
  }

  await connectToDatabase();
  const user = await User.findOne({ email });
  if (user) {
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);
    const tokenDoc = await PasswordResetToken.create({ userId: user._id, expiresAt });
    await sendPasswordResetEmail(user.email, tokenDoc._id);
  }

  return { message };
}

export async function resetPassword(prevState, formData) {
  const token = String(formData.get('token') || '');
  const password = String(formData.get('password') || '');
  const confirmPassword = String(formData.get('confirmPassword') || '');

  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters.' };
  }
  if (password !== confirmPassword) {
    return { error: 'Passwords do not match.' };
  }

  await connectToDatabase();
  const tokenDoc = await PasswordResetToken.findByIdAndDelete(token).catch(() => null);
  if (!tokenDoc) {
    return { error: 'This reset link is invalid or has expired. Please request a new one.' };
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await User.findByIdAndUpdate(tokenDoc.userId, { passwordHash });

  // A password reset is often a response to a compromised account, so sign
  // every existing session out - the one completing this reset gets a
  // fresh session below, everyone else has to log in again with the new
  // password.
  await Session.deleteMany({ userId: tokenDoc.userId });

  await createSession(tokenDoc.userId);
  redirect('/');
}
