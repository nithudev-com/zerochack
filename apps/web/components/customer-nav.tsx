'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@zerochack/ui';
import { api } from '../lib/api';

const items = [
  ['Overview', '/customer/overview'], ['My Websites', '/customer/websites'], ['General Live Help', '/customer/support'], ['Subscription', '/customer/subscription'],
  ['Billing', '/customer/billing'], ['Notifications', '/customer/notifications'], ['Profile', '/customer/profile']
] as const;

export function CustomerNav() {
  const pathname = usePathname(); const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  return <aside className="customer-sidebar customer-premium-sidebar" data-expanded={expanded}><div className="customer-sidebar-title"><span>C</span><div><small>SECURE WORKSPACE</small><strong>Customer portal</strong></div><button type="button" className="customer-menu-toggle" aria-expanded={expanded} aria-controls="customer-navigation" onClick={() => setExpanded(!expanded)}>{expanded ? 'Close menu' : 'Menu'}</button></div><nav id="customer-navigation" aria-label="Customer navigation">
    {items.map(([label, href], index) => <Link key={href} href={href} onClick={() => setExpanded(false)} aria-current={pathname === href || (href === '/customer/websites' && pathname.startsWith(`${href}/`)) ? 'page' : undefined}><span>{label}</span><small>0{index + 1}</small></Link>)}
  </nav><div className="customer-sidebar-session"><i/><span>Protected session</span></div><Button size="sm" variant="secondary" onClick={async () => { await api('/auth/logout', { method: 'POST' }); router.replace('/customer/login'); }}>Sign out securely</Button></aside>;
}
