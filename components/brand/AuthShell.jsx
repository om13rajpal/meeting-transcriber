import Link from 'next/link';
import Wordmark from './Wordmark';
import Eyebrow from './Eyebrow';
import HandoffRibbon from './HandoffRibbon';

const TRANSCRIPT_LINES = [
  { tag: 'AANYA I.', time: '00:12:04', text: <>Toh Q3 ka number kya laga? Last week ke <mark className="rounded-[var(--cr-radius-sm)] px-[3px] bg-[var(--cr-yellow)] text-[var(--cr-yellow-ink)]">draft</mark> mein 4.2 crore tha.</> },
  { tag: 'ROHIT K.', time: '00:12:11', text: '4.28 actually. Marathahalli wale account ne late close kiya.' },
  { tag: 'AANYA I.', time: '00:12:19', text: <>Theek hai, phir <mark className="rounded-[var(--cr-radius-sm)] px-[3px] bg-[var(--cr-yellow)] text-[var(--cr-yellow-ink)]">revised deck</mark> mein wahi number daal dena.</> },
  { tag: 'PRIYA B.', time: '00:12:26', text: <>Mera number save kar lo, <span style={{ background: 'var(--cr-text-on-paper)', color: 'var(--cr-text-on-paper)', borderRadius: 2 }}>&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;</span></> }
];

// Marketing-weight illustration side, shared by every auth screen so the
// front door and the door you actually walk through match. Login gets the
// transcript-as-hero card (the record you already own), Signup gets the
// hand-off ribbon (the promise of what uploading does). Copy and content
// are the approved Round 5 mockup's, not a paraphrase, see
// docs/design/mockups/round5-auth-login-signup.html.
function TranscriptSample() {
  return (
    <div
      className="w-full max-w-md rounded-[var(--cr-radius-card)] px-7 py-6"
      style={{ background: 'var(--cr-paper)', color: 'var(--cr-text-on-paper)', boxShadow: 'var(--cr-shadow-sheet)' }}
    >
      <div className="flex items-start justify-between" style={{ marginBottom: 'var(--cr-space-4)' }}>
        <div className="font-display uppercase" style={{ fontSize: 'var(--cr-type-mono)', fontWeight: 'var(--cr-weight-heavy)', letterSpacing: '0.03em', color: 'var(--cr-text-paper-mut)' }}>
          Q3 Pipeline Review &middot; 12 Aug
        </div>
        <div
          className="font-display uppercase shrink-0"
          style={{ fontSize: 10, fontWeight: 'var(--cr-weight-heavy)', letterSpacing: '0.1em', color: 'var(--cr-red-fill)', border: '1px solid var(--cr-red-fill)', borderRadius: 4, padding: '3px 8px', transform: 'rotate(-4deg)' }}
        >
          Diarised
        </div>
      </div>
      {TRANSCRIPT_LINES.map((line, i, arr) => (
        <div
          key={i}
          className="flex gap-[var(--cr-space-3)] font-mono"
          style={{
            fontSize: 'var(--cr-type-sm)',
            lineHeight: 'var(--cr-leading-mono)',
            padding: '6px 0',
            borderBottom: i < arr.length - 1 ? '1px dashed var(--cr-paper-rule)' : 'none'
          }}
        >
          <span className="h-fit shrink-0 font-semibold" style={{ background: 'var(--cr-text-on-paper)', color: 'var(--cr-paper)', fontSize: 10, padding: '2px 7px', borderRadius: 4 }}>
            {line.tag}
          </span>
          <span className="shrink-0" style={{ color: 'var(--cr-text-paper-mut)' }}>{line.time}</span>
          <span>{line.text}</span>
        </div>
      ))}
      <div
        className="flex flex-wrap gap-x-[var(--cr-space-4)] gap-y-1 font-mono"
        style={{ marginTop: 'var(--cr-space-4)', paddingTop: 'var(--cr-space-4)', borderTop: '1px solid var(--cr-paper-rule)', fontSize: 11, color: 'var(--cr-text-paper-mut)' }}
      >
        <span>3 speakers</span>
        <span>00:41:12 runtime</span>
        <span style={{ color: 'var(--cr-text-on-paper)', fontWeight: 600 }}>Nova-3 &middot; $0.2925</span>
        <span>uploaded 12 Aug, 4:18 PM</span>
      </div>
    </div>
  );
}

