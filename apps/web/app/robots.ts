import type { MetadataRoute } from 'next';

export default function robots(): MetadataRoute.Robots {
  const base = process.env.APP_URL ?? 'http://localhost:3000';
  return {
    rules: { userAgent: '*', allow: '/', disallow: ['/account', '/dashboard', '/sign-in', '/forgot-password', '/customer/', '/agency/', '/affiliate/', '/specialist/', '/owner/', '/mfa', '/reset-password', '/verify-email', '/approval-pending', '/suspended', '/deactivated', '/rejected'] },
    sitemap: `${base}/sitemap.xml`, host: base
  };
}
