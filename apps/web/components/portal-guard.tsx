'use client';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { apiUrl } from '../lib/api';

type Identity = { roles?: string[]; mfaVerified?: boolean };

export function PortalGuard({ children, navigation, portal, role, className = '' }: { children: ReactNode; navigation: ReactNode; portal: string; role: string; className?: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [authorized, setAuthorized] = useState(false);
  const publicPage = pathname === `/${portal}/login` || pathname === `/${portal}/register`;

  useEffect(() => {
    if (publicPage) { setAuthorized(false); return; }
    let active = true;
    setAuthorized(false);
    void fetch(`${apiUrl}/auth/me`, { credentials: 'include', cache: 'no-store' }).then(async (response) => {
      if (!active) return;
      if (!response.ok) { router.replace(`/${portal}/login`); return; }
      const identity = await response.json() as Identity;
      if (!identity.roles?.includes(role) || (role === 'Owner' && !identity.mfaVerified)) { router.replace('/dashboard'); return; }
      setAuthorized(true);
    }).catch(() => { if (active) router.replace(`/${portal}/login`); });
    return () => { active = false; };
  }, [pathname, portal, publicPage, role, router]);

  if (publicPage) return children;
  if (!authorized) return <div className="portal-verifying" role="status"><span className="ui-spinner"/><strong>Verifying secure access</strong><p>Your workspace will open after your session and role are confirmed.</p></div>;
  return <div className={`customer-layout ${className}`.trim()}>{navigation}<div className="customer-main">{children}</div></div>;
}
