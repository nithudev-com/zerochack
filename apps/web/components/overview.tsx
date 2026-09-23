'use client';
import { useQuery } from '@tanstack/react-query';
import { ErrorState, LoadingState } from '@zerochack/ui';
import { api } from '../lib/api';
import { RoleDashboard } from './role-dashboard';

type Overview = { protectedWebsites: number; securityPosture: string | null; openFindings: number; criticalFindings: number; latestScan: { status: string; requestedAt: string } | null; monitoring: { active: number; total: number }; backups: { active: number; total: number }; openTickets: number; subscription: { planName: string; status: string } | null; unreadNotifications: number };

export function Overview() {
  const query = useQuery({ queryKey: ['customer-overview'], queryFn: () => api<Overview>('/customer/overview') });
  if (query.isLoading) return <LoadingState label="Loading your overview" />;
  if (query.isError) return <ErrorState description={query.error.message} retry={() => void query.refetch()} />;
  const data = query.data!;
  return <RoleDashboard role="customer" data={data as unknown as Record<string, unknown>} />;
}
