import { verifySession } from '@/app/lib/dal';
import { findOwnedMeetingLean, toDetail } from '@/app/lib/meetings';
import { Button } from '@/components/ui/button';
import MeetingDetail from './MeetingDetail';

export const metadata = { title: 'Meeting - Meeting Transcriber' };

export default async function MeetingPage({ params }) {
  const { id } = await params;
  const { userId } = await verifySession();

  const meeting = await findOwnedMeetingLean(id, userId);

  if (!meeting) {
    return (
      <main className="mx-auto max-w-3xl px-6 py-8">
        <Button
          variant="ghost"
          size="sm"
          className="mb-4 -ml-2 text-muted-foreground"
          render={<a href="/" />}
          nativeButton={false}
        >
          &larr; Back to meetings
        </Button>
        <div className="rounded-xl border border-dashed py-14 text-center text-muted-foreground">
          Meeting not found.
        </div>
      </main>
    );
  }

  return <MeetingDetail id={id} initialMeeting={toDetail(meeting)} />;
}
