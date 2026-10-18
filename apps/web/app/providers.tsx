'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { queryRetry } from '../lib/query-policy';
import { ToastProvider } from '@zerochack/ui';
import { useState, type ReactNode } from 'react';

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: queryRetry, refetchOnWindowFocus: false } } }));
  return <QueryClientProvider client={queryClient}><ToastProvider>{children}</ToastProvider></QueryClientProvider>;
}
