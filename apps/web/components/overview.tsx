'use client';
import { useQuery } from '@tanstack/react-query';
import { ErrorState, LoadingState } from '@zerochack/ui';
import { api } from '../lib/api';
import { CustomerOverview } from './customer-overview';
import type { OverviewWebsite } from '../lib/overview-websites';

export function Overview() {
  const query = useQuery({ queryKey: ['websites'], queryFn: () => api<OverviewWebsite[]>('/websites') });
  if (query.isLoading) return <LoadingState label="Loading your overview" />;
  if (query.isError) return <ErrorState description={query.error.message} retry={() => void query.refetch()} />;
  return <CustomerOverview websites={query.data ?? []} />;
}
