import { redirect } from 'next/navigation';
import { getSessionUserId } from '@/app/lib/session';
import { oauthErrorMessage } from '@/app/lib/oauth';
import { Alert, AlertDescription } from '@/components/ui/alert';
import AuthShell from '@/components/brand/AuthShell';
import OAuthButtons from '@/app/OAuthButtons';
import SignupForm from './SignupForm';

export const metadata = { title: 'Sign up - Meeting Transcriber' };

export default async function SignupPage({ searchParams }) {
  const userId = await getSessionUserId();
  if (userId) redirect('/');

  const { error } = await searchParams;
  const errorMessage = oauthErrorMessage(error);

  return (
    <AuthShell
      side="ribbon"
      eyebrow="New file · Sign up"
      headline={['Say it once.', 'Keep it forever.']}
      lede="Upload the recording, walk away. It comes back split by speaker, timestamped, searchable, and yours alone."
      stats={['Free while you try it. No card', 'MP4 and MP3, up to 2 GB', 'Nova-3, about $0.43 an hour']}
      formEyebrow="Create account"
      formHeadline="Open a new file"
      formLede="One account, one private history. Sign up with Google or set a password below."
    >
      <OAuthButtons />
      {errorMessage && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{errorMessage}</AlertDescription>
        </Alert>
      )}
      <SignupForm />
      <p className="mt-5 text-sm text-muted-foreground">
        Already have a file?{' '}
        <a href="/login" className="font-semibold text-primary underline-offset-4 hover:underline">
          Sign in
        </a>
        .
      </p>
      <p className="mt-4 text-xs text-muted-foreground">
        Creating an account signs you in on this device only. Changing your password later signs out every other device.
      </p>
    </AuthShell>
  );
}
