import { cn } from '@/lib/utils';

// Yellow (Transcribing) and the tint reds/greens are the only places status
// color appears on product surfaces. See app/globals.css, the surface split.
const VARIANTS = {
  complete: { label: 'Complete', tint: 'var(--cr-tint-green)', text: 'var(--cr-success)' },
  processing: { label: 'Transcribing', tint: 'var(--cr-tint-yellow)', text: 'var(--cr-yellow)' },
  failed: { label: 'Failed', tint: 'var(--cr-tint-red)', text: 'var(--cr-danger)' }
};

export default function StatusPill({ status, className }) {
  const v = VARIANTS[status] ?? VARIANTS.complete;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-[6px] rounded-[var(--cr-radius-pill)] px-[9px] py-[4px] font-mono font-semibold uppercase',
        className
      )}
      style={{
        background: v.tint,
        color: v.text,
        fontSize: 'var(--cr-type-tiny)',
        letterSpacing: 'var(--cr-tracking-tag)'
      }}
    >
      {status === 'processing' && (
        <span
          aria-hidden="true"
          className="size-[6px] rounded-full animate-[cr-pulse_1.1s_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:opacity-80"
          style={{ background: v.text }}
        />
      )}
      {v.label}
    </span>
  );
}
