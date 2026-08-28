import { cn } from '@/lib/utils';

// The transcript's left column. A fixed mono timestamp gutter with a
// hairline on its right edge, stretched to the full row height so
// consecutive utterance rows read as one continuous rail, not stacked cards.
export default function TimeRail({ children, className }) {
  return (
    <div
      className={cn(
        'w-[74px] shrink-0 border-r border-[var(--cr-rule-soft)] pr-[var(--cr-space-3)] font-mono text-[var(--cr-text-muted)]',
        className
      )}
      style={{ fontSize: 'var(--cr-type-meta)' }}
    >
      {children}
    </div>
  );
}
