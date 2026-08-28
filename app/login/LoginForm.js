'use client';

import { useActionState, useState } from 'react';
import { login } from '@/app/actions/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

const LABEL_CLASS = 'font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground';

export default function LoginForm() {
  const [state, formAction, pending] = useActionState(login, undefined);
  const [showPassword, setShowPassword] = useState(false);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email" className={LABEL_CLASS}>Email</Label>
        <Input id="email" name="email" type="email" placeholder="priya.bansal@northbeam.in" required autoComplete="email" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password" className={LABEL_CLASS}>Password</Label>
          <a href="/forgot-password" className="text-xs text-muted-foreground underline-offset-4 hover:underline">
            Forgot password?
          </a>
        </div>
        <div className="relative">
          <Input id="password" name="password" type={showPassword ? 'text' : 'password'} required autoComplete="current-password" className="pr-16" />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            className="absolute top-1/2 right-2.5 -translate-y-1/2 font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground transition-colors duration-[var(--cr-dur-hover)] ease-[var(--cr-ease-out)] hover:text-foreground"
          >
            {showPassword ? 'Hide' : 'Reveal'}
          </button>
        </div>
      </div>
      {state?.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" size="lg" className="w-full" disabled={pending} style={{ boxShadow: 'var(--cr-shadow-cta)' }}>
        {pending ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  );
}
