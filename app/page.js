import { connectToDatabase } from '@/app/lib/db';
import User from '@/app/lib/models/User';
import { verifySession } from '@/app/lib/dal';
import { listMeetings, getUsageSummary } from '@/app/lib/meetings';
import Dashboard from './Dashboard';

export const metadata = { title: 'Dashboard - Meeting Transcriber' };

export default async function DashboardPage() {
  const { userId } = await verifySession();

  await connectToDatabase();
  const [user, meetings, usageSummary] = await Promise.all([
    User.findById(userId),
    listMeetings(userId),
    getUsageSummary(userId)
  ]);

  return <Dashboard userEmail={user?.email || ''} initialMeetings={meetings} usageSummary={usageSummary} />;
}
