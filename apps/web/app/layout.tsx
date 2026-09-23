import type { Metadata } from 'next';
import { ApplicationShell } from '../components/application-shell';
import { Providers } from './providers';
import './globals.css';
import '@fontsource/noto-sans-tamil/400.css';
import './care.css';

const siteUrl = process.env.APP_URL ?? 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: 'ZeroRoot | Website Security & Monitoring', template: '%s | ZeroRoot' },
  description: 'Protect websites with continuous security monitoring, vulnerability scanning, verified backups, actionable reports, and accountable expert remediation.',
  applicationName: 'ZeroRoot',
  generator: 'Next.js',
  authors: [{ name: 'ZeroRoot' }],
  creator: 'ZeroRoot',
  publisher: 'ZeroRoot',
  category: 'Cybersecurity',
  keywords: ['website security platform', 'cybersecurity platform', 'continuous website monitoring', 'website vulnerability scanner', 'secure website backups', 'website malware protection', 'expert security remediation', 'agency website security'],
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
    title: 'ZeroRoot | Website Security & Monitoring',
    description: 'Continuous monitoring, vulnerability scanning, verified backups, and accountable remediation for websites and agencies.',
    images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'ZeroRoot website security platform' }]
  },
  twitter: {
    card: 'summary_large_image',
    title: 'ZeroRoot | Website Security & Monitoring',
    description: 'Continuous monitoring, vulnerability scanning, verified backups, and accountable remediation for websites and agencies.',
    images: ['/opengraph-image']
  }
};
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en" data-scroll-behavior="smooth"><body><Providers><ApplicationShell>{children}</ApplicationShell></Providers></body></html>;
}
