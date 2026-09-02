'use client';

import { useActionState, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Plus, X, Loader2, LogOut, KeyRound, Webhook as WebhookIcon, User, ChevronRight, Laptop, Copy, Check } from 'lucide-react';
import { logout, updatePassword } from '@/app/actions/auth';
import { saveWebhooks, createApiKey, revokeApiKey } from '@/app/actions/settings';
import AppHeader from '@/components/brand/AppHeader';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

function initialsFor(email) {
  return (email || '?').slice(0, 2).toUpperCase();
}

const WEBHOOK_FORMATS = [
  { value: 'generic', label: 'Generic JSON' },
  { value: 'discord', label: 'Discord' },
  { value: 'slack', label: 'Slack' },
  { value: 'teams', label: 'Microsoft Teams' }
];
const EMPTY_WEBHOOK = { url: '', format: 'generic' };
const LABEL_CLASS = 'font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground';

const SECTIONS = [
  { id: 'account', label: 'Account', icon: User },
  { id: 'password', label: 'Password', icon: KeyRound },
  { id: 'webhooks', label: 'Webhooks', icon: WebhookIcon },
  { id: 'api-keys', label: 'API Keys', icon: Laptop }
];

function SectionNav({ active, onSelect }) {
  return (
    <nav className="flex shrink-0 flex-col gap-1" style={{ width: 200 }}>
      {SECTIONS.map((s) => {
        const Icon = s.icon;
        const isActive = active === s.id;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            className={cn(
              'flex items-center gap-2.5 rounded-[var(--cr-radius-md)] px-3 py-2.5 text-left text-sm transition-colors duration-[var(--cr-dur-hover)] ease-[var(--cr-ease-out)]',
              isActive ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
            style={{ background: isActive ? 'var(--cr-ink-raised)' : 'transparent', border: `1px solid ${isActive ? 'var(--cr-rule-strong)' : 'transparent'}` }}
          >
            <Icon className="size-4 shrink-0" />
            <span className="flex-1">{s.label}</span>
            {isActive && <ChevronRight className="size-3.5 shrink-0" style={{ color: 'var(--cr-red-text)' }} />}
          </button>
        );
      })}
    </nav>
  );
}

function AccountSection({ userEmail, avatarUrl, hasGoogle, hasPassword, onLogout }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
        <CardDescription>Who you are, and how you signed in.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-4">
        <Avatar className="size-14 border border-[var(--cr-rule-strong)]" style={{ background: 'var(--cr-ink-raised)' }}>
          {avatarUrl && <AvatarImage src={avatarUrl} alt="" referrerPolicy="no-referrer" />}
          <AvatarFallback className="bg-transparent font-mono text-base">{initialsFor(userEmail)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{userEmail}</div>
          <div className="mt-1.5 flex items-center gap-2">
            {hasGoogle && <Badge variant="secondary">Signed in with Google</Badge>}
            {hasPassword && <Badge variant="secondary">Password set</Badge>}
          </div>
        </div>
      </CardContent>
      <CardFooter>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="outline" size="sm" onClick={onLogout}>
                <LogOut /> Log out
              </Button>
            }
          />
          <TooltipContent>Sign out of this device</TooltipContent>
        </Tooltip>
      </CardFooter>
    </Card>
  );
}

