import type { NextConfig } from 'next';

const development = process.env.NODE_ENV !== 'production';

const config: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  transpilePackages: ['@zerochack/ui', '@zerochack/validation', '@zerochack/care'],
  allowedDevOrigins: ['127.0.0.1'],
  poweredByHeader: false,
  experimental: { sri: { algorithm: 'sha256' } },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      ...(development ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' }])
    ] }];
  }
};
export default config;
