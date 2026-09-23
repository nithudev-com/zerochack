'use client';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@zerochack/ui';
import { api } from '../lib/api';
export const ownerSections=['Overview','Users','Approvals','Tenants','Websites','Specialists','Tickets','Subscriptions','Packages','Pricing','Quotes','Revenue','Affiliates','Commissions','Payouts','Backups','Monitoring','Security','Notifications','Email Automation','AI Gateway','Care','Integrations','System Health','Audit Logs','Settings'] as const;
const slug=(label:string)=>label.toLowerCase().replaceAll(' ','-');
const groups=[
  {label:'Command',items:['Overview','Approvals','System Health']},
  {label:'People & access',items:['Users','Tenants','Specialists']},
  {label:'Security operations',items:['Websites','Tickets','Backups','Monitoring','Security']},
  {label:'Commerce',items:['Subscriptions','Packages','Pricing','Quotes','Revenue']},
  {label:'Partner network',items:['Affiliates','Commissions','Payouts']},
  {label:'Platform',items:['Notifications','Email Automation','AI Gateway','Care','Integrations','Audit Logs','Settings']},
] as const;
const initials=(label:string)=>label.split(' ').map((word)=>word[0]).join('').slice(0,2);
export function OwnerNav(){const path=usePathname();const router=useRouter();return <aside className="customer-sidebar owner-sidebar"><div className="customer-sidebar-title"><span>ZR</span><div><small>OWNER WORKSPACE</small><strong>Control center</strong></div></div><nav aria-label="Owner navigation">{groups.map((group)=><section className="owner-nav-group" key={group.label}><h2>{group.label}</h2>{group.items.map((label)=>{const href=`/owner/${slug(label)}`;return <a key={href} href={href} aria-current={path===href?'page':undefined}><i>{initials(label)}</i><span>{label}</span></a>;})}</section>)}</nav><div className="owner-sidebar-session"><i/><span>Owner session protected</span></div><Button size="sm" variant="secondary" onClick={async()=>{await api('/auth/logout',{method:'POST'});router.replace('/owner/login');router.refresh();}}>Sign out securely</Button></aside>;}
