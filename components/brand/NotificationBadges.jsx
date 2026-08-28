'use client';

import { RotateCw, Loader2 } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// A compact icon badge per notification channel, replacing a spelled-out
// "Email: not sent yet" text line. The real status (when, ok or not) lives
// in the tooltip, not the page, so this reads as one small cluster next to
// the action buttons instead of its own orphaned row. Same three-state
// color language as StatusPill (muted/success/danger), so a failed
// notification and a failed meeting look like the same kind of fact.
function ChannelBadge({ icon: Icon, label, attemptedAt, ok }) {
  const state = !attemptedAt ? 'pending' : ok ? 'ok' : 'failed';
  const tone = {
    pending: { bg: 'var(--cr-ink-hover)', color: 'var(--cr-text-muted)' },
    ok: { bg: 'var(--cr-tint-green)', color: 'var(--cr-success)' },
    failed: { bg: 'var(--cr-tint-red)', color: 'var(--cr-danger)' }
  }[state];
  const detail = state === 'pending' ? `${label}, not sent yet` : state === 'ok' ? `${label}, delivered` : `${label}, failed`;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            tabIndex={0}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full outline-none transition-transform duration-[var(--cr-dur-press)] ease-[var(--cr-ease-out)] focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[var(--cr-press-scale)]"
            style={{ background: tone.bg, color: tone.color }}
          >
            <Icon className="size-3.5" />
            <span className="sr-only">{detail}</span>
          </button>
        }
      />
      <TooltipContent>{detail}</TooltipContent>
    </Tooltip>
  );
}

export default function NotificationBadges({ items, onResend, resending, className }) {
  if (!items || items.length === 0) return null;

  return (
    <div className={cn('flex shrink-0 items-center gap-1.5', className)}>
      {items.map((item, i) => (
        <ChannelBadge key={i} {...item} />
      ))}
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={onResend}
              disabled={resending}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none transition-transform duration-[var(--cr-dur-press)] ease-[var(--cr-ease-out)] hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[var(--cr-press-scale)] disabled:opacity-50"
            >
              {resending ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCw className="size-3.5" />}
              <span className="sr-only">Resend notifications</span>
            </button>
          }
        />
        <TooltipContent>Resend notifications</TooltipContent>
      </Tooltip>
    </div>
  );
}
