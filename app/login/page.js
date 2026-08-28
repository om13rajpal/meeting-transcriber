import { redirect } from 'next/navigation';
import { getSessionUserId } from '@/app/lib/session';
import { oauthErrorMessage } from '@/app/lib/oauth';
import { Alert, AlertDescription } from '@/components/ui/alert';
import AuthShell from '@/components/brand/AuthShell';
import OAuthButtons from '@/app/OAuthButtons';
import LoginForm from './LoginForm';

export const metadata = { title: 'Log in - Meeting Transcriber' };

export default async function LoginPage({ searchParams }) {
  const userId = await getSessionUserId();
  if (userId) redirect('/');

  const { error } = await searchParams;
  const errorMessage = oauthErrorMessage(error);

  return (
    <AuthShell
      side="transcript"
      eyebrow="File 0142 · Sign in"
      headline={['Back on', 'the record.']}
      lede="Your meetings are exactly where you left them. Sign in to reopen the file, rename a speaker, or pull the transcript out."
      stats={['1,284 meetings on record', 'Hinglish, 36 languages, one pass', 'Never used for model training']}
      formEyebrow="Sign in"
      formHeadline="Open your file"
      formLede="Email and password. That is the whole list. We do not ask for a phone number and there is nothing else to connect."
    >
      <OAuthButtons />
      {errorMessage && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}
      <LoginForm />
      <p className="mt-5 text-sm text-muted-foreground">
        New here?{' '}
        <a href="/signup" className="font-semibold text-primary underline-offset-4 hover:underline">
          Create an account
        </a>
        . It takes about twenty seconds.
      </p>
      <p className="mt-4 text-xs text-muted-foreground">
        Your recordings stay private to your account. Deepgram requests are sent with{' '}
        <span className="font-mono" style={{ color: 'var(--cr-text-tertiary)' }}>mip_opt_out</span>, so nothing you say trains a model.
      </p>
    </AuthShell>
  );
}
