'use client';

import { useActionState } from 'react';
import { requestPasswordReset } from '@/app/actions/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

export default function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(requestPasswordReset, undefined);

  if (state?.message) {
    return (
      <Alert>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email" className="font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground">Email</Label>
        <Input id="email" name="email" type="email" required autoComplete="email" />
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={pending} style={{ boxShadow: 'var(--cr-shadow-cta)' }}>
        {pending ? 'Sending…' : 'Send reset link'}
      </Button>
    </form>
  );
}
