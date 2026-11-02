import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import './globals.css';
import type { Metadata, Viewport } from 'next';

export const metadata: Metadata = {
  title: 'DART 2.0 – Registerplattform (Prototyp)',
  description: 'Lokaler Prototyp – ausschließlich synthetische Daten',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>
        <a href="#inhalt" className="skip-link">Zum Inhalt springen</a>
        {children}
      </body>
    </html>
  );
}
