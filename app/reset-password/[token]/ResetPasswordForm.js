'use client';

import { useActionState } from 'react';
import { resetPassword } from '@/app/actions/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function ResetPasswordForm({ token }) {
  const [state, formAction, pending] = useActionState(resetPassword, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="password" className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">New password</Label>
        <Input id="password" name="password" type="password" required autoComplete="new-password" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirmPassword" className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Confirm new password</Label>
        <Input id="confirmPassword" name="confirmPassword" type="password" required autoComplete="new-password" />
      </div>
      {state?.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" size="lg" className="w-full" disabled={pending} style={{ boxShadow: 'var(--cr-shadow-cta)' }}>
        {pending ? 'Resetting…' : 'Reset password'}
      </Button>
    </form>
  );
}
