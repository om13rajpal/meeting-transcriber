'use client';

import { useActionState, useState } from 'react';
import { signup } from '@/app/actions/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';

const LABEL_CLASS = 'font-mono text-[11px] uppercase tracking-[0.08em] text-muted-foreground';

async function signupWithConfirmCheck(prevState, formData) {
  const password = formData.get('password');
  const confirm = formData.get('confirm');
  if (password !== confirm) {
    return { error: 'Passwords do not match.' };
  }
  return signup(prevState, formData);
}

function PasswordField({ id, name, label, placeholder, autoComplete, hint }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className={LABEL_CLASS}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          placeholder={placeholder}
          required
          minLength={8}
          autoComplete={autoComplete}
          className="pr-16"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute top-1/2 right-2.5 -translate-y-1/2 font-mono text-[10.5px] uppercase tracking-wide text-muted-foreground transition-colors duration-[var(--cr-dur-hover)] ease-[var(--cr-ease-out)] hover:text-foreground"
        >
          {visible ? 'Hide' : 'Reveal'}
        </button>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function SignupForm() {
  const [state, formAction, pending] = useActionState(signupWithConfirmCheck, undefined);

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="email" className={LABEL_CLASS}>Email</Label>
        <Input id="email" name="email" type="email" placeholder="aanya.iyer@northbeam.in" required autoComplete="email" />
      </div>
      <PasswordField
        id="password"
        name="password"
        label="Password"
        placeholder="At least 8 characters"
        autoComplete="new-password"
        hint="8 characters minimum. A passphrase beats a puzzle."
      />
      <PasswordField
        id="confirm"
        name="confirm"
        label="Confirm password"
        placeholder="Type it once more"
        autoComplete="new-password"
      />
      {state?.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <Button type="submit" size="lg" className="w-full" disabled={pending} style={{ boxShadow: 'var(--cr-shadow-cta)' }}>
        {pending ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  );
}
