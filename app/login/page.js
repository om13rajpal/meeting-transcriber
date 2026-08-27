import { redirect } from 'next/navigation';
import { getSessionUserId } from '@/app/lib/session';
import { oauthErrorMessage } from '@/app/lib/oauth';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import OAuthButtons from '@/app/OAuthButtons';
import LoginForm from './LoginForm';

export const metadata = { title: 'Log in - Meeting Transcriber' };

export default async function LoginPage({ searchParams }) {
  const userId = await getSessionUserId();
  if (userId) redirect('/');

  const { error } = await searchParams;
  const errorMessage = oauthErrorMessage(error);

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Log in</CardTitle>
          <CardDescription>Welcome back to Meeting Transcriber.</CardDescription>
        </CardHeader>
        <CardContent>
          <OAuthButtons />
          {errorMessage && (
            <Alert variant="destructive" className="mb-4">
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}
          <LoginForm />
          <p className="mt-6 text-center text-sm text-muted-foreground">
            Don&apos;t have an account?{' '}
            <a href="/signup" className="text-primary underline-offset-4 hover:underline">
              Sign up
            </a>
          </p>
        </CardContent>
      </Card>
    </main>
  );
}
