import type { Metadata } from 'next';
import { ApplicationShell } from '../components/application-shell';
import { Providers } from './providers';
import './globals.css';
import '@fontsource/noto-sans-tamil/400.css';
import './care.css';
import './home.css';

const siteUrl = process.env.APP_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'ZeroRoot | AI Website, API & DevOps Care', template: '%s | ZeroRoot' },
  description: 'AI-assisted care for websites, web apps, APIs, servers and DevOps. Source reviews, supported repairs, security guidance and specialist-led recovery.',
  applicationName: 'ZeroRoot',
  generator: 'Next.js',
  authors: [{ name: 'ZeroRoot' }],
  creator: 'ZeroRoot',
  publisher: 'ZeroRoot',
  category: 'Website care and cybersecurity',
  keywords: ['AI website redesign review', 'website repair', 'website security assessment', 'hacked website recovery', 'HTML repair', 'website source review', 'agency website care', 'DevOps troubleshooting', 'API source review', 'server configuration review'],
  alternates: { canonical: '/' },
  formatDetection: { email: false, address: false, telephone: false },
  referrer: 'origin-when-cross-origin',
  robots: { index: true, follow: true, googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1, 'max-video-preview': -1 } },
  icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }], shortcut: '/icon.svg' },
  manifest: '/manifest.webmanifest',
  openGraph: {
    type: 'website',
    url: '/',
    siteName: 'ZeroRoot',
    locale: 'en_US',
    title: 'ZeroRoot | AI Website, API & DevOps Care',
    description: 'Website, app, API, server and DevOps reviews, supported repairs and security guidance, with you in control.',
    images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'ZeroRoot website security platform' }]
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ZeroRoot | AI Website, API & DevOps Care',
    description: 'Website, app, API, server and DevOps reviews, supported repairs and security guidance, with you in control.',
    images: ['/opengraph-image']
  }
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-scroll-behavior="smooth"><body><Providers><ApplicationShell>{children}</ApplicationShell></Providers></body></html>;
}
