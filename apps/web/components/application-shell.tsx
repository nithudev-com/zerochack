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
    {marketing && <a href="#main-content" className="zr-skip-link">Skip to content</a>}
    <header className="app-header">
      <Link className="brand brand--image" href="/" aria-label="ZeroRoot home"><BrandLogo priority /></Link>
      {marketing ? <><nav aria-label="Primary navigation"><a href="#services">What we do</a><a href="#ai">AI capabilities</a><a href="#how-it-works">How it works</a><a href="#faq">FAQ</a></nav><div className="header-actions"><Link className="header-login" href="/sign-in">Sign in</Link><Link className="header-cta" href="/customer/register">Get started <span aria-hidden="true">→</span></Link></div><details className="zr-mobile-nav"><summary aria-label="Open navigation"><span aria-hidden="true">☰</span></summary><div onClick={(event) => { if ((event.target as HTMLElement).closest("a")) event.currentTarget.closest("details")?.removeAttribute("open"); }}><a href="#services">What we do</a><a href="#ai">AI capabilities</a><a href="#how-it-works">How it works</a><a href="#faq">FAQ</a><Link href="/sign-in">Sign in</Link></div></details></> : publicAuth ? <nav aria-label="Public navigation"><Link href="/">Home</Link></nav> : <nav aria-label="Primary navigation"><Link href="/">Home</Link><Link href="/dashboard">Dashboard</Link><Link href="/account">Sessions</Link><a href="http://localhost:4000/docs">API documentation</a></nav>}
    </header>
    <main id="main-content" className="app-main">{children}</main>
    {marketing ? <footer className="app-footer marketing-footer"><div><Link className="brand brand--image brand--footer" href="/" aria-label="ZeroRoot home"><BrandLogo /></Link><p>Your whole web stack.<br/>A clearer next step.</p></div><div><strong>Technology care</strong><a href="#redesign">Design reviews</a><a href="#repair">App, API & server reviews</a><a href="#security">Security & recovery</a><a href="#technology">DevOps & technologies</a><a href="#ai">AI capabilities</a></div><div><strong>Access</strong><Link href="/customer/login">Customer</Link><Link href="/agency/login">Agency</Link><Link href="/specialist/login">Specialist</Link></div><div><strong>Explore</strong><a href="#how-it-works">How it works</a><a href="#faq">Questions & answers</a><Link href="/affiliate/login">Affiliate portal</Link><Link href="/sign-in">Open workspace</Link></div><small>© {new Date().getFullYear()} ZeroRoot. Your technology, with you in control.</small></footer> : <footer className="app-footer app-footer--branded"><BrandLogo /><span>ZeroRoot secure identity platform</span></footer>}
  </div>;
}
