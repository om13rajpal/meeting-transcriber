import { isProviderConfigured } from '@/app/lib/oauth';
import { Button } from '@/components/ui/button';

// Server Component: whether a button renders at all depends only on
// whether that provider's Client ID/Secret env vars are set, so an
// unconfigured provider simply doesn't show a button instead of showing
// one that would fail. No client-side branching needed.
export default function OAuthButtons() {
  const google = isProviderConfigured('google');
  const microsoft = isProviderConfigured('microsoft');
  if (!google && !microsoft) return null;

  return (
    <div className="mb-6 flex flex-col gap-3">
      {google && (
        <Button variant="outline" className="w-full" render={<a href="/api/auth/google" />} nativeButton={false}>
          Continue with Google
        </Button>
      )}
      {microsoft && (
        <Button variant="outline" className="w-full" render={<a href="/api/auth/microsoft" />} nativeButton={false}>
          Continue with Microsoft
        </Button>
      )}
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
