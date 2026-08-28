import { getSessionUserId } from '@/app/lib/session';
import Landing from './Landing';
import DashboardPage from './DashboardPage';

// "/" is the one route that serves two surfaces. Signed out it is the public
// marketing page and touches no user data at all. Signed in it is the
// dashboard, and that branch still goes through verifySession() inside
// DashboardPage, so the auth boundary is unchanged: nothing reads a meeting
// without it. getSessionUserId() here only decides which surface to render,
// it never authorizes a read.
export default async function Root() {
  const userId = await getSessionUserId();
  if (!userId) return <Landing />;
  return <DashboardPage />;
}
