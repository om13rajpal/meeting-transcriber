import { cn } from '@/lib/utils';

// default: any other speaker. self: the account owner, inverts to paper, a
// quiet nod to the printed record. unnamed: not yet renamed, dashed hairline.
const VARIANTS = {
  default: 'bg-[var(--cr-ink-raised)] border border-[var(--cr-rule-strong)] text-[var(--cr-text-secondary)]',
  self: 'bg-[var(--cr-paper-dim)] text-[var(--cr-text-on-paper)] border border-transparent',
  unnamed: 'border border-dashed border-[var(--cr-rule-strong)] text-[var(--cr-text-muted)]'
};

export default function SpeakerTag({ children, variant = 'default', className }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[var(--cr-radius-sm)] px-[6px] py-[2px] font-mono font-semibold uppercase',
        VARIANTS[variant] ?? VARIANTS.default,
        className
      )}
      style={{ fontSize: 'var(--cr-type-tiny)', letterSpacing: 'var(--cr-tracking-tag)' }}
    >
      {children}
    </span>
  );
}