// eyebrow: string. headline: [line1, line2] (line2 renders in brand red).
// lede: string. stats: array of short strings, separated by hairlines
// under the illustration. side: 'transcript' | 'ribbon'.
export default function AuthShell({ eyebrow, headline, lede, stats, side = 'transcript', formEyebrow, formHeadline, formLede, children }) {
  return (
    <div className="min-h-screen" style={{ background: 'var(--cr-ink)', color: 'var(--cr-text)' }}>
      <nav className="px-6 pt-7">
        <Link href="/" className="inline-block rounded-[var(--cr-radius-sm)] outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
          <Wordmark size="nav" />
        </Link>
      </nav>

      <div className="mx-auto grid gap-14 px-6 py-12 md:grid-cols-2" style={{ maxWidth: 1200 }}>
        <div className="hidden md:block" style={{ borderRight: '1px solid var(--cr-rule-soft)', paddingRight: 'var(--cr-space-9)' }}>
          <Eyebrow className="mb-4">
            <span style={{ color: 'var(--cr-red-text)' }}>&#9679;</span> {eyebrow}
          </Eyebrow>
          <h1
            className="font-display uppercase"
            style={{
              fontSize: 'clamp(34px, 4.4vw, 56px)',
              lineHeight: 'var(--cr-leading-display)',
              letterSpacing: 'var(--cr-tracking-display)',
              fontWeight: 'var(--cr-weight-display)',
              marginBottom: 'var(--cr-space-4)'
            }}
          >
            {headline[0]}
            <br />
            <span style={{ color: 'var(--cr-red-text)' }}>{headline[1]}</span>
          </h1>
          <p style={{ fontSize: 'var(--cr-type-sm)', lineHeight: 'var(--cr-leading-body)', color: 'var(--cr-text-secondary)', maxWidth: 420, marginBottom: 'var(--cr-space-7)' }}>
            {lede}
          </p>

          {side === 'ribbon' ? (
            <div>
              <HandoffRibbon className="w-full" scale={0.9} />
              <p className="font-mono uppercase" style={{ fontSize: 10.5, letterSpacing: '0.1em', color: 'var(--cr-text-muted)', marginTop: 'var(--cr-space-2)' }}>
                Voice in. Record out. Nothing in between that you have to do.
              </p>
            </div>
          ) : (
            <TranscriptSample />
          )}

          {stats && (
            <div
              className="flex flex-wrap gap-x-[var(--cr-space-6)] gap-y-2 font-mono"
              style={{ marginTop: 'var(--cr-space-8)', paddingTop: 'var(--cr-space-5)', borderTop: '1px solid var(--cr-rule-soft)', fontSize: 'var(--cr-type-meta)', color: 'var(--cr-text-muted)' }}
            >
              {stats.map((s, i) => <span key={i}>{s}</span>)}
            </div>
          )}
        </div>

        <div className="mx-auto w-full max-w-sm md:mx-0 md:max-w-none md:pl-2">
          <Eyebrow className="mb-3">&sect; {formEyebrow}</Eyebrow>
          <h2
            className="font-display uppercase"
            style={{ fontSize: 'clamp(26px, 3vw, 38px)', fontWeight: 'var(--cr-weight-display)', letterSpacing: 'var(--cr-tracking-display)', marginBottom: 'var(--cr-space-3)' }}
          >
            {formHeadline}
          </h2>
          <p style={{ fontSize: 'var(--cr-type-sm)', lineHeight: 'var(--cr-leading-body)', color: 'var(--cr-text-secondary)', marginBottom: 'var(--cr-space-6)' }}>
            {formLede}
          </p>
          {children}
        </div>
      </div>
    </div>
  );
}
