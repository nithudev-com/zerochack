'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiUrl } from '../../lib/api';

const destinations: Record<string, string> = { Owner: '/owner/overview', Agency: '/agency/overview', Affiliate: '/affiliate/overview', 'Cybersecurity Specialist': '/specialist/overview', Customer: '/customer/overview' };

export default function DashboardPage() {
  const router = useRouter();
  useEffect(() => {
    let active = true;
    void fetch(`${apiUrl}/auth/me`, { credentials: 'include', cache: 'no-store' }).then(async (response) => {
      if (!active) return;
      if (!response.ok) { router.replace('/sign-in'); return; }
      const body = await response.json() as { roles?: string[] };
      const role = Object.keys(destinations).find((candidate) => body.roles?.includes(candidate));
      router.replace(role ? destinations[role]! : '/account');
    }).catch(() => { if (active) router.replace('/sign-in'); });
    return () => { active = false; };
  }, [router]);

  return <div className="dashboard-gateway"><span className="ui-spinner"/><h1>Opening your workspace</h1><p>Verifying your secure session…</p></div>;
}
