import { cn } from '@/lib/utils';

export default function Eyebrow({ children, className, ...props }) {
  return (
    <div
      className={cn('font-mono uppercase text-[var(--cr-text-muted)]', className)}
      style={{
        fontSize: 'var(--cr-type-mono)',
        letterSpacing: 'var(--cr-tracking-eyebrow)'
      }}
      {...props}
    >
      {children}
    </div>
  );
}
