import { isGoogleConfigured } from '@/app/lib/oauth';
import { Button } from '@/components/ui/button';

// Google's real four-color "G" mark, official brand paths. A text-only
// button read as generic and untrustworthy right next to a real identity
// provider's name, the mark is what makes it recognizable at a glance.
function GoogleIcon(props) {
  return (
    <svg viewBox="0 0 18 18" aria-hidden="true" {...props}>
      <path fill="#4285F4" d="M17.64 9.2045c0-.6381-.0573-1.2518-.1636-1.8409H9v3.4814h4.8436c-.2086 1.125-.8427 2.0782-1.7959 2.7164v2.2581h2.9087c1.7018-1.5668 2.6836-3.874 2.6836-6.615z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.4673-.806 5.9564-2.1805l-2.9087-2.2581c-.8059.5401-1.8368.8591-3.0477.8591-2.3436 0-4.3282-1.5831-5.0359-3.7104H.9573v2.3318C2.4382 15.9832 5.4818 18 9 18z" />
      <path fill="#FBBC05" d="M3.9641 10.71c-.18-.5401-.2822-1.1168-.2822-1.71s.1023-1.1699.2822-1.71V4.9582H.9573C.3477 6.1732 0 7.5477 0 9s.3477 2.8268.9573 4.0418L3.9641 10.71z" />
      <path fill="#EA4335" d="M9 3.5795c1.3214 0 2.5077.4541 3.4405 1.346l2.5813-2.5814C13.4632.8918 11.4259 0 9 0 5.4818 0 2.4382 2.0168.9573 4.9582L3.9641 7.29C4.6718 5.1627 6.6564 3.5795 9 3.5795z" />
    </svg>
  );
}

// Server Component: whether the button renders at all depends only on
// whether GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are set, so an
// unconfigured deployment simply doesn't show a button instead of showing
// one that would fail. No client-side branching needed.
export default function OAuthButtons() {
  if (!isGoogleConfigured()) return null;

  return (
    <div className="mb-6 flex flex-col gap-3">
      <Button variant="outline" className="w-full" render={<a href="/api/auth/google" />} nativeButton={false}>
        <GoogleIcon className="size-4" data-icon="inline-start" />
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
