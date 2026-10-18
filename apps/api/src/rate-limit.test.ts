import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { afterEach, describe, expect, it } from 'vitest';
import { authMeRateLimit } from './http-rate-policy';

// This exercises the installed limiter with production-sized buckets, not the
// application's relaxed NODE_ENV=test limits. Authentication here is an explicit
// fixture: no database, real sessions, credentials, or public listener are used.
const applications: FastifyInstance[] = [];
const sourceAddress = '198.51.100.24';
const approvedSession = { 'x-fixture-session': 'approved' };

async function fixtureApp() {
  const app = Fastify({ logger: false, trustProxy: false });
  applications.push(app);
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute', keyGenerator: request => request.ip });
  const authenticated = (request: FastifyRequest) => request.headers['x-fixture-session'] === 'approved';
  app.get('/v1/auth/me', {
    config: { rateLimit: authMeRateLimit('production') },
    preHandler: async (request, reply) => {
      if (!authenticated(request)) return reply.code(401).send({ error: 'fixture session required' });
    }
  }, async () => ({ authenticated: true }));
  app.get('/v1/workspace', {
    preHandler: async (request, reply) => {
      if (!authenticated(request)) return reply.code(401).send({ error: 'fixture session required' });
    }
  }, async request => ({ source: request.ip }));
  // These route-local limits mirror the strict production login/reset budgets.
  app.post('/v1/auth/login', { config: { rateLimit: { max: 10, timeWindow: '15 minutes' } } }, async () => ({ fixture: true }));
  app.post('/v1/auth/forgot-password', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async () => ({ fixture: true }));
  await app.ready();
  return app;
}

afterEach(async () => {
  await Promise.all(applications.splice(0).map(app => app.close()));
});

describe('production HTTP rate-limit separation', () => {
  it('keeps the session-check policy bounded in production and explicit in tests', () => {
    expect(authMeRateLimit('production')).toEqual({ max: 100, timeWindow: '1 minute' });
    expect(authMeRateLimit('development')).toEqual({ max: 100, timeWindow: '1 minute' });
    expect(authMeRateLimit('test')).toEqual({ max: 10_000, timeWindow: '1 minute' });
  });

  it('allows 100 Caddy-shaped session checks plus 100 application reads, then blocks each bucket independently', async () => {
    const app = await fixtureApp();
    for (let index = 0; index < 100; index += 1) {
      const session = await app.inject({ method: 'GET', url: '/v1/auth/me', remoteAddress: sourceAddress, headers: approvedSession });
      const workspace = await app.inject({ method: 'GET', url: '/v1/workspace', remoteAddress: sourceAddress, headers: approvedSession });
      expect(session.statusCode).toBe(200);
      expect(workspace.statusCode).toBe(200);
    }
    for (const url of ['/v1/auth/me', '/v1/workspace']) {
      const denied = await app.inject({ method: 'GET', url, remoteAddress: sourceAddress, headers: approvedSession });
      expect(denied.statusCode).toBe(429);
      expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(denied.headers['retry-after'])).toBeLessThanOrEqual(60);
    }
  });

  it('does not spend the session-check budget when the application budget is exhausted', async () => {
    const app = await fixtureApp();
    for (let index = 0; index < 100; index += 1) {
      expect((await app.inject({ method: 'GET', url: '/v1/workspace', remoteAddress: sourceAddress, headers: approvedSession })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/workspace', remoteAddress: sourceAddress, headers: approvedSession })).statusCode).toBe(429);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', remoteAddress: sourceAddress, headers: approvedSession })).statusCode).toBe(200);
  });

  it('preserves the stricter login and password-reset buckets', async () => {
    const app = await fixtureApp();
    for (const [url, allowed, retryAfter] of [
      ['/v1/auth/login', 10, 15 * 60],
      ['/v1/auth/forgot-password', 3, 60 * 60]
    ] as const) {
      for (let index = 0; index < allowed; index += 1) {
        expect((await app.inject({ method: 'POST', url, remoteAddress: sourceAddress })).statusCode).toBe(200);
      }
      const denied = await app.inject({ method: 'POST', url, remoteAddress: sourceAddress });
      expect(denied.statusCode).toBe(429);
      expect(Number(denied.headers['retry-after'])).toBeGreaterThan(60);
      expect(Number(denied.headers['retry-after'])).toBeLessThanOrEqual(retryAfter);
    }
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', remoteAddress: sourceAddress, headers: approvedSession })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/workspace', remoteAddress: sourceAddress, headers: approvedSession })).statusCode).toBe(200);
  });

  it('does not let forged cookies or forwarding headers split the source-IP bucket when proxy trust is off', async () => {
    const app = await fixtureApp();
    for (let index = 0; index < 101; index += 1) {
      const response = await app.inject({
        method: 'GET', url: '/v1/workspace', remoteAddress: sourceAddress,
        headers: {
          ...approvedSession,
          cookie: `cb_session=forged-${index}`,
          'x-forwarded-for': `203.0.113.${index + 1}`,
          'cf-connecting-ip': `203.0.113.${index + 1}`,
          'x-real-ip': `203.0.113.${index + 1}`
        }
      });
      expect(response.statusCode).toBe(index < 100 ? 200 : 429);
      if (index < 100) expect(response.json()).toEqual({ source: sourceAddress });
    }
    expect((await app.inject({ method: 'GET', url: '/v1/workspace', remoteAddress: '198.51.100.25', headers: approvedSession })).statusCode).toBe(200);
  });

  it('does not treat a cookie or claimed forwarding identity as an authenticated fixture session', async () => {
    const app = await fixtureApp();
    const response = await app.inject({
      method: 'GET', url: '/v1/auth/me', remoteAddress: sourceAddress,
      headers: { cookie: 'cb_session=forged', 'x-forwarded-for': '127.0.0.1', 'cf-connecting-ip': '127.0.0.1' }
    });
    expect(response.statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/auth/me', remoteAddress: sourceAddress, headers: approvedSession })).statusCode).toBe(200);
  });
});
