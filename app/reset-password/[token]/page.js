import { redirect } from 'next/navigation';
import { getSessionUserId } from '@/app/lib/session';
import { connectToDatabase } from '@/app/lib/db';
import PasswordResetToken from '@/app/lib/models/PasswordResetToken';
import { Button } from '@/components/ui/button';
import AuthShell from '@/components/brand/AuthShell';
import ResetPasswordForm from './ResetPasswordForm';

export const metadata = { title: 'Reset password - Meeting Transcriber' };

export default async function ResetPasswordPage({ params }) {
  const { token } = await params;
  const userId = await getSessionUserId();
  if (userId) redirect('/');

  // A read-only existence check, purely so an invalid/expired link says so
  // immediately instead of only after submitting a new password. The
  // actual consume-and-verify (findByIdAndDelete) still happens in
  // resetPassword() itself - this is just a friendlier upfront look.
  await connectToDatabase();
  const valid = await PasswordResetToken.exists({ _id: token });

  return (
    <AuthShell
      side="transcript"
      eyebrow="File 0142 · Recovery"
      headline={['Choose a', 'new password.']}
      lede="One more step and you're back in. Every other device gets signed out once this is set, in case this reset was not you."
      stats={['1,284 meetings on record', 'Hinglish, 36 languages, one pass', 'Never used for model training']}
      formEyebrow="Recover access"
      formHeadline="Reset password"
      formLede={valid ? 'Choose a new password for your account.' : 'This reset link is invalid or has expired.'}
    >
      {valid ? (
        <ResetPasswordForm token={token} />
      ) : (
        <Button render={<a href="/forgot-password" />} nativeButton={false} size="lg" style={{ boxShadow: 'var(--cr-shadow-cta)' }}>
          Request a new link
        </Button>
      )}
    </AuthShell>
  );
}
