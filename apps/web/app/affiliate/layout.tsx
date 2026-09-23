import type { Metadata } from 'next'; import type { ReactNode } from 'react'; import { AffiliateNav } from '../../components/affiliate-nav'; import { PortalGuard } from '../../components/portal-guard';
export const metadata: Metadata = { title: 'Affiliate Portal', robots: { index: false, follow: false } };
export default function AffiliateLayout({ children }: { children: ReactNode }) { return <PortalGuard portal="affiliate" role="Affiliate" navigation={<AffiliateNav/>}>{children}</PortalGuard>; }
