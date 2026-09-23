'use client';
import { usePathname } from 'next/navigation';
const links = ['Overview','Referral Link','Referrals','Attribution','Commissions','Transactions','Payouts','Notifications','Profile'] as const;
export function AffiliateNav() { const path = usePathname(); return <aside className="customer-sidebar"><div className="customer-sidebar-title">Affiliate portal</div><nav aria-label="Affiliate navigation">{links.map((label) => { const href = `/affiliate/${label.toLowerCase().replace(' ', '-')}`; return <a key={href} href={href} aria-current={path === href ? 'page' : undefined}>{label}</a>; })}</nav></aside>; }
