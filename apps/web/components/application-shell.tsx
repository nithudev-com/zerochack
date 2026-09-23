'use client';
import type { ReactNode } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

function BrandLogo({ priority = false }: { priority?: boolean }) {
  return <Image className="brand-logo" src="/brand/zeroroot-logo.webp" width={900} height={450} sizes="(max-width: 672px) 112px, 152px" alt="ZeroRoot Cyber Security Solution" loading={priority ? 'eager' : 'lazy'} fetchPriority={priority ? 'high' : 'auto'} />;
}

export function ApplicationShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const marketing = pathname === '/';
  const careWorkspace = /^\/customer\/websites\/[^/]+$/.test(pathname);
  const publicAuth = pathname.endsWith('/login') || pathname.endsWith('/register') || ['/sign-in', '/forgot-password', '/reset-password', '/verify-email', '/mfa', '/approval-pending', '/rejected', '/suspended', '/deactivated'].includes(pathname);
  return <div className={`app-shell${marketing ? ' app-shell--marketing' : ''}${careWorkspace ? ' app-shell--care' : ''}`}>
    <header className="app-header">
      <Link className="brand brand--image" href="/" aria-label="ZeroRoot home"><BrandLogo priority /></Link>
      {marketing ? <><nav aria-label="Primary navigation"><a href="#security">Security</a><a href="#platform">Platform</a><a href="#portals">Portals</a><a href="#faq">FAQ</a></nav><div className="header-actions"><Link className="header-login" href="/sign-in">Sign in</Link><Link className="header-cta" href="/customer/register">Get protected <span aria-hidden="true">→</span></Link></div></> : publicAuth ? <nav aria-label="Public navigation"><Link href="/">Home</Link></nav> : <nav aria-label="Primary navigation"><Link href="/">Home</Link><Link href="/dashboard">Dashboard</Link><Link href="/account">Sessions</Link><a href="http://localhost:4000/docs">API documentation</a></nav>}
    </header>
    <main className="app-main">{children}</main>
    {marketing ? <footer className="app-footer marketing-footer"><div><Link className="brand brand--image brand--footer" href="/" aria-label="ZeroRoot home"><BrandLogo /></Link><p>Website security operations,<br/>made clear.</p></div><div><strong>Platform</strong><a href="#security">Security scanning</a><a href="#platform">Monitoring & recovery</a><a href="#portals">Portal access</a></div><div><strong>Access</strong><Link href="/customer/login">Customer</Link><Link href="/agency/login">Agency</Link><Link href="/specialist/login">Specialist</Link></div><div><strong>Resources</strong><a href="http://localhost:4000/docs">API documentation</a><Link href="/sign-in">Open dashboard</Link></div><small>© {new Date().getFullYear()} ZeroRoot. Secure by design.</small></footer> : <footer className="app-footer app-footer--branded"><BrandLogo /><span>ZeroRoot secure identity platform</span></footer>}
  </div>;
}
