import { redirect } from 'next/navigation';
import { getSessionUserId } from '@/app/lib/session';
import { oauthErrorMessage } from '@/app/lib/oauth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import OAuthButtons from '@/app/OAuthButtons';
import SignupForm from './SignupForm';

export const metadata = { title: 'Sign up - Meeting Transcriber' };

export default async function SignupPage({ searchParams }) {
  const userId = await getSessionUserId();
  if (userId) redirect('/');

  const { error } = await searchParams;
  const errorMessage = oauthErrorMessage(error);

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Sign up</CardTitle>
          <CardDescription>Create your private Meeting Transcriber account.</CardDescription>
        </CardHeader>
        <CardContent>
          <OAuthButtons />
          {errorMessage && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}
          <SignupForm />
          <p className="mt-6 text-center text-sm text-muted-foreground">
            Already have an account?{' '}
            <a href="/login" className="text-primary underline-offset-4 hover:underline">
              Log in
            </a>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
