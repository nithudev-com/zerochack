import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { database } from '@zerochack/database';
import { loadEnvironment } from '@zerochack/config';
import { hashOpaqueToken } from '@zerochack/auth';
import { SmtpEmailProvider } from '@zerochack/email';
import { buildApp } from './app.js';
import { SMTP_SETTING_KEY } from './modules/communications/smtp-settings.js';

// Disposable database only; mock the SMTP transport, never send live mail.
vi.mock('@zerochack/scanner', async importOriginal => ({ ...await importOriginal<typeof import('@zerochack/scanner')>(), resolvePublicTarget: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }]) }));
const env = loadEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: 'redis://localhost:6379', SESSION_SECRET: 'synthetic-smtp-integration-secret-32chars', CORS_ORIGINS: 'http://localhost:3000', LOG_LEVEL: 'silent' });
let app: Awaited<ReturnType<typeof buildApp>>;
let tenantId: string; const users: string[] = []; const cookies: Record<string, string> = {};
const verify = vi.spyOn(SmtpEmailProvider.prototype, 'verify').mockResolvedValue();
const send = vi.spyOn(SmtpEmailProvider.prototype, 'send').mockResolvedValue({ providerMessageId: 'synthetic-message' });
beforeAll(async () => {
  if (!new URL(env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('SMTP tests require an isolated *_test database');
  if (await database.systemSetting.findUnique({ where: { key: SMTP_SETTING_KEY } })) throw new Error('SMTP fixture must start without a global SMTP override');
  tenantId = (await database.tenant.create({ data: { name: 'SMTP fixture', slug: 'smtp-'+crypto.randomUUID() } })).id;
  for (const [label, roleName, fresh] of [['owner', 'Owner', true], ['stale', 'Owner', false], ['customer', 'Customer', true]] as const) {
    const user = await database.user.create({ data: { email: `${label}-${crypto.randomUUID()}@example.test`, passwordHash: 'not-a-login-hash', status: 'APPROVED', emailVerifiedAt: new Date() } }); users.push(user.id);
    const role = await database.role.findFirstOrThrow({ where: { name: roleName, tenantId: null } });
    await database.tenantMembership.create({ data: { tenantId, userId: user.id, status: 'ACTIVE' } }); await database.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    const token = crypto.randomUUID(); await database.session.create({ data: { tokenHash: hashOpaqueToken(token, env.SESSION_SECRET), tenantId, userId: user.id, expiresAt: new Date(Date.now()+3600000), mfaVerifiedAt: new Date(Date.now()-(fresh?0:3600000)) } }); cookies[label] = 'zerochack_session='+token;
  }
  app = await buildApp(env);
});
afterAll(async () => {
  if (app) await app.close();
  if (tenantId) {
    await database.systemSetting.deleteMany({ where: { key: SMTP_SETTING_KEY, changedByUserId: { in: users } } });
    await database.auditLog.deleteMany({ where: { tenantId } }); await database.userRole.deleteMany({ where: { tenantId } }); await database.tenantMembership.deleteMany({ where: { tenantId } }); await database.session.deleteMany({ where: { tenantId } }); await database.user.deleteMany({ where: { id: { in: users } } }); await database.tenant.delete({ where: { id: tenantId } });
  }
  vi.restoreAllMocks(); await database.$disconnect();
});

it('enforces Owner/recent MFA, encrypts settings, preserves credentials and restricts tests to the verified Owner', async () => {
  for (const [cookie, expected] of [[undefined, 401], [cookies.customer, 403], [cookies.stale, 403]] as const) {
    for (const method of ['GET', 'PUT'] as const) expect((await app.inject({ method, url: '/v1/owner/smtp', ...(cookie ? { headers: { cookie } } : {}), ...(method==='PUT'?{payload:{}}:{}) })).statusCode).toBe(expected);
  }
  const headers = { cookie: cookies.owner! };
  const initial = await app.inject({ method: 'GET', url: '/v1/owner/smtp', headers }); expect(initial.statusCode).toBe(200); expect(initial.headers['cache-control']).toBe('private, no-store'); expect(initial.json()).not.toHaveProperty('password');
  const input = { host: 'smtp.mail-provider.com', port: 465, user: 'fixture@example.com', password: 'Synthetic-smtp-password9!', from: 'fixture@example.com', fromName: 'CodeBandage', revision: 'environment' };
  const saved = await app.inject({ method: 'PUT', url: '/v1/owner/smtp', headers, payload: input }); expect(saved.statusCode).toBe(200); expect(saved.json()).toMatchObject({ source: 'owner', passwordSet: true }); expect(saved.body).not.toContain(input.password); expect(verify).toHaveBeenCalledOnce();
  const row = await database.systemSetting.findUniqueOrThrow({ where: { key: SMTP_SETTING_KEY } }); expect(JSON.stringify(row.value)).not.toContain(input.password);
  const generic = await app.inject({ method: 'GET', url: '/v1/owner/control/settings', headers }); expect(generic.body).not.toContain(SMTP_SETTING_KEY); expect(generic.body).not.toContain('encryptedCredentials');
  const { password: _password, ...withoutPassword } = input; void _password;
  const kept = await app.inject({ method: 'PUT', url: '/v1/owner/smtp', headers, payload: { ...withoutPassword, fromName: 'Updated sender', revision: saved.json().revision } }); expect(kept.statusCode).toBe(200);
  expect((await app.inject({ method: 'PUT', url: '/v1/owner/smtp', headers, payload: input })).statusCode).toBe(409);
  verify.mockRejectedValueOnce(new Error('synthetic authentication failure'));
  expect((await app.inject({ method: 'PUT', url: '/v1/owner/smtp', headers, payload: { ...input, revision: kept.json().revision } })).statusCode).toBe(400);
  expect((await database.systemSetting.findUniqueOrThrow({ where: { key: SMTP_SETTING_KEY } })).updatedAt.toISOString()).toBe(kept.json().revision);
  expect((await app.inject({ method: 'POST', url: '/v1/owner/smtp/test', headers, payload: { confirm: true, recipient: 'other@example.test' } })).statusCode).toBe(400); expect(send).not.toHaveBeenCalled();
  const test = await app.inject({ method: 'POST', url: '/v1/owner/smtp/test', headers, payload: { confirm: true } }); expect(test.statusCode).toBe(200); expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: initial.json().testRecipient }));
  const audit = await database.auditLog.findMany({ where: { tenantId, action: { startsWith: 'email.smtp_' } } }); expect(audit.length).toBeGreaterThanOrEqual(3); expect(JSON.stringify(audit)).not.toContain(input.password);
});
