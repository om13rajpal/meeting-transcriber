import { findMeetingByShareToken } from '@/app/lib/meetings';
import { Badge } from '@/components/ui/badge';
import ShareView from './ShareView';

export const metadata = { title: 'Shared meeting - Meeting Transcriber' };

export default async function SharePage({ params }) {
  const { token } = await params;
  const meeting = await findMeetingByShareToken(token);

  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-5 flex justify-center">
        <Badge variant="secondary" className="px-3 py-1 font-normal text-muted-foreground">
          Shared, read-only view of a meeting transcript
        </Badge>
      </div>
      {meeting ? (
        <ShareView
          meeting={{
            title: meeting.title || meeting.originalName || 'Untitled recording',
            originalName: meeting.originalName,
            isVideo: meeting.isVideo,
            durationSeconds: meeting.durationSeconds,
            transcript: meeting.transcript,
            // Plain objects only: Mongoose subdocuments carry a circular
            // reference back to their parent and can't cross the
            // Server-to-Client Component boundary as-is.
            utterances: (meeting.utterances || []).map((u) => ({
              speaker: u.speaker,
              start: u.start,
              end: u.end,
              transcript: u.transcript
            })),
            speakerNames: Object.fromEntries(meeting.speakerNames || [])
          }}
        />
      ) : (
        <div className="rounded-xl border border-dashed py-14 text-center text-muted-foreground">
          This link is invalid or has been revoked.
        </div>
      )}
    </main>
  );
}
