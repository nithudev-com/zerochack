import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Choose Your Sign-In Portal', description: 'Choose the ZeroRoot portal assigned to your account.', robots: { index: false, follow: false } };

const portals = [
  { name: 'Customer', path: 'customer', mark: 'C', copy: 'Protect websites, review findings, backups, tickets, and security activity.', detail: 'Website owners & teams' },
  { name: 'Agency', path: 'agency', mark: 'A', copy: 'Manage authorized client websites, subscriptions, quotes, and operations.', detail: 'Agencies & service partners' },
  { name: 'Affiliate', path: 'affiliate', mark: 'F', copy: 'Follow referrals, conversions, commissions, transactions, and payouts.', detail: 'Referral partners' }
] as const;

export default function SignInPage() { return <div className="portal-picker"><header><span className="portal-picker__eyebrow"><i/> Secure portal access</span><h1>Where do you<br/><em>belong?</em></h1><p>Choose the workspace assigned to your account. Your role and access will be verified securely when you sign in.</p></header><section className="portal-picker__grid" aria-label="Choose your portal">{portals.map((portal,index)=><Link href={`/${portal.path}/login`} className={`portal-choice portal-choice--${portal.path}`} key={portal.path} style={{'--picker-delay':`${index*90}ms`} as React.CSSProperties}><div className="portal-choice__top"><span>{portal.mark}</span><small>0{index+1}</small></div><div><small>{portal.detail}</small><h2>{portal.name}</h2><p>{portal.copy}</p></div><strong>Continue to sign in <span>→</span></strong></Link>)}</section><aside className="staff-entry"><div><span>Protected staff access</span><p>Internal ZeroRoot team members use separate controlled portals.</p></div><nav><Link href="/specialist/login">Specialist sign in</Link><Link href="/owner/login">Owner sign in</Link></nav></aside><p className="portal-picker__new">New customer? <Link href="/customer/register">Create your protected workspace →</Link></p></div> }
