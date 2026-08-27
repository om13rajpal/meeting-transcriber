'use server';

import bcrypt from 'bcrypt';
import { redirect } from 'next/navigation';
import { connectToDatabase } from '@/app/lib/db';
import User from '@/app/lib/models/User';
import { createSession, deleteSession } from '@/app/lib/session';

const BCRYPT_ROUNDS = 12;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DUMMY_HASH = '$2b$12$invalidsaltinvalidsaltinvalidsaltinvalidsaltuu';

// Shared by login and any future headless/token auth so the timing-safe
// behavior (always run bcrypt.compare, even with no matching user, so
// response timing doesn't reveal whether the email is registered) lives in
// one place.
async function verifyCredentials(email, password) {
  await connectToDatabase();
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const user = normalizedEmail ? await User.findOne({ email: normalizedEmail }) : null;
  const matches = await bcrypt.compare(typeof password === 'string' ? password : '', user ? user.passwordHash : DUMMY_HASH);
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
