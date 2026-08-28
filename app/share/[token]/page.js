import Link from 'next/link';
import { findMeetingByShareToken } from '@/app/lib/meetings';
import Wordmark from '@/components/brand/Wordmark';
import ShareView from './ShareView';

export const metadata = { title: 'Shared meeting - Meeting Transcriber' };

// Marketing surface per the brand kit's surface split, seen by people who
// do not have an account. No caching of any kind on the lookup above
// (findMeetingByShareToken), on purpose: revoking a share link is a real
// security guarantee that has to take effect immediately.
export default async function SharePage({ params }) {
  const { token } = await params;
  const meeting = await findMeetingByShareToken(token);

  return (
    <div className="min-h-screen" style={{ background: 'var(--cr-ink)', color: 'var(--cr-text)' }}>
      <nav className="px-6 pt-7">
        <Link href="/" className="inline-block rounded-[var(--cr-radius-sm)] outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <Wordmark size="nav" />
        </Link>
      </nav>

      <main className="mx-auto px-6 py-10" style={{ maxWidth: 780 }}>
        <div className="mb-6 flex justify-center">
          <span
            className="font-mono uppercase"
            style={{
              fontSize: 10.5,
              letterSpacing: '0.1em',
              color: 'var(--cr-red-fill)',
              border: '1px solid var(--cr-red-fill)',
              borderRadius: 999,
              padding: '5px 12px'
            }}
          >
            Shared, read-only view of a meeting transcript
          </span>
        </div>
        {meeting ? (
          <ShareView
            meeting={{
              title: meeting.title || meeting.originalName || 'Untitled recording',
              originalName: meeting.originalName,
              isVideo: meeting.isVideo,
              durationSeconds: meeting.durationSeconds,
              transcript: meeting.transcript,
              // findMeetingByShareToken uses .lean(), so utterances and
              // speakerNames already arrive as plain objects/arrays with no
              // Mongoose document wrapper - no mapping needed to cross the
              // Server-to-Client Component boundary safely.
              utterances: meeting.utterances || [],
              speakerNames: meeting.speakerNames || {}
            }}
          />
        ) : (
          <div
            className="rounded-[var(--cr-radius-xl)] py-14 text-center text-muted-foreground"
            style={{ border: '1px dashed var(--cr-rule-soft)' }}
          >
            This link is invalid or has been revoked.
          </div>
        )}
      </main>
    </div>
  );
}
