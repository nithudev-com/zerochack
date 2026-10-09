import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { database } from '@zerochack/database';
import { loadEnvironment } from '@zerochack/config';
import { hashOpaqueToken } from '@zerochack/auth';
import { buildApp } from './app.js';
import { verifyConnector, ConnectorError } from './modules/connectors/adapters.js';

// Real disposable PostgreSQL, sessions, authorization, encryption and routes;
// vendor transport is a fixture. Never contact customer platforms in this suite.
vi.mock('./modules/connectors/adapters.js', async original => ({ ...await original<typeof import('./modules/connectors/adapters.js')>(), verifyConnector: vi.fn(async () => {}) }));
const env = loadEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: 'redis://localhost:6379', SESSION_SECRET: 'synthetic-connectors-session-secret-32chars', CORS_ORIGINS: 'http://localhost:3000', LOG_LEVEL: 'silent' });
let app: Awaited<ReturnType<typeof buildApp>>;
const tenants: string[] = []; const users: string[] = []; const cookies: string[] = []; let websiteId: string;
const secret = 'abcd efgh ijkl mnop qrst uvwx';
const input = { provider: 'wordpress', endpoint: 'https://cms.customer.com/', username: 'reader', secret, authorizationConfirmed: true, revision: 0 };
const path = () => `/v1/websites/${websiteId}/connectors`;
const headers = () => ({ cookie: cookies[0]! });
beforeAll(async () => {
  if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Connectors tests require an isolated *_test database');
  for (let index = 0; index < 2; index++) {
    const tenant = await database.tenant.create({ data: { name: 'Connector fixture', slug: 'connectors-' + crypto.randomUUID() } }); tenants.push(tenant.id);
    const user = await database.user.create({ data: { email: `connector-${crypto.randomUUID()}@example.test`, passwordHash: 'not-a-login-hash', status: 'APPROVED', emailVerifiedAt: new Date() } }); users.push(user.id);
    const role = await database.role.findFirstOrThrow({ where: { name: 'Customer', tenantId: null } });
    await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: 'ACTIVE' } });
    await database.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
    const token = crypto.randomUUID(); await database.session.create({ data: { tokenHash: hashOpaqueToken(token, env.SESSION_SECRET), tenantId: tenant.id, userId: user.id, expiresAt: new Date(Date.now() + 3600000) } }); cookies.push('zerochack_session=' + token);
  }
  websiteId = (await database.website.create({ data: { tenantId: tenants[0]!, name: 'Connector fixture', url: 'https://cms.customer.com/', normalizedHost: 'cms.customer.com' } })).id;
  app = await buildApp(env);
});
afterAll(async () => {
  if (app) await app.close();
  for (const tenantId of tenants) {
    await database.website.deleteMany({ where: { tenantId } }); await database.auditLog.deleteMany({ where: { tenantId } }); await database.userRole.deleteMany({ where: { tenantId } }); await database.tenantMembership.deleteMany({ where: { tenantId } }); await database.session.deleteMany({ where: { tenantId } }); await database.tenant.delete({ where: { id: tenantId } });
  }
  await database.user.deleteMany({ where: { id: { in: users } } }); await database.$disconnect();
});
it('requires authentication, same-tenant ownership and explicit authorization', async () => {
  expect((await app.inject({ url: path() })).statusCode).toBe(401);
  for (const method of ['GET', 'PUT'] as const) expect((await app.inject({ method, url: path(), headers: { cookie: cookies[1]! }, ...(method === 'PUT' ? { payload: input } : {}) })).statusCode).toBe(404);
  expect((await app.inject({ method: 'PUT', url: path(), headers: headers(), payload: input })).statusCode).toBe(409);
  await database.website.update({ where: { id: websiteId }, data: { connectionStatus: 'VERIFIED' } });
  expect((await app.inject({ method: 'PUT', url: path(), headers: headers(), payload: { ...input, authorizationConfirmed: false } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'PUT', url: path(), headers: headers(), payload: { ...input, provider: 'wix' } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'PUT', url: path(), headers: headers(), payload: { ...input, endpoint: 'https://other.customer.com/' } })).statusCode).toBe(400);
  expect(verifyConnector).not.toHaveBeenCalled();
});
it('stores encrypted bound credentials without marking saved access as authenticated', async () => {
  const saved = await app.inject({ method: 'PUT', url: path(), headers: headers(), payload: input }); expect(saved.statusCode).toBe(200); expect(saved.json()).toMatchObject({ status: 'CONFIGURED', revision: 1 }); expect(saved.body).not.toContain(secret);
  const row = await database.websiteConnector.findFirstOrThrow({ where: { websiteId } }); expect(row.encryptedSecret).not.toContain(secret); expect(row.encryptedSecret).not.toContain('reader');
  const list = await app.inject({ url: path(), headers: headers() }); expect(list.headers['cache-control']).toBe('private, no-store'); expect(list.body).not.toContain('encryptedSecret'); expect(list.body).not.toContain(secret);
  expect((await app.inject({ method: 'PUT', url: path(), headers: headers(), payload: input })).statusCode).toBe(409);
});
it('records a real adapter outcome, then exposes a safe failure on a later check', async () => {
  const checked = await app.inject({ method: 'POST', url: path() + '/wordpress/check', headers: headers(), payload: { confirm: true, revision: 1 } }); expect(checked.statusCode).toBe(200); expect(checked.json()).toMatchObject({ status: 'AUTHENTICATED_READ', revision: 2 }); expect(verifyConnector).toHaveBeenCalledWith(expect.objectContaining({ secret, provider: 'wordpress' }));
  vi.mocked(verifyConnector).mockRejectedValueOnce(new ConnectorError('AUTH_OR_PERMISSION_DENIED'));
  const failed = await app.inject({ method: 'POST', url: path() + '/wordpress/check', headers: headers(), payload: { confirm: true, revision: 2 } }); expect(failed.json()).toMatchObject({ status: 'NEEDS_ATTENTION', lastErrorCode: 'AUTH_OR_PERMISSION_DENIED', revision: 3 });
});
it('blocks website changes and expired authorization before sending credentials', async () => {
  const count = vi.mocked(verifyConnector).mock.calls.length;
  await database.website.update({ where: { id: websiteId }, data: { url: 'https://other.customer.com/', normalizedHost: 'other.customer.com' } });
  expect((await app.inject({ method: 'POST', url: path() + '/wordpress/check', headers: headers(), payload: { confirm: true, revision: 3 } })).statusCode).toBe(409);
  expect((await app.inject({ url: path(), headers: headers() })).json()[0].status).toBe('WEBSITE_REVERIFICATION_REQUIRED');
  await database.website.update({ where: { id: websiteId }, data: { url: input.endpoint, normalizedHost: 'cms.customer.com' } });
  await database.websiteConnector.updateMany({ where: { websiteId }, data: { authorizationExpiresAt: new Date(0) } });
  expect((await app.inject({ method: 'POST', url: path() + '/wordpress/check', headers: headers(), payload: { confirm: true, revision: 3 } })).statusCode).toBe(409);
  expect(vi.mocked(verifyConnector).mock.calls).toHaveLength(count);
});
it('does not resurrect credentials when revoked during an in-flight check', async () => {
  const saved = await app.inject({ method: 'PUT', url: path(), headers: headers(), payload: { ...input, revision: 3 } }); expect(saved.json().revision).toBe(4);
  let release!: () => void; let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  vi.mocked(verifyConnector).mockImplementationOnce(async () => { started(); await new Promise<void>(resolve => { release = resolve; }); });
  const checking = app.inject({ method: 'POST', url: path() + '/wordpress/check', headers: headers(), payload: { confirm: true, revision: 4 } }).then(result => result);
  await entered;
  expect((await app.inject({ method: 'POST', url: path() + '/wordpress/check', headers: headers(), payload: { confirm: true, revision: 5 } })).statusCode).toBe(409);
  expect((await app.inject({ method: 'DELETE', url: path() + '/wordpress', headers: headers(), payload: { confirm: true, revision: 5 } })).statusCode).toBe(204);
  release(); expect((await checking).statusCode).toBe(409);
  const row = await database.websiteConnector.findFirstOrThrow({ where: { websiteId } }); expect(row.encryptedSecret).toBe(''); expect(row.status).toBe('REVOKED');
  expect((await app.inject({ method: 'POST', url: path() + '/wordpress/check', headers: headers(), payload: { confirm: true, revision: 6 } })).statusCode).toBe(404);
  expect(JSON.stringify(await database.auditLog.findMany({ where: { tenantId: tenants[0]! } }))).not.toContain(secret);
});
