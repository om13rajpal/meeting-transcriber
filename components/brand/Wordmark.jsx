import { cn } from '@/lib/utils';

// Placeholder product name, carried from the Round 2 mockup. Not a proposed
// name. Swap this one string once a real name is picked, nothing else in
// the app needs to change since every consumer reads this constant.
export const PRODUCT_NAME = 'MEETING.TXT';
const BASE = 'MEETING';
const SUFFIX = 'TXT';

export default function Wordmark({ size = 'nav', onPaper = false, className }) {
  const px = size === 'app' ? 18 : 22;
  const dotColor = onPaper ? 'var(--cr-red-fill)' : 'var(--cr-red-text)';

  return (
    <span
      className={cn('font-display uppercase tracking-[var(--cr-tracking-display)]', className)}
      style={{ fontSize: px, fontWeight: 'var(--cr-weight-display)', lineHeight: 1 }}
    >
      {BASE}
      <span style={{ color: dotColor }}>.</span>
      {SUFFIX}
    </span>
  );
}
