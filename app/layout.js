import './globals.css';
import { GeistSans } from 'geist/font/sans';
import { Big_Shoulders, IBM_Plex_Mono } from 'next/font/google';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';

// Three faces, three CSS variables, all self-hosted by next/font so there is
// no CDN request and no layout shift. "Big Shoulders Display" no longer
// exists as its own family on Google Fonts, it was folded into "Big
// Shoulders" as a variable font with an optical-size (opsz) axis, 10 to 72.
// Loading it variable and pinning opsz to 72 in globals.css (the
// .font-display rule) reproduces the old Display cut, since this brand
// only ever uses this face for headline-scale, uppercase text. Reflows the
// page measurably when it lands, which is why the marketing surfaces call
// ScrollTrigger.refresh() on document.fonts.ready.
const display = Big_Shoulders({
  subsets: ['latin'],
  weight: 'variable',
  variable: '--font-big-shoulders',
  display: 'swap'
});

const mono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-ibm-plex-mono',
  display: 'swap'
});

export const metadata = {
  title: 'Meeting Transcriber',
  description: 'Private, self-hosted meeting transcription with Deepgram.'
};

export default function RootLayout({ children }) {
  return (
    <html
      lang="en"
      className={`dark ${GeistSans.variable} ${display.variable} ${mono.variable}`}
    >
      <body className="min-h-screen bg-background text-foreground antialiased">
        {/* delay 400ms matches the locked tooltip open delay, --cr-dur-tooltip
            governs the fade-in itself once it opens. */}
        <TooltipProvider delay={400}>
          {children}
        </TooltipProvider>
        <Toaster position="top-center" />
      </body>
    </html>
  );
}
