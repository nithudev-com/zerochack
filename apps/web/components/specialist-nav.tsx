'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Button } from '@zerochack/ui';
import { api } from '../lib/api';
const items = [['Overview','overview'],['General Live Help','support'],['Available Jobs','jobs'],['My Tickets','tickets'],['Approved Access','access'],['Active Sessions','sessions'],['Performance','performance'],['Notifications','notifications'],['Profile','profile']] as const;
export function SpecialistNav() { const pathname = usePathname(); const router = useRouter(); return <aside className="customer-sidebar"><div className="customer-sidebar-title">Specialist portal</div><nav aria-label="Specialist navigation">{items.map(([label,path]) => <Link key={path} href={`/specialist/${path}`} aria-current={pathname === `/specialist/${path}` ? 'page' : undefined}>{label}</Link>)}</nav><Button size="sm" variant="secondary" onClick={async () => { await api('/auth/logout', { method: 'POST' }); router.replace('/specialist/login'); }}>Sign out</Button></aside>; }
