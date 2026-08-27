import { isGoogleConfigured } from '@/app/lib/oauth';
import { Button } from '@/components/ui/button';

// Server Component: whether the button renders at all depends only on
// whether GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are set, so an
// unconfigured deployment simply doesn't show a button instead of showing
// one that would fail. No client-side branching needed.
export default function OAuthButtons() {
  if (!isGoogleConfigured()) return null;

  return (
    <div className="mb-6 flex flex-col gap-3">
      <Button variant="outline" className="w-full" render={<a href="/api/auth/google" />} nativeButton={false}>
        Continue with Google
      </Button>
      <div className="relative py-1">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-2 text-muted-foreground">Or</span>
        </div>
      </div>
    </div>
  );
}
