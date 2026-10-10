'use client';
import { useQuery } from '@tanstack/react-query';
import { ErrorState, LoadingState } from '@zerochack/ui';
import { api } from '../lib/api';
import { CustomerOverview } from './customer-overview';

export type CustomerOverviewData = { protectedWebsites: number; securityPosture: string | null; openFindings: number; criticalFindings: number; latestScan: { status: string; requestedAt: string } | null; monitoring: { active: number; total: number }; backups: { active: number; total: number }; openTickets: number; subscription: { planName: string; status: string } | null; unreadNotifications: number };

export function Overview() {
  const query = useQuery({ queryKey: ['customer-overview'], queryFn: () => api<CustomerOverviewData>('/customer/overview') });
  if (query.isLoading) return <LoadingState label="Loading your overview" />;
  if (query.isError) return <ErrorState description={query.error.message} retry={() => void query.refetch()} />;
  const data = query.data!;
  return <CustomerOverview data={data} refreshing={query.isFetching} refresh={() => void query.refetch()} />;
}