function PasswordSection({ hasPassword }) {
  const [state, formAction, pending] = useActionState(updatePassword, undefined);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{hasPassword ? 'Update password' : 'Set a password'}</CardTitle>
        <CardDescription>
          {hasPassword
            ? 'Changing your password signs out every other device you are logged in on.'
            : 'You signed up with Google. Set a password to also sign in with email, or if you ever lose access to that Google account.'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-4">
          {hasPassword && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="currentPassword" className={LABEL_CLASS}>Current password</Label>
              <Input id="currentPassword" name="currentPassword" type="password" required autoComplete="current-password" />
            </div>
          )}
          <div className="flex flex-col gap-2">
            <Label htmlFor="password" className={LABEL_CLASS}>New password</Label>
            <Input id="password" name="password" type="password" required minLength={8} autoComplete="new-password" />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword" className={LABEL_CLASS}>Confirm new password</Label>
            <Input id="confirmPassword" name="confirmPassword" type="password" required minLength={8} autoComplete="new-password" />
          </div>
          {state?.error && <p className="text-sm" style={{ color: 'var(--cr-danger)' }}>{state.error}</p>}
          {state?.message && <p className="text-sm" style={{ color: 'var(--cr-success)' }}>{state.message}</p>}
          <Button type="submit" disabled={pending} className="self-start">
            {pending && <Loader2 className="animate-spin" />}
            {hasPassword ? 'Update password' : 'Set password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

function WebhooksSection({ initialWebhooks }) {
  const [webhooks, setWebhooks] = useState(initialWebhooks.length ? initialWebhooks : [{ ...EMPTY_WEBHOOK }]);
  const [saving, setSaving] = useState(false);

  function updateField(index, field, value) {
    setWebhooks((prev) => prev.map((w, i) => (i === index ? { ...w, [field]: value } : w)));
  }
  function addRow() {
    setWebhooks((prev) => [...prev, { ...EMPTY_WEBHOOK }]);
  }
  function removeRow(index) {
    setWebhooks((prev) => prev.filter((_, i) => i !== index));
  }
  async function handleSave() {
    setSaving(true);
    try {
      const result = await saveWebhooks(webhooks);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      toast.success('Webhooks saved.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhooks</CardTitle>
        <CardDescription>
          When a meeting finishes or fails, the transcript is sent to each URL below. Pick a format to match
          where it&apos;s going, Discord and Slack post a readable message, Microsoft Teams posts a card (via
          a Workflows webhook), and Generic JSON sends the full raw data for your own automation.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          {webhooks.map((webhook, index) => (
            <div key={index} className="flex items-center gap-2">
              <Input
                type="url"
                placeholder="https://..."
                value={webhook.url}
                onChange={(e) => updateField(index, 'url', e.target.value)}
                className="flex-1"
              />
              <Select value={webhook.format} onValueChange={(value) => updateField(index, 'format', value)}>
                <SelectTrigger className="w-40 shrink-0">
                  <SelectValue>
                    {(value) => WEBHOOK_FORMATS.find((f) => f.value === value)?.label || value}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {WEBHOOK_FORMATS.map((f) => (
                    <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground hover:text-destructive" onClick={() => removeRow(index)}>
                      <X />
                      <span className="sr-only">Remove</span>
                    </Button>
                  }
                />
                <TooltipContent>Remove webhook</TooltipContent>
              </Tooltip>
            </div>
          ))}
          <Button variant="outline" size="sm" className="self-start" onClick={addRow}>
            <Plus /> Add webhook
          </Button>
        </div>
      </CardContent>
      <CardFooter>
        <Button onClick={handleSave} disabled={saving}>
          {saving && <Loader2 className="animate-spin" />}
          Save webhooks
        </Button>
      </CardFooter>
    </Card>
  );
}

function formatRelativeDate(value) {
  if (!value) return 'Never used';
  const date = new Date(value);
  return `Last used ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}

// A freshly-created key's row (see handleCreate below) carries a local-only
// placeholder id, not the real database _id - revokeApiKey() would throw a
// Mongoose CastError against it. Revoke stays disabled for that row until a
// reload swaps it for the real id from listApiKeys().
function isPendingKey(id) {
  return id.startsWith('pending-');
}

function ApiKeysSection({ initialKeys }) {
  const [keys, setKeys] = useState(initialKeys);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [newRawKey, setNewRawKey] = useState(null);
  const [copied, setCopied] = useState(false);

  async function handleCreate() {
    setCreating(true);
    try {
      const result = await createApiKey(label);
      if (result.error) {
        toast.error(result.error);
        return;
      }
      setNewRawKey(result.rawKey);
      // createApiKey() doesn't return a real database id (see app/actions/settings.js),
      // so this row is a local-only placeholder until the next page load/refresh
      // picks up the real one from listApiKeys(). A unique per-create id (rather
      // than a shared literal 'pending') avoids a React key collision if the user
      // creates a second key before reloading; isPendingKey() below is what
      // actually keeps Revoke from ever being called against this fake id.
      setKeys((prev) => [{ id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`, label: result.label, createdAt: new Date().toISOString(), lastUsedAt: null }, ...prev]);
      setLabel('');
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id) {
    await revokeApiKey(id);
    setKeys((prev) => prev.filter((k) => k.id !== id));
    toast.success('API key revoked.');
  }

  async function handleCopy() {
    await navigator.clipboard.writeText(newRawKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>API Keys</CardTitle>
        <CardDescription>
          Used by the desktop app and Chrome extension to upload recordings without you logging in
          separately on each device. Each key can start transcription jobs on your behalf, nothing more.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {newRawKey && (
          <div
            className="flex flex-col gap-2 rounded-[var(--cr-radius-md)] p-3"
            style={{ background: 'var(--cr-ink-raised)', border: '1px solid var(--cr-rule-strong)' }}
          >
            <p className="text-sm font-medium">Copy this key now — it won&apos;t be shown again.</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded bg-black/20 px-2 py-1.5 font-mono text-xs">{newRawKey}</code>
              <Button variant="outline" size="icon-sm" onClick={handleCopy}>
                {copied ? <Check /> : <Copy />}
                <span className="sr-only">Copy</span>
              </Button>
            </div>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Input
            placeholder='Label, e.g. "MacBook Pro"'
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button onClick={handleCreate} disabled={creating} className="shrink-0">
            {creating && <Loader2 className="animate-spin" />}
            <Plus /> New key
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          {keys.length === 0 && <p className="text-sm text-muted-foreground">No API keys yet.</p>}
          {keys.map((key) => {
            const pending = isPendingKey(key.id);
            return (
              <div key={key.id} className="flex items-center gap-3 rounded-[var(--cr-radius-md)] border border-[var(--cr-rule-strong)] px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{key.label}</div>
                  <div className="text-xs text-muted-foreground">{formatRelativeDate(key.lastUsedAt)}</div>
                </div>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="shrink-0 text-muted-foreground hover:text-destructive"
                        disabled={pending}
                        onClick={() => handleRevoke(key.id)}
                      >
                        <X />
                        <span className="sr-only">Revoke</span>
                      </Button>
                    }
                  />
                  <TooltipContent>{pending ? 'Refresh the page to manage this key' : 'Revoke this key'}</TooltipContent>
                </Tooltip>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsView({ userEmail, avatarUrl, hasGoogle, hasPassword, initialWebhooks, initialApiKeys }) {
  const [, startLogoutTransition] = useTransition();
  const [active, setActive] = useState('account');

  function handleLogout() {
    startLogoutTransition(() => {
      logout();
    });
  }

  return (
    <div className="min-h-screen" style={{ background: 'var(--cr-ink-app)' }}>
      <AppHeader userEmail={userEmail} avatarUrl={avatarUrl} />

      <main className="mx-auto px-6 py-8" style={{ maxWidth: 'var(--cr-measure-app)' }}>
        <h1 className="font-display mb-6 uppercase" style={{ fontSize: 'var(--cr-type-h2)', fontWeight: 'var(--cr-weight-heavy)' }}>
          Settings
        </h1>

        <div className="flex flex-col gap-8 md:flex-row">
          <SectionNav active={active} onSelect={setActive} />

          <div className="min-w-0 flex-1" style={{ maxWidth: 560 }}>
            {active === 'account' && (
              <AccountSection userEmail={userEmail} avatarUrl={avatarUrl} hasGoogle={hasGoogle} hasPassword={hasPassword} onLogout={handleLogout} />
            )}
            {active === 'password' && <PasswordSection hasPassword={hasPassword} />}
            {active === 'webhooks' && <WebhooksSection initialWebhooks={initialWebhooks} />}
            {active === 'api-keys' && <ApiKeysSection initialKeys={initialApiKeys} />}
          </div>
        </div>
      </main>
    </div>
  );
}
