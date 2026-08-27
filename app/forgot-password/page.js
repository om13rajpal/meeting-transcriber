import { redirect } from 'next/navigation';
import { getSessionUserId } from '@/app/lib/session';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import ForgotPasswordForm from './ForgotPasswordForm';

export const metadata = { title: 'Forgot password - Meeting Transcriber' };

export default async function ForgotPasswordPage() {
  const userId = await getSessionUserId();
  if (userId) redirect('/');

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Forgot password</CardTitle>
          <CardDescription>We&apos;ll email you a link to reset it.</CardDescription>
        </CardHeader>
        <CardContent>
          <ForgotPasswordForm />
          <p className="mt-6 text-center text-sm text-muted-foreground">
            <a href="/login" className="text-primary underline-offset-4 hover:underline">
              Back to log in
            </a>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
