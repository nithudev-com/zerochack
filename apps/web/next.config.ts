import type { NextConfig } from 'next';

const development = process.env.NODE_ENV !== 'production';
let apiOrigin = "'self'";
try { apiOrigin = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1').origin; } catch { /* Environment validation fails in the API; keep the browser closed to unknown origins. */ }
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self'${development ? " 'unsafe-eval' 'unsafe-inline'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self'",
  `connect-src 'self' ${apiOrigin}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  ...(development ? [] : ['upgrade-insecure-requests'])
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  transpilePackages: ['@zerochack/ui', '@zerochack/validation'],
  allowedDevOrigins: ['127.0.0.1'],
  poweredByHeader: false,
  experimental: { sri: { algorithm: 'sha256' } },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'Content-Security-Policy', value: contentSecurityPolicy },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      ...(development ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }])
    ] }];
  }
};
export default config;
