import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { CustomerNav } from '../../components/customer-nav';
import { PortalGuard } from '../../components/portal-guard';
export const metadata: Metadata = { title: 'Customer Portal', robots: { index: false, follow: false } };
export default function CustomerLayout({ children }: { children: ReactNode }) { return <PortalGuard portal="customer" role="Customer" navigation={<CustomerNav/>} className="customer-premium-layout">{children}</PortalGuard>; }
