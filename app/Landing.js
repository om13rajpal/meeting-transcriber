import Link from 'next/link';
import LandingMotion from './LandingMotion';
import Wordmark, { PRODUCT_NAME } from '@/components/brand/Wordmark';
import Eyebrow from '@/components/brand/Eyebrow';
import HandoffRibbon from '@/components/brand/HandoffRibbon';
import { Button } from '@/components/ui/button';

// Splits a headline into per-character spans for the hero's stagger-in.
// Plain server-side text processing, no client component needed for this
// part, LandingMotion targets .cr-hero-char by class once mounted.
function splitChars(text) {
  return Array.from(text).map((char, i) => (
    <span key={i} className="cr-hero-char inline-block" style={{ whiteSpace: char === ' ' ? 'pre' : 'normal' }}>
      {char}
    </span>
  ));
}

const EXHIBITS = [
  {
    id: 'A',
    title: 'Speaks Hinglish natively',
    body: 'Real code-switching, mid-sentence, not translated, not flattened to English.',
    sample: (
      <>...toh <mark className="rounded-[var(--cr-radius-sm)] px-[3px] bg-[var(--cr-yellow)] text-[var(--cr-yellow-ink)]">pricing</mark> ke baare mein unhone poocha...</>
    )
  },
  {
    id: 'B',
    title: 'Search everything',
    body: 'Every past meeting, every speaker, every mention, one search box.',
    tags: ['sales', 'board']
  },
  {
    id: 'C',
    title: 'Know the cost',
    body: "Real model, real per-minute rate, upgraded to Deepgram's exact billed amount.",
    sample: (
      <>Nova-3 &middot; <mark className="rounded-[var(--cr-radius-sm)] px-[3px] bg-[var(--cr-yellow)] text-[var(--cr-yellow-ink)]">$0.0002</mark> estimated</>
    )
  }
];

export const metadata = { title: 'Meeting Transcriber, private Hinglish meeting transcripts' };

