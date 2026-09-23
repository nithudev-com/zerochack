'use client';
import { usePathname } from 'next/navigation';
const links = ['Overview', 'Clients', 'Websites', 'Subscriptions', 'Commerce', 'Quotes', 'Billing', 'Notifications', 'Profile'] as const;
export function AgencyNav() { const path = usePathname(); return <aside className="customer-sidebar"><div className="customer-sidebar-title">Agency portal</div><nav aria-label="Agency navigation">{links.map((label) => { const href = `/agency/${label.toLowerCase()}`; return <a key={href} href={href} aria-current={path === href ? 'page' : undefined}>{label}</a>; })}</nav></aside>; }
