import { redirect } from 'next/navigation';
import { getSessionUserId } from '@/app/lib/session';
import AuthShell from '@/components/brand/AuthShell';
import ForgotPasswordForm from './ForgotPasswordForm';

export const metadata = { title: 'Forgot password - Meeting Transcriber' };

export default async function ForgotPasswordPage() {
  const userId = await getSessionUserId();
  if (userId) redirect('/');

  return (
    <AuthShell
      side="transcript"
      eyebrow="File 0142 · Recovery"
      headline={['Lost the', 'password, not the file.']}
      lede="Your meetings are still exactly where you left them. A reset link is all that stands between you and the transcript."
      stats={['1,284 meetings on record', 'Hinglish, 36 languages, one pass', 'Never used for model training']}
      formEyebrow="Recover access"
      formHeadline="Reset password"
      formLede="We'll email you a link to choose a new one. It works for one hour."
    >
      <ForgotPasswordForm />
      <p className="mt-5 text-sm text-muted-foreground">
        <a href="/login" className="font-semibold text-primary underline-offset-4 hover:underline">
          Back to sign in
        </a>
      </p>
    </AuthShell>
  );
}
