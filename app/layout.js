import './globals.css';
import { Toaster } from '@/components/ui/sonner';

export const metadata = {
  title: 'Meeting Transcriber',
  description: 'Private, self-hosted meeting transcription with Deepgram.'
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-background text-foreground antialiased">
        {children}
        <Toaster position="top-center" />
      </body>
    </html>
  );
}
