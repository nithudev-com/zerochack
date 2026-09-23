import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { loadEnvironment } from '@zerochack/config';

const environment = loadEnvironment({ NODE_ENV: 'test', DATABASE_URL: 'postgresql://localhost/test', REDIS_URL: 'redis://localhost:6379', SESSION_SECRET: 'test-secret-at-least-thirty-two-characters', CORS_ORIGINS: 'http://localhost:3000', LOG_LEVEL: 'silent' });

describe('API foundation', () => {
  it('exposes liveness and request IDs', async () => {
    const app = await buildApp(environment);
    const response = await app.inject({ method: 'GET', url: '/v1/health/live' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBeDefined();
    await app.close();
  });

  it('does not trust caller-supplied request IDs and rejects cross-site mutations', async () => {
    const app = await buildApp(environment);
    const response = await app.inject({ method: 'POST', url: '/v1/auth/forgot-password', headers: { 'x-request-id': 'attacker-controlled', 'sec-fetch-site': 'cross-site' }, payload: { email: 'nobody@example.test' } });
    expect(response.statusCode).toBe(403);
    expect(response.headers['x-request-id']).not.toBe('attacker-controlled');
    expect(response.headers['cache-control']).toBe('no-store');
    await app.close();
  });

  it('exposes OpenAPI JSON', async () => {
    const app = await buildApp(environment);
    expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(200);
    await app.close();
  });

  it('protects low-cardinality Prometheus metrics', async () => {
    const app = await buildApp(environment);
    expect((await app.inject({ method: 'GET', url: '/v1/health/metrics' })).statusCode).toBe(404);
    const response = await app.inject({ method: 'GET', url: '/v1/health/metrics', headers: { authorization: `Bearer ${environment.METRICS_TOKEN}` } });
    expect(response.statusCode).toBe(200); expect(response.body).toContain('zerochack_http_requests_total');
    await app.close();
  });
});
