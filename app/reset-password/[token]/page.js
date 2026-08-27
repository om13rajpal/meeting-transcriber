import { redirect } from 'next/navigation';
import { getSessionUserId } from '@/app/lib/session';
import { connectToDatabase } from '@/app/lib/db';
import PasswordResetToken from '@/app/lib/models/PasswordResetToken';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
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
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Reset password</CardTitle>
          <CardDescription>Choose a new password for your account.</CardDescription>
        </CardHeader>
        <CardContent>
          {valid ? (
            <ResetPasswordForm token={token} />
          ) : (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                This reset link is invalid or has expired.
              </p>
              <Button render={<a href="/forgot-password" />} nativeButton={false}>
                Request a new link
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