export default function Landing() {
  return (
    <LandingMotion>
      <div style={{ background: 'var(--cr-ink)', color: 'var(--cr-text)' }}>
        <nav className="mx-auto flex items-center justify-between px-6 pt-7" style={{ maxWidth: 'var(--cr-measure)' }}>
          <Wordmark size="nav" />
          <div className="flex items-center gap-5">
            <Link
              href="/login"
              className="text-sm font-medium opacity-80 transition-opacity duration-[var(--cr-dur-hover)] ease-[var(--cr-ease-out)] hover:opacity-100"
            >
              Log in
            </Link>
            <Button render={<Link href="/signup" />} nativeButton={false} size="sm" style={{ boxShadow: 'var(--cr-shadow-cta)' }}>
              Sign up
            </Button>
          </div>
        </nav>

        <section
          className="cr-hero-section mx-auto grid gap-14 px-6 pt-16 pb-14 md:grid-cols-[1.05fr_0.95fr] md:items-center md:pt-20"
          style={{ maxWidth: 'var(--cr-measure)' }}
        >
          <div>
            <Eyebrow className="cr-eyebrow mb-5">
              <span style={{ color: 'var(--cr-red-text)' }}>&#9679;</span> Private &middot; Hinglish &middot; Diarised
            </Eyebrow>
            <h1
              className="font-display uppercase"
              style={{
                fontSize: 'clamp(46px, 6.4vw, var(--cr-type-display))',
                lineHeight: 'var(--cr-leading-display)',
                letterSpacing: 'var(--cr-tracking-display)',
                fontWeight: 'var(--cr-weight-display)',
                marginBottom: 'var(--cr-space-5)'
              }}
            >
              {splitChars('Every word.')}
              <br />
              <span style={{ color: 'var(--cr-red-text)' }}>{splitChars('On record.')}</span>
            </h1>
            <p
              className="cr-lede"
              style={{
                fontSize: 'var(--cr-type-lede)',
                lineHeight: 'var(--cr-leading-body)',
                color: 'var(--cr-text-secondary)',
                maxWidth: 'var(--cr-measure-read)',
                marginBottom: 'var(--cr-space-6)'
              }}
            >
              Upload a recording. Nova-3 listens in Hinglish and hands back a searchable, speaker-labelled transcript, kept private to your account, nowhere else.
            </p>
            <div className="cr-cta-row flex flex-wrap items-center gap-6">
              <Button render={<Link href="/signup" />} nativeButton={false} size="lg" style={{ boxShadow: 'var(--cr-shadow-cta)' }}>
                Upload your first meeting &rarr;
              </Button>
              <a
                href="#sample"
                className="text-sm font-semibold underline underline-offset-4 opacity-75 transition-opacity duration-[var(--cr-dur-hover)] ease-[var(--cr-ease-out)] hover:opacity-100"
              >
                See a sample transcript &darr;
              </a>
            </div>
          </div>

          <div
            id="sample"
            className="cr-transcript-card relative rounded-[var(--cr-radius-card)] px-8 py-7"
            style={{ background: 'var(--cr-paper)', color: 'var(--cr-text-on-paper)', boxShadow: 'var(--cr-shadow-sheet)' }}
          >
            <div
              className="absolute font-display uppercase"
              style={{
                top: 22, right: 24,
                fontSize: 'var(--cr-type-tiny)',
                fontWeight: 'var(--cr-weight-heavy)',
                letterSpacing: '0.1em',
                color: 'var(--cr-red-fill)',
                border: '1px solid var(--cr-red-fill)',
                padding: '4px 10px',
                transform: 'rotate(-6deg)'
              }}
            >
              Diarised
            </div>
            <div
              className="font-display uppercase"
              style={{ fontSize: 'var(--cr-type-mono)', fontWeight: 'var(--cr-weight-heavy)', letterSpacing: '0.03em', color: 'var(--cr-text-paper-mut)', marginBottom: 'var(--cr-space-4)' }}
            >
              client_call_ranveer_aditi.mp3
            </div>
            {[
              { tag: 'S1', time: '00:00:04', text: <>Toh <mark className="rounded-[var(--cr-radius-sm)] px-[3px] bg-[var(--cr-yellow)] text-[var(--cr-yellow-ink)]">Q3 ka number</mark> kya laga?</> },
              { tag: 'S2', time: '00:00:09', text: <><span style={{ background: 'var(--cr-text-on-paper)', color: 'var(--cr-text-on-paper)', borderRadius: 2 }}>&#9608;&#9608;&#9608;&#9608;&#9608;&#9608;</span> up eleven percent.</> },
              { tag: 'S1', time: '00:00:14', text: <><mark className="rounded-[var(--cr-radius-sm)] px-[3px] bg-[var(--cr-yellow)] text-[var(--cr-yellow-ink)]">Bahut badhiya.</mark> Send me the deck?</> },
              { tag: 'S2', time: '00:00:19', text: 'Haan bhej deta hoon, aaj shaam tak.' }
            ].map((line, i, arr) => (
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
                <span
                  className="h-fit shrink-0 font-semibold"
                  style={{ background: 'var(--cr-text-on-paper)', color: 'var(--cr-paper)', fontSize: 10.5, padding: '2px 7px', borderRadius: 4 }}
                >
                  {line.tag}
                </span>
                <span className="shrink-0" style={{ color: 'var(--cr-text-paper-mut)' }}>{line.time}</span>
                <span>{line.text}</span>
              </div>
            ))}
            <div
              className="flex gap-[var(--cr-space-4)] font-mono"
              style={{ marginTop: 'var(--cr-space-4)', paddingTop: 'var(--cr-space-4)', borderTop: '1px solid var(--cr-paper-rule)', fontSize: 11, color: 'var(--cr-text-paper-mut)' }}
            >
              <span style={{ color: 'var(--cr-text-on-paper)', fontWeight: 600 }}>Nova-3</span>
              <span>$0.0071 / min</span>
              <span>mip_opt_out</span>
            </div>
          </div>
        </section>

        <section className="mx-auto px-6 pt-6 pb-20 text-center" style={{ maxWidth: 'var(--cr-measure)' }}>
          <h2 className="cr-reveal font-display uppercase" style={{ fontSize: 'clamp(24px, 3.4vw, var(--cr-type-h1))', fontWeight: 'var(--cr-weight-heavy)', marginBottom: 6 }}>
            Said once. Kept forever.
          </h2>
          <p className="cr-reveal" style={{ color: 'var(--cr-text-tertiary)', fontSize: 'var(--cr-type-sm)', maxWidth: 420, margin: '0 auto var(--cr-space-7)' }}>
            One long, impossible arm, the same voice, handed across, comes back as a written record.
          </p>
          <div className="cr-ribbon-wrap mx-auto" style={{ maxWidth: 1040 }}>
            <HandoffRibbon className="w-full" />
          </div>
        </section>

        <section className="mx-auto grid gap-6 px-6 pb-24 md:grid-cols-3" style={{ maxWidth: 'var(--cr-measure)' }}>
          {EXHIBITS.map((ex) => (
            <div
              key={ex.id}
              className="cr-reveal rounded-[var(--cr-radius-xl)] p-6"
              style={{ background: 'var(--cr-ink-raised)', border: '1px solid var(--cr-rule-soft)' }}
            >
              <div className="font-mono" style={{ fontSize: 10.5, letterSpacing: '0.12em', color: 'var(--cr-red-text)', marginBottom: 14 }}>
                EXHIBIT {ex.id}
              </div>
              <h3 className="font-display uppercase" style={{ fontSize: 'var(--cr-type-h3)', fontWeight: 'var(--cr-weight-heavy)', marginBottom: 10 }}>
                {ex.title}
              </h3>
              <p style={{ fontSize: 'var(--cr-type-sm)', lineHeight: 1.6, color: 'var(--cr-text-tertiary)', marginBottom: 16 }}>{ex.body}</p>
              {ex.sample && (
                <div
                  className="font-mono"
                  style={{ background: 'var(--cr-ink)', border: '1px solid var(--cr-rule-soft)', borderRadius: 8, padding: '12px 14px', fontSize: 12, color: 'var(--cr-text-secondary)' }}
                >
                  {ex.sample}
                </div>
              )}
              {ex.tags && (
                <div className="flex gap-1.5">
                  {ex.tags.map((t) => (
                    <span
                      key={t}
                      className="font-mono"
                      style={{ background: 'var(--cr-ink)', border: '1px solid var(--cr-rule-soft)', borderRadius: 999, padding: '5px 10px', fontSize: 11.5 }}
                    >
                      tag: {t}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>

        <footer
          className="mx-auto flex flex-wrap justify-between gap-3 px-6 pt-6 pb-14"
          style={{ maxWidth: 'var(--cr-measure)', borderTop: '1px solid var(--cr-rule-soft)', fontSize: 12.5, color: 'var(--cr-text-muted)' }}
        >
          <span>&copy; {PRODUCT_NAME}</span>
          <span>Every recording stays private to your account.</span>
        </footer>
      </div>
    </LandingMotion>
  );
}
