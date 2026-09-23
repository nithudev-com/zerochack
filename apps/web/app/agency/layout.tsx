import type { Metadata } from 'next'; import type { ReactNode } from 'react'; import { AgencyNav } from '../../components/agency-nav'; import { PortalGuard } from '../../components/portal-guard';
export const metadata: Metadata = { title: 'Agency Portal', robots: { index: false, follow: false } };
export default function AgencyLayout({ children }: { children: ReactNode }) { return <PortalGuard portal="agency" role="Agency" navigation={<AgencyNav/>}>{children}</PortalGuard>; }
