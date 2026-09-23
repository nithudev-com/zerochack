export const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/v1';

export class ApiClientError extends Error {
  constructor(message: string, public code: string, public status: number) { super(message); }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, { ...init, credentials: 'include', headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => undefined);
  if (!response.ok) throw new ApiClientError(body?.error?.message ?? 'The request could not be completed.', body?.error?.code ?? 'REQUEST_FAILED', response.status);
  return body as T;
}
