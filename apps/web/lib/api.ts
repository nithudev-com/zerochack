export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export class ApiClientError extends Error {
  readonly retryAt: number | null;
  readonly retryAfterSeconds: number | null;
  constructor(message: string, public code: string, public status: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.retryAfterSeconds = status === 429 ? Math.max(1, retryAfterSeconds ?? 60) : retryAfterSeconds;
    this.retryAt = this.retryAfterSeconds === null ? null : Date.now() + this.retryAfterSeconds * 1000;
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : null;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, { ...init, credentials: 'include', headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiClientError(body?.error?.message ?? 'The request could not be completed.', body?.error?.code ?? 'REQUEST_FAILED', response.status, parseRetryAfter(response.headers.get('retry-after')));
  return body as T;
}
