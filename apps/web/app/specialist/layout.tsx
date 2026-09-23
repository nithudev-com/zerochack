import type { Metadata } from 'next'; import type { ReactNode } from 'react'; import { SpecialistNav } from '../../components/specialist-nav'; import { PortalGuard } from '../../components/portal-guard';
export const metadata: Metadata = { title: 'Specialist Portal', robots: { index: false, follow: false } };
export default function SpecialistLayout({ children }: { children: ReactNode }) { return <PortalGuard portal="specialist" role="Cybersecurity Specialist" navigation={<SpecialistNav/>}>{children}</PortalGuard>; }
