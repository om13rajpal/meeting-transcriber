import { connectToDatabase } from '@/app/lib/db';
import User from '@/app/lib/models/User';
import { verifySession } from '@/app/lib/dal';
import { findOwnedMeetingLean, listKnownSpeakerNames, toDetail } from '@/app/lib/meetings';
import AppHeader from '@/components/brand/AppHeader';
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty';
import MeetingDetail from './MeetingDetail';

export const metadata = { title: 'Meeting - Meeting Transcriber' };

export default async function MeetingPage({ params, searchParams }) {
  const { id } = await params;
  const { q } = await searchParams;
  const { userId } = await verifySession();

  await connectToDatabase();
  const [meeting, user] = await Promise.all([
    findOwnedMeetingLean(id, userId),
    User.findById(userId)
  ]);
  const userEmail = user?.email || '';
  const avatarUrl = user?.avatarUrl || null;

  if (!meeting) {
    return (
      <div className="min-h-screen" style={{ background: 'var(--cr-ink-app)' }}>
        <AppHeader userEmail={userEmail} avatarUrl={avatarUrl} />
        <main className="mx-auto px-6 py-8" style={{ maxWidth: 'var(--cr-measure-app)' }}>
          <Empty className="py-14" style={{ border: '1px dashed var(--cr-rule-soft)', borderRadius: 'var(--cr-radius-xl)' }}>
            <EmptyHeader>
              <EmptyTitle>Meeting not found</EmptyTitle>
              <EmptyDescription>It may have been deleted, or the link is wrong.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        </main>
      </div>
    );
  }

  const knownSpeakerNames = await listKnownSpeakerNames(userId);

  return (
    <MeetingDetail
      id={id}
      userEmail={userEmail}
      avatarUrl={avatarUrl}
      initialMeeting={toDetail(meeting)}
      knownSpeakerNames={knownSpeakerNames}
      initialQuery={typeof q === 'string' ? q : ''}
    />
  );
}
