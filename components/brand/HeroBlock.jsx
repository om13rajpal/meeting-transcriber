import { cn } from '@/lib/utils';

// Marketing only. The structural top and bottom paper hairline that frames
// the landing hero and the stat triplet, a print-system device rather than
// a card. Never used on product surfaces, see the surface split.
export default function HeroBlock({ children, className }) {
  return (
    <div
      className={cn('py-[var(--cr-space-6)]', className)}
      style={{
        borderTop: '1px solid color-mix(in oklab, var(--cr-paper) 18%, transparent)',
        borderBottom: '1px solid color-mix(in oklab, var(--cr-paper) 18%, transparent)'
      }}
    >
      {children}
    </div>
  );
}
