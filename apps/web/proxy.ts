import { NextRequest, NextResponse } from 'next/server';

/** Every document gets a fresh server-generated nonce, including prefetched routes. */
export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');
  const development = process.env.NODE_ENV !== 'production';
  let apiOrigin = "'self'";
  try { apiOrigin = new URL(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1').origin; } catch { /* Invalid API configuration must not widen browser access. */ }
  const policy = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self' ${apiOrigin}`,
    "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
    ...(development ? [] : ['upgrade-insecure-requests'])
  ].join('; ');
  const headers = new Headers(request.headers);
  // Ignore caller-supplied nonce/CSP headers. Next reads this trusted request policy.
  headers.set('x-nonce', nonce);
  headers.set('Content-Security-Policy', policy);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg|brand/).*)'] };
