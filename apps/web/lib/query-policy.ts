import { ApiClientError } from './api';

export function retryDelayRemaining(error: unknown, now = Date.now()): number {
  return error instanceof ApiClientError && error.retryAt !== null ? Math.max(0, error.retryAt - now) : 0;
}

export function queryRetry(failureCount: number, error: Error): boolean {
  // Queries may retry a transient failure once; never hammer a rejected session.
  return failureCount < 1 && !(error instanceof ApiClientError && error.status >= 400 && error.status < 500);
}

export function canRetainQueryData(error: unknown): boolean {
  return !(error instanceof ApiClientError && [401, 403, 404].includes(error.status));
}

export function pollingInterval(query: { state: { error: unknown; errorUpdatedAt: number; errorUpdateCount?: number; fetchFailureCount: number } }, normalMs: number): number | false {
  const error = query.state.error;
  if (error instanceof ApiClientError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) return false;
  const remaining = retryDelayRemaining(error);
  if (remaining > 0) return Math.min(2_147_483_647, Math.max(1000, remaining + 100));
  if (error) return Math.max(normalMs, Math.min(60_000, 5000 * 2 ** Math.min(query.state.errorUpdateCount ?? query.state.fetchFailureCount, 4)));
  return normalMs;
}
