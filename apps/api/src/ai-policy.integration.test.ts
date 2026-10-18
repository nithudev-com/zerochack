import { afterAll, beforeAll, expect, it } from 'vitest';
import { database } from '@zerochack/database';
import { loadEnvironment } from '@zerochack/config';
import { hashOpaqueToken } from '@zerochack/auth';
import { buildApp } from './app.js';

const env = loadEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: 'redis://localhost:6379', SESSION_SECRET: 'synthetic-ai-policy-integration-32chars', CORS_ORIGINS: 'http://localhost:3000', LOG_LEVEL: 'silent' });
let app: Awaited<ReturnType<typeof buildApp>>; let tenantId: string; const users: string[] = []; const cookies: Record<string, string> = {};
beforeAll(async () => {
  if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Disposable *_test database required');
  tenantId = (await database.tenant.create({ data: { name: 'AI Policy Fixture', slug: 'ai-policy-' + crypto.randomUUID() } })).id;
  for (const [label, roleName, fresh] of [['owner', 'Owner', true], ['stale', 'Owner', false], ['customer', 'Customer', true]] as const) {
    const user = await database.user.create({ data: { email: `${label}-${crypto.randomUUID()}@example.test`, passwordHash: 'not-a-login-hash', status: 'APPROVED', emailVerifiedAt: new Date() } }); users.push(user.id);
    const role = await database.role.findFirstOrThrow({ where: { name: roleName, tenantId: null } });
    await database.tenantMembership.create({ data: { tenantId, userId: user.id, status: 'ACTIVE' } }); await database.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    const token = crypto.randomUUID(); await database.session.create({ data: { tokenHash: hashOpaqueToken(token, env.SESSION_SECRET), tenantId, userId: user.id, expiresAt: new Date(Date.now() + 3600000), mfaVerifiedAt: new Date(Date.now() - (fresh ? 0 : 3600000)) } }); cookies[label] = 'zerochack_session=' + token;
  }
  app = await buildApp(env);
});
afterAll(async () => {
  if (app) await app.close();
  if (tenantId) {
    await database.aiTenantPolicy.deleteMany({ where: { tenantId } }); await database.auditLog.deleteMany({ where: { tenantId } }); await database.userRole.deleteMany({ where: { tenantId } }); await database.tenantMembership.deleteMany({ where: { tenantId } }); await database.session.deleteMany({ where: { tenantId } }); await database.user.deleteMany({ where: { id: { in: users } } }); await database.tenant.delete({ where: { id: tenantId } });
  }
  await database.$disconnect();
});

it('requires recent Owner MFA for tenant discovery and policy updates; missing policy is disabled', async () => {
  for (const [cookie, expected] of [[undefined, 401], [cookies.customer, 403], [cookies.stale, 403]] as const) {
    for (const method of ['GET', 'PUT'] as const) expect((await app.inject({ method, url: method === 'GET' ? '/v1/owner/ai/tenants' : `/v1/owner/ai/tenants/${tenantId}/policy`, ...(cookie ? { headers: { cookie } } : {}), ...(method === 'PUT' ? { payload: {} } : {}) })).statusCode).toBe(expected);
  }
  const response = await app.inject({ url: '/v1/owner/ai/tenants?search=AI%20Policy%20Fixture', headers: { cookie: cookies.owner! } });
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('private, no-store'); expect(response.json()).toEqual([{ id: tenantId, name: 'AI Policy Fixture', aiPolicy: null }]);
  expect((await app.inject({ url: '/v1/owner/ai/tenants?take=101', headers: { cookie: cookies.owner! } })).statusCode).toBe(400);
});
it('rejects unbounded activation, saves bounded access idempotently and can disable it', async () => {
  const headers = { cookie: cookies.owner! }; const url = `/v1/owner/ai/tenants/${tenantId}/policy`;
  const input = { enabled: true, requestsPerMinute: 6, requestsPerUserMinute: 3, maxConcurrent: 1, dailyCostLimitMicros: 1_000_000 };
  expect((await app.inject({ method: 'PUT', url, headers, payload: { ...input, dailyCostLimitMicros: 0 } })).statusCode).toBe(400);
  for (let n = 0; n < 2; n++) expect((await app.inject({ method: 'PUT', url, headers, payload: input })).json()).toMatchObject({ tenantId, ...input });
  expect(await database.aiTenantPolicy.count({ where: { tenantId } })).toBe(1);
  const list = await app.inject({ url: '/v1/owner/ai/tenants?search=AI%20Policy%20Fixture', headers }); expect(list.json()[0].aiPolicy).toMatchObject(input); expect(list.body).not.toContain('encryptedSecret');
  expect((await app.inject({ method: 'PUT', url, headers, payload: { ...input, enabled: false } })).json().enabled).toBe(false);
  expect(await database.auditLog.count({ where: { tenantId, action: 'ai.tenant_policy_changed' } })).toBe(3);
  expect((await app.inject({ method: 'PUT', url: `/v1/owner/ai/tenants/${crypto.randomUUID()}/policy`, headers, payload: input })).statusCode).toBe(404);
});
