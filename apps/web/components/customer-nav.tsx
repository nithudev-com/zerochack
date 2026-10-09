'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { CustomerIcon, type CustomerIconName } from './customer-icon';

const items: Array<{ label: string; href: string; icon: CustomerIconName }> = [
  { label: 'Overview', href: '/customer/overview', icon: 'overview' },
  { label: 'My websites', href: '/customer/websites', icon: 'websites' },
  { label: 'General live help', href: '/customer/support', icon: 'support' },
  { label: 'Subscription', href: '/customer/subscription', icon: 'subscription' },
  { label: 'Billing', href: '/customer/billing', icon: 'billing' },
  { label: 'Notifications', href: '/customer/notifications', icon: 'notifications' },
  { label: 'Profile & security', href: '/customer/profile', icon: 'profile' },
];
export function CustomerNav() {
  const pathname = usePathname(); const router = useRouter(); const cache = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null); const menuButton = useRef<HTMLButtonElement>(null);
  const [expanded, setExpanded] = useState(false); const [signingOut, setSigningOut] = useState(false); const [error, setError] = useState('');
  const active = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const close = () => dialog.current?.close();
  useEffect(() => { dialog.current?.close(); }, [pathname]);
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const resized = () => { if (desktop.matches) dialog.current?.close(); };
    desktop.addEventListener('change', resized);
    return () => desktop.removeEventListener('change', resized);
  }, []);
  async function signOut() {
    setSigningOut(true); setError('');
    try { await api('/auth/logout', { method: 'POST' }); cache.clear(); close(); router.replace('/customer/login'); }
    catch { setError('Sign out did not complete. Please try again.'); setSigningOut(false); }
  }
  const links = items.map(({ label, href, icon }) => <Link key={href} href={href} onClick={close} aria-current={active(href) ? 'page' : undefined}><CustomerIcon name={icon} /><span>{label}</span>{active(href) && <i aria-hidden="true" />}</Link>);
  const session = <div className="cw-session"><Link href="/dashboard" onClick={close}><CustomerIcon name="overview" />Switch workspace</Link><Link href="/account" onClick={close}><CustomerIcon name="shield" />Manage sessions</Link><button type="button" disabled={signingOut} onClick={() => void signOut()}><CustomerIcon name="logout" />{signingOut ? 'Signing out…' : 'Sign out'}</button>{error && <p role="alert">{error}</p>}</div>;
  return <>
    <aside className="cw-sidebar"><div className="cw-sidebar-title"><span className="cw-workspace-symbol"><CustomerIcon name="shield" /></span><div><small>YOUR WORKSPACE</small><strong>Customer portal</strong></div></div><span className="cw-nav-label">WORKSPACE</span><nav aria-label="Customer navigation" className="cw-nav">{links}</nav><div className="cw-sidebar-note"><CustomerIcon name="support" /><strong>A little help, a clear next step.</strong><p>Keep your website care in one place.</p><Link href="/customer/support">Open live help <CustomerIcon name="arrow" /></Link></div>{session}</aside>
    <nav className="cw-mobile-nav" aria-label="Customer mobile navigation">{items.slice(0, 3).map(({ href, icon }, index) => <Link href={href} key={href} aria-current={active(href) ? 'page' : undefined}><CustomerIcon name={icon} /><span>{['Overview', 'Websites', 'Help'][index]}</span></Link>)}<button type="button" ref={menuButton} aria-haspopup="dialog" aria-expanded={expanded} aria-controls="customer-more-menu" data-active={items.slice(3).some(({ href }) => active(href))} onClick={() => { dialog.current?.showModal(); setExpanded(true); }}><CustomerIcon name="more" /><span>More</span></button></nav>
    <dialog id="customer-more-menu" className="cw-menu" ref={dialog} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)'));
      const first = controls[0]; const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }} aria-labelledby="customer-menu-title" onClose={() => { setExpanded(false); if (menuButton.current?.getClientRects().length) menuButton.current.focus(); }}><div className="cw-menu-heading"><div><small>YOUR WORKSPACE</small><h2 id="customer-menu-title">Customer portal</h2></div><button type="button" className="cw-icon-button" aria-label="Close navigation" onClick={close}><CustomerIcon name="close" /></button></div><nav aria-label="All customer pages" className="cw-nav">{links}</nav>{session}</dialog>
  </>;
}
