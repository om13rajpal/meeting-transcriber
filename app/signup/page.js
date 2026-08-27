import { redirect } from 'next/navigation';
import { getSessionUserId } from '@/app/lib/session';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import SignupForm from './SignupForm';

export const metadata = { title: 'Sign up - Meeting Transcriber' };

export default async function SignupPage() {
  const userId = await getSessionUserId();
  if (userId) redirect('/');

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">Sign up</CardTitle>
          <CardDescription>Create your private Meeting Transcriber account.</CardDescription>
        </CardHeader>
        <CardContent>
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
