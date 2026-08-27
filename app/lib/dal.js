import 'server-only';
import { cache } from 'react';
import { redirect } from 'next/navigation';
import { getSessionUserId } from '@/app/lib/session';

// For Server Components and Server Actions: redirects to /login if there's
// no valid session. Cached per request so calling it from multiple places
// during one render only hits the database once.
export const verifySession = cache(async () => {
  const userId = await getSessionUserId();
  if (!userId) {
    redirect('/login');
  }
  return { userId };
});
