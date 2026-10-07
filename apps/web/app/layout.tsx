import type { Metadata } from 'next';
import { connection } from 'next/server';
import { ApplicationShell } from '../components/application-shell';
import { Providers } from './providers';
import './globals.css';
import '@fontsource/noto-sans-tamil/400.css';
import './care.css';
import './home.css';
import './branding.css';

const siteUrl = process.env.APP_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'CodeBandage | AI Website, API & DevOps Care', template: '%s | CodeBandage' },
  description: 'AI-assisted care for websites, web apps, APIs, servers and DevOps. Source reviews, supported repairs, security guidance and specialist-led recovery.',
  applicationName: 'CodeBandage',
  generator: 'Next.js',
  authors: [{ name: 'CodeBandage' }],
  creator: 'CodeBandage',
  publisher: 'CodeBandage',
  category: 'Website care and cybersecurity',
  keywords: ['AI website redesign review', 'website repair', 'website security assessment', 'hacked website recovery', 'HTML repair', 'website source review', 'agency website care', 'DevOps troubleshooting', 'API source review', 'server configuration review'],
  alternates: { canonical: '/' },
  formatDetection: { email: false, address: false, telephone: false },
  referrer: 'origin-when-cross-origin',
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1, 'max-video-preview': -1 } },
  icons: { icon: [{ url: '/brand/favicon-32.png', sizes: '32x32', type: 'image/png' }, { url: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' }], shortcut: '/brand/favicon-32.png', apple: [{ url: '/brand/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }] },
  manifest: '/manifest.webmanifest',
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'CodeBandage',
    locale: 'en_US',
    title: 'CodeBandage | AI Website, API & DevOps Care',
    description: 'Website, app, API, server and DevOps reviews, supported repairs and security guidance, with you in control.',
    images: [{ url: '/opengraph-image.png', width: 1200, height: 630, alt: 'CodeBandage website security platform' }]
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CodeBandage | AI Website, API & DevOps Care',
    description: 'Website, app, API, server and DevOps reviews, supported repairs and security guidance, with you in control.',
    images: ['/opengraph-image.png']
  }
};
export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // Nonces must be bound to the current response, never to build-time HTML.
  await connection();
  return <html lang="en" data-scroll-behavior="smooth"><body><Providers><ApplicationShell>{children}</ApplicationShell></Providers></body></html>;
}
