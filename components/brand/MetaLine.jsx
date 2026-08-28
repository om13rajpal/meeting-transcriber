import { cn } from '@/lib/utils';

// The mono line under a title: model, cost, duration, date. Individual
// values that need to stand out (the cost figure) pass their own className
// with text-[var(--cr-text-tertiary)]; the line's base color is the floor.
export default function MetaLine({ children, className, as: Component = 'div' }) {
  return (
    <Component
      className={cn('font-mono text-[var(--cr-text-muted)] flex items-center flex-wrap gap-x-[var(--cr-space-3)] gap-y-[var(--cr-space-1)]', className)}
      style={{ fontSize: 'var(--cr-type-meta)' }}
    >
      {children}
    </Component>
  );
}
