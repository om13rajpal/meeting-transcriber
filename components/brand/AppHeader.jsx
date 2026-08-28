import Link from 'next/link';
import Wordmark from './Wordmark';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

function initialsFor(email) {
  return (email || '?').slice(0, 2).toUpperCase();
}

// Shared app-weight header for every authenticated screen (Dashboard,
// MeetingDetail), so the transcript detail view uses the same chrome
// instead of its own breadcrumb bar. Wordmark left, avatar right, one
// hairline underneath. The avatar is a plain link to /settings rather than
// a dropdown menu, since account actions (password, webhooks, log out)
// live on that page now, not in a popup.
export default function AppHeader({ userEmail, avatarUrl, left, className }) {
  return (
    <header className={className} style={{ borderBottom: '1px solid var(--cr-rule-soft)' }}>
      <div
        className="mx-auto flex items-center justify-between gap-4 px-6 py-4"
        style={{ maxWidth: 'var(--cr-measure-app)' }}
      >
        <div className="flex min-w-0 items-center gap-4">
          <Link
            href="/"
            className="shrink-0 rounded-[var(--cr-radius-sm)] outline-none transition-transform duration-[var(--cr-dur-press)] ease-[var(--cr-ease-out)] focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[var(--cr-press-scale)]"
          >
            <Wordmark size="app" />
          </Link>
          {left}
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              <Link
                href="/settings"
                aria-label="Settings"
                className="rounded-full outline-none transition-transform duration-[var(--cr-dur-press)] ease-[var(--cr-ease-out)] focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-[var(--cr-press-scale)]"
              >
                <Avatar className="size-8 border border-[var(--cr-rule-strong)]" style={{ background: 'var(--cr-ink-raised)' }}>
                  {avatarUrl && <AvatarImage src={avatarUrl} alt="" referrerPolicy="no-referrer" />}
                  <AvatarFallback className="bg-transparent font-mono text-[11px]">
                    {initialsFor(userEmail)}
                  </AvatarFallback>
                </Avatar>
              </Link>
            }
          />
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
}
