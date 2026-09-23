import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database } from '@zerochack/database';
import { hashOpaqueToken, totp } from '@zerochack/auth';
import { loadEnvironment } from '@zerochack/config';
import { brokerSecret } from './service.js';
import { maintainCareRecords } from '../../../../worker/src/care-maintenance.js';
import { buildApp } from '../../app.js';

const environment = loadEnvironment({ NODE_ENV: 'test', CARE_ENABLED: 'true', DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: 'redis://127.0.0.1:6380', SESSION_SECRET: 'care-test-session-secret-at-least-32-characters', CARE_VAULT_KEY: Buffer.alloc(32, 19).toString('base64'), CORS_ORIGINS: 'http://localhost:3000', LOG_LEVEL: 'silent' });
let app: Awaited<ReturnType<typeof buildApp>>;
type Actor = { userId: string; tenantId: string; cookie: string; sessionId: string };
let customer: Actor; let other: Actor; let specialist: Actor; let siteId: string; let ticketId: string; let credentialId: string; let grantId: string;
const marker = 'synthetic-care-secret-for-boundary-tests';
const captureKey = randomUUID();
async function actor(name: 'Customer' | 'Cybersecurity Specialist'): Promise<Actor> {
  const id = randomUUID(); const token = randomUUID();
  const tenant = await database.tenant.create({ data: { name: `Care ${id}`, slug: `care-${id}` } });
  const user = await database.user.create({ data: { email: `care-${id}@example.test`, displayName: name === 'Customer' ? 'Test customer' : 'Assigned specialist', passwordHash: 'not-used-session-fixture', status: 'APPROVED', emailVerifiedAt: new Date() } });
  const role = await database.role.findFirstOrThrow({ where: { name, tenantId: null } });
  await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: 'ACTIVE' } });
  await database.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
  const session = await database.session.create({ data: { tenantId: tenant.id, userId: user.id, tokenHash: hashOpaqueToken(token, environment.SESSION_SECRET), expiresAt: new Date(Date.now() + 3600000) } });
  return { userId: user.id, tenantId: tenant.id, cookie: `zerochack_session=${token}`, sessionId: session.id };
}
beforeAll(async () => {
  if (!new URL(environment.DATABASE_URL).pathname.includes('test')) throw new Error('Care integration suite requires a disposable test database.');
  app = await buildApp(environment); customer = await actor('Customer'); other = await actor('Customer'); specialist = await actor('Cybersecurity Specialist');
  const site = await database.website.create({ data: { tenantId: customer.tenantId, name: 'Care website', url: 'https://example.test', normalizedHost: 'example.test' } }); siteId = site.id;
  const ticket = await database.ticket.create({ data: { tenantId: customer.tenantId, websiteId: siteId, title: 'Approved access assistance', status: 'ACCEPTED', assignedSpecialistId: specialist.userId } }); ticketId = ticket.id;
});
afterAll(async () => { await app?.close(); await database.$disconnect(); });

describe.sequential('care routes through actual authentication and database paths', () => {
  it('isolates record tools by tenant and returns no account secrets or unbounded errors', async () => {
    const job = await database.careJob.create({ data: { tenantId: customer.tenantId, websiteId: siteId, userId: customer.userId, requestKey: randomUUID(), kind: 'REPAIR', environment: 'PRODUCTION', summary: 'Scoped record tool fixture', state: 'FAILED', errorCode: marker } });
    const url = `/v1/jobs/${job.id}/tools/`;
    expect((await app.inject({ method: 'POST', url: url + 'T03', headers: { cookie: other.cookie }, payload: {} })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: url + 'T03', payload: {} })).statusCode).toBe(401);
    const access = await app.inject({ method: 'POST', url: url + 'T03', headers: { cookie: customer.cookie }, payload: {} });
    expect(access.statusCode).toBe(200); expect(access.headers['cache-control']).toContain('no-store');
    expect(access.json().output).toMatchObject({ secretDisclosure: false, connectionStatus: 'NOT_CHECKED' });
    const errors = await app.inject({ method: 'POST', url: url + 'T57', headers: { cookie: customer.cookie }, payload: {} });
    expect(errors.json().output.job.errorCode).toBe('REDACTED_ERROR'); expect(errors.body).not.toContain(marker);
    await database.careJob.update({ where: { id: job.id }, data: { errorCode: null } });
    await database.monitoringPolicy.upsert({ where: { websiteId: siteId }, create: { tenantId: customer.tenantId, websiteId: siteId, enabled: false, intervalMinutes: 60 }, update: { enabled: false } });
    await database.monitoringCheck.create({ data: { tenantId: customer.tenantId, websiteId: siteId, jobId: randomUUID(), status: 'SUCCEEDED', completedAt: new Date(Date.now() - 24 * 3600000), responseTimeMs: 125 } });
    const health = await app.inject({ method: 'POST', url: url + 'T58', headers: { cookie: customer.cookie }, payload: {} });
    expect(health.json().output).toMatchObject({ state: 'RECORDED_EVIDENCE', stale: true, policy: { enabled: false }, lastCheck: { responseTimeMs: 125 } });
  });
  it('saves idempotent monitoring proposals without activating scheduling and retains cancelled history', async () => {
    const parent = await database.careJob.create({ data: { tenantId: customer.tenantId, websiteId: siteId, userId: customer.userId, requestKey: randomUUID(), kind: 'REPAIR', environment: 'PRODUCTION', summary: 'Monitoring proposal fixture', state: 'WAITING_FOR_INPUT' } });
    const url = `/v1/jobs/${parent.id}/monitoring-plan`; const headers = { cookie: customer.cookie };
    const payload = { requestKey: randomUUID(), intervalMinutes: 60, alertCooldownMinutes: 120, expectedStatus: 200 };
    const created = await app.inject({ method: 'POST', url, headers, payload }); expect(created.statusCode, created.body).toBe(201);
    expect(created.json().proposal).toMatchObject({ activation: 'NOT_SCHEDULED', requiresCustomerApproval: true });
    const again = await app.inject({ method: 'POST', url, headers, payload }); expect(again.statusCode).toBe(200); expect(again.json().proposalJobId).toBe(created.json().proposalJobId);
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, intervalMinutes: 30 } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url, headers: { cookie: other.cookie }, payload })).statusCode).toBe(404);
    expect((await database.monitoringPolicy.findUniqueOrThrow({ where: { websiteId: siteId } })).enabled).toBe(false);
    expect((await app.inject({ method: 'POST', url: `/v1/jobs/${created.json().proposalJobId}/cancel`, headers })).statusCode).toBe(200);
    const saved = await database.careJob.findUniqueOrThrow({ where: { id: created.json().proposalJobId } }); expect(saved.state).toBe('CANCELLED'); expect(JSON.parse(saved.expectedBehavior!)).toMatchObject({ parentJobId: parent.id, intervalMinutes: 60 });
    await database.careJob.update({ where: { id: parent.id }, data: { environment: 'STAGING' } });
    expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, requestKey: randomUUID() } })).statusCode).toBe(409);
  });
  it('blocks secrets in human handoff requests before creating a ticket', async () => {
    const before = await database.ticket.count({ where: { websiteId: siteId } });
    const result = await app.inject({ method: 'POST', url: `/v1/websites/${siteId}/tickets`, headers: { cookie: customer.cookie }, payload: { title: 'Please review the supplied issue', description: `password: ${marker}` } });
    expect(result.statusCode).toBe(400); expect(result.json().error.code).toBe('SENSITIVE_CONTENT_BLOCKED'); expect(result.body).not.toContain(marker);
    expect(await database.ticket.count({ where: { websiteId: siteId } })).toBe(before);
  });
  it('requires explicit authority and keeps ambiguous submissions out of storage', async () => {
    const url = `/v1/websites/${siteId}/chat/ingest`;
    expect((await app.inject({ method: 'POST', url, headers: { cookie: customer.cookie }, payload: { mode: 'SECURE', idempotencyKey: randomUUID(), content: marker, environment: 'PRODUCTION', authorizationConfirmed: false } })).statusCode).toBe(400);
    const ambiguous = await app.inject({ method: 'POST', url, headers: { cookie: customer.cookie }, payload: { mode: 'SECURE', idempotencyKey: randomUUID(), content: marker, environment: 'PRODUCTION', authorizationConfirmed: true } });
    expect(ambiguous.statusCode).toBe(400); expect(ambiguous.body).not.toContain(marker);
    expect(await database.careCredential.count({ where: { websiteId: siteId } })).toBe(0);
    expect(await database.chatMessage.count({ where: { websiteId: siteId } })).toBe(0);
  });
  it('stores an encrypted envelope, a safe receipt and a broker reference without calling AI', async () => {
    const response = await app.inject({ method: 'POST', url: `/v1/websites/${siteId}/chat/ingest`, headers: { cookie: customer.cookie }, payload: { mode: 'SECURE', idempotencyKey: captureKey, content: `Type: SSH\nHost: server.example.test\nUsername: deploy\nPassword: ${marker}`, environment: 'PRODUCTION', authorizationConfirmed: true } });
    expect(response.statusCode).toBe(201); expect(response.body).not.toContain(marker); expect(response.json().connectionStatus).toBe('NOT_CHECKED'); credentialId = response.json().credentials[0].id;
    const stored = await database.careCredential.findUniqueOrThrow({ where: { id: credentialId } }); expect(stored.encryptedEnvelope).toMatch(/^zr1\./); expect(stored.encryptedEnvelope).not.toContain(marker);
    const capturedJob = await database.careJob.findUniqueOrThrow({ where: { tenantId_websiteId_requestKey: { tenantId: customer.tenantId, websiteId: siteId, requestKey: captureKey } } });
    const capabilities = await app.inject({ method: 'POST', url: `/v1/jobs/${capturedJob.id}/tools/T03`, headers: { cookie: customer.cookie }, payload: {} });
    expect(capabilities.json().output).toMatchObject({ credentialTypes: ['SSH'], recordedAccounts: 1, secretDisclosure: false });
    expect(capabilities.body).not.toContain(marker); expect(capabilities.body).not.toContain('server.example.test'); expect(capabilities.body).not.toContain('encryptedEnvelope');
    const bridge = await database.websiteAccessCredential.findUniqueOrThrow({ where: { websiteId: siteId } }); expect(bridge.encryptedSecret).toBe(''); expect(bridge.vaultCredentialId).toBe(credentialId);
    for (const data of [await database.chatMessage.findMany({ where: { websiteId: siteId } }), await database.careEvent.findMany({ where: { websiteId: siteId } }), await database.auditLog.findMany({ where: { tenantId: customer.tenantId } })]) expect(JSON.stringify(data)).not.toContain(marker);
    expect(await database.aiUsage.count({ where: { tenantId: customer.tenantId } })).toBe(0);
  });
  it('makes secure retries idempotent and separates staging history from production', async () => {
    const payload = { mode: 'SECURE', idempotencyKey: captureKey, content: `Type: SSH\nHost: server.example.test\nUsername: deploy\nPassword: ${marker}`, environment: 'PRODUCTION', authorizationConfirmed: true };
    const retry = await app.inject({ method: 'POST', url: `/v1/websites/${siteId}/chat/ingest`, headers: { cookie: customer.cookie }, payload });
    expect(retry.statusCode).toBe(201); expect(retry.json().duplicate).toBe(true);
    expect(await database.careCredential.count({ where: { websiteId: siteId } })).toBe(1);
    const staging = await app.inject({ method: 'POST', url: `/v1/websites/${siteId}/chat/ingest`, headers: { cookie: customer.cookie }, payload: { ...payload, idempotencyKey: randomUUID(), environment: 'STAGING' } });
    expect(staging.statusCode).toBe(201);
    for (const scope of ['STAGING', 'PRODUCTION']) {
      const history = await app.inject({ method: 'GET', url: `/v1/websites/${siteId}/chat?environment=${scope}`, headers: { cookie: customer.cookie } });
      expect(history.statusCode).toBe(200); expect(history.json()).toHaveLength(1); expect(history.json()[0].environment).toBe(scope); expect(history.body).not.toContain(marker);
    }
    expect((await database.websiteAccessCredential.findUniqueOrThrow({ where: { websiteId: siteId } })).vaultCredentialId).toBe(credentialId);
  });
  it('isolates another customer and does not expose secret ciphertext in snapshots', async () => {
    const url = `/v1/websites/${siteId}/care`;
    expect((await app.inject({ method: 'GET', url, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    const snapshot = await app.inject({ method: 'GET', url, headers: { cookie: customer.cookie } }); expect(snapshot.statusCode).toBe(200); expect(snapshot.body).not.toContain('encryptedEnvelope'); expect(snapshot.body).not.toContain(marker);
  });
  it('binds specialist requests to active assignments and requires the customer decision', async () => {
    const response = await app.inject({ method: 'POST', url: '/v1/specialist/access-requests', headers: { cookie: specialist.cookie }, payload: { ticketId, credentialId, reason: 'Inspect the customer-approved connection configuration', durationMinutes: 15 } });
    expect(response.statusCode).toBe(201); grantId = response.json().id;
    expect((await app.inject({ method: 'POST', url: `/v1/specialist/credential-grants/${grantId}/reveal`, headers: { cookie: specialist.cookie } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: `/v1/access-requests/${grantId}/approve`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/access-requests/${grantId}/approve`, headers: { cookie: customer.cookie } })).statusCode).toBe(200);
  });
  it('requires fresh MFA, returns only the approved value with no-store, and audits without it', async () => {
    const url = `/v1/specialist/credential-grants/${grantId}/reveal`;
    expect((await app.inject({ method: 'POST', url, headers: { cookie: specialist.cookie } })).json().error.code).toBe('MFA_REQUIRED');
    const setup = await app.inject({ method: 'POST', url: '/v1/auth/mfa/setup', headers: { cookie: specialist.cookie } });
    expect(setup.statusCode).toBe(200); const code = totp(setup.json().secret);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/mfa/enable', headers: { cookie: specialist.cookie }, payload: { code } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/v1/auth/mfa/step-up', headers: { cookie: specialist.cookie }, payload: { code } })).statusCode).toBe(200);
    const revealed = await app.inject({ method: 'POST', url, headers: { cookie: specialist.cookie } }); expect(revealed.statusCode).toBe(200); expect(revealed.json().secret).toBe(marker); expect(revealed.headers['cache-control']).toContain('no-store');
    const audit = await database.auditLog.findMany({ where: { resourceId: grantId } }); expect(audit.some((row) => row.action === 'care.credential_disclosed')).toBe(true); expect(JSON.stringify(audit)).not.toContain(marker);
  });
  it('rechecks assignment after approval and refuses a reassigned ticket', async () => {
    await database.ticket.update({ where: { id: ticketId }, data: { assignedSpecialistId: null } });
    const denied = await app.inject({ method: 'POST', url: `/v1/specialist/credential-grants/${grantId}/reveal`, headers: { cookie: specialist.cookie } });
    expect(denied.statusCode).toBe(403); expect(denied.body).not.toContain(marker);
    await database.ticket.update({ where: { id: ticketId }, data: { assignedSpecialistId: specialist.userId } });
  });
  it('revokes future disclosure and broker use and removes secret material', async () => {
    expect((await app.inject({ method: 'DELETE', url: `/v1/websites/${siteId}/credentials/${credentialId}`, headers: { cookie: customer.cookie } })).statusCode).toBe(204);
    expect((await app.inject({ method: 'POST', url: `/v1/specialist/credential-grants/${grantId}/reveal`, headers: { cookie: specialist.cookie } })).statusCode).toBe(403);
    expect((await database.careCredential.findUniqueOrThrow({ where: { id: credentialId } })).encryptedEnvelope).toBe('');
    expect(await database.websiteAccessCredential.findUnique({ where: { websiteId: siteId } })).toBeNull();
    await expect(brokerSecret({ tenantId: customer.tenantId, websiteId: siteId, vaultCredentialId: credentialId, encryptedSecret: '' }, environment)).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' });
  });
  it('revokes vault references when the existing access form replaces credentials', async () => {
    const capture = await app.inject({ method: 'POST', url: `/v1/websites/${siteId}/chat/ingest`, headers: { cookie: customer.cookie }, payload: { mode: 'SECURE', idempotencyKey: randomUUID(), content: `Host: server.example.test\nUsername: deploy\nPassword: ${marker}`, environment: 'PRODUCTION', authorizationConfirmed: true } });
    expect(capture.statusCode).toBe(201); const currentId = capture.json().credentials[0].id;
    const replacement = await app.inject({ method: 'PUT', url: `/v1/websites/${siteId}/access`, headers: { cookie: customer.cookie }, payload: { host: 'server.example.com', port: 22, username: 'deploy', authMethod: 'PASSWORD', secret: 'synthetic-legacy-replacement', authorizationConfirmed: true } });
    expect(replacement.statusCode, replacement.body).toBe(200);
    expect(await database.careCredential.findUniqueOrThrow({ where: { id: currentId } })).toMatchObject({ status: 'REVOKED', encryptedEnvelope: '' });
    expect((await database.websiteAccessCredential.findUniqueOrThrow({ where: { websiteId: siteId } })).vaultCredentialId).toBeNull();
  });

  it('expires stored material and marks lost worker heartbeats stale without replay', async () => {
    const now = new Date();
    const staging = await database.careCredential.findFirstOrThrow({ where: { websiteId: siteId, environment: 'STAGING', status: 'STORED' } });
    await database.careCredential.update({ where: { id: staging.id }, data: { authorizationExpiresAt: new Date(now.getTime() - 1000) } });
    const job = await database.careJob.create({ data: { tenantId: customer.tenantId, websiteId: siteId, userId: customer.userId, requestKey: randomUUID(), environment: 'STAGING', kind: 'REPAIR', state: 'RUNNING', summary: 'Synthetic lost worker fixture', heartbeatAt: new Date(now.getTime() - 100000) } });
    await maintainCareRecords(now);
    expect(await database.careCredential.findUniqueOrThrow({ where: { id: staging.id } })).toMatchObject({ status: 'EXPIRED', encryptedEnvelope: '' });
    expect(await database.careJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: 'STALE', leaseVersion: 1, errorCode: 'WORKER_HEARTBEAT_LOST' });
    const events = await database.careEvent.findMany({ where: { jobId: job.id } }); expect(events.map((event) => event.eventType)).toEqual(['job.stale']);
  });

  it('resumes authenticated activity in the selected environment without replaying old events', async () => {
    const base = await app.listen({ host: '127.0.0.1', port: 0 });
    const before = await database.careEvent.create({ data: { tenantId: customer.tenantId, websiteId: siteId, environment: 'STAGING', eventType: 'fixture.before', state: 'COMPLETED', summary: 'Before reconnect' } });
    await database.careEvent.create({ data: { tenantId: customer.tenantId, websiteId: siteId, environment: 'PRODUCTION', eventType: 'fixture.production', state: 'COMPLETED', summary: 'Different environment' } });
    const after = await database.careEvent.create({ data: { tenantId: customer.tenantId, websiteId: siteId, environment: 'STAGING', eventType: 'fixture.after', state: 'COMPLETED', summary: 'After reconnect' } });
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const denied = await fetch(`${base}/v1/websites/${siteId}/activity/stream`, { headers: { cookie: other.cookie } }); expect(denied.status).toBe(404);
      const stream = await fetch(`${base}/v1/websites/${siteId}/activity/stream?environment=STAGING`, { headers: { cookie: customer.cookie, 'last-event-id': String(before.sequence) }, signal: controller.signal });
      expect(stream.status).toBe(200); expect(stream.headers.get('content-type')).toContain('text/event-stream');
      const reader = stream.body!.getReader(); const chunk = await reader.read(); const event = new TextDecoder().decode(chunk.value);
      expect(event).toContain(`id: ${after.sequence}`); expect(event).toContain('fixture.after'); expect(event).not.toContain('fixture.before'); expect(event).not.toContain('fixture.production'); expect(event).not.toContain(marker);
      await database.careEvent.create({ data: { tenantId: customer.tenantId, websiteId: siteId, environment: 'STAGING', eventType: 'fixture.live', state: 'COMPLETED', summary: 'Persisted after connection' } });
      const next = await reader.read(); expect(new TextDecoder().decode(next.value)).toContain('fixture.live');
    } finally { clearTimeout(timeout); controller.abort(); }
  });

  it('pages all saved messages and jobs with stable ties, latest-first windows and scoped cursors', async () => {
    const savedSite = await database.website.create({ data: { tenantId: customer.tenantId, name: 'History fixture', url: 'https://history.example.test', normalizedHost: 'history.example.test' } });
    const sameTime = new Date('2026-01-01T00:00:00Z');
    const messageIds = Array.from({ length: 205 }, () => randomUUID()).sort();
    await database.chatMessage.createMany({ data: messageIds.map((id, index) => ({ id, tenantId: customer.tenantId, websiteId: savedSite.id, type: 'SYSTEM', environment: 'PRODUCTION', content: `Saved entry ${index}`, createdAt: sameTime })) });
    // Pairs share a timestamp; adjacent pairs differ by one microsecond, which JS Date loses.
    await database.$executeRaw`WITH numbered AS (SELECT id, (row_number() OVER (ORDER BY id) - 1) / 2 AS position FROM chat_messages WHERE website_id = ${savedSite.id}::uuid) UPDATE chat_messages SET created_at = ${sameTime}::timestamptz + numbered.position * interval '1 microsecond' FROM numbered WHERE chat_messages.id = numbered.id`;
    const staging = await database.chatMessage.create({ data: { tenantId: customer.tenantId, websiteId: savedSite.id, type: 'SYSTEM', environment: 'STAGING', content: 'Staging-only history' } });
    const get = (suffix: string, cookie = customer.cookie) => app.inject({ method: 'GET', url: `/v1/websites/${savedSite.id}/${suffix}`, headers: { cookie } });
    const latest = await get('chat'); expect(latest.json()).toHaveLength(200); expect(latest.json()[199].id).toBe(messageIds[204]);
    const older = await get(`chat?before=${latest.json()[0].id}`);
    expect(older.json().map((item: { id: string }) => item.id)).toEqual(messageIds.slice(0, 5));
    expect((await get(`chat?before=${staging.id}`)).statusCode).toBe(404);
    expect((await get('chat', other.cookie)).statusCode).toBe(404);
    const jobIds = Array.from({ length: 32 }, () => randomUUID()).sort();
    await database.careJob.createMany({ data: jobIds.map((id) => ({ id, tenantId: customer.tenantId, websiteId: savedSite.id, userId: customer.userId, requestKey: randomUUID(), kind: 'REPAIR', state: 'WAITING_FOR_INPUT', environment: 'PRODUCTION', summary: 'Saved job history', createdAt: sameTime })) });
    await database.$executeRaw`WITH numbered AS (SELECT id, (row_number() OVER (ORDER BY id) - 1) / 2 AS position FROM care_jobs WHERE website_id = ${savedSite.id}::uuid) UPDATE care_jobs SET created_at = ${sameTime}::timestamptz + numbered.position * interval '1 microsecond' FROM numbered WHERE care_jobs.id = numbered.id`;
    const first = (await get('care?environment=PRODUCTION')).json(); expect(first.jobs).toHaveLength(30);
    const next = (await get(`care?environment=PRODUCTION&before=${first.nextCursor}`)).json(); expect(next.jobs.map((job: { id: string }) => job.id)).toEqual(jobIds.slice(0, 2).reverse()); expect(next.nextCursor).toBeNull();
    expect((await get(`care?environment=STAGING&before=${first.nextCursor}`)).statusCode).toBe(404);
    expect((await get('care', other.cookie)).statusCode).toBe(404);
  });

  it('reports actual recovery gaps without treating configuration or staging as verified recovery', async () => {
    const url = `/v1/websites/${siteId}/care/recovery`;
    const result = await app.inject({ method: 'GET', url, headers: { cookie: customer.cookie } });
    expect(result.statusCode).toBe(200);
    expect(result.json().checks).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Verified backup record', state: 'MISSING' }), expect.objectContaining({ name: 'Clean restore drill', state: 'NOT_VERIFIED' })]));
    expect((await app.inject({ method: 'GET', url: `${url}?environment=STAGING`, headers: { cookie: customer.cookie } })).json().state).toBe('NOT_OBSERVED');
    expect((await app.inject({ method: 'GET', url, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    await database.backupPolicy.create({ data: { tenantId: customer.tenantId, websiteId: siteId, enabled: true } });
    const configured = (await app.inject({ method: 'GET', url, headers: { cookie: customer.cookie } })).json();
    expect(configured.checks.find((check: { name: string }) => check.name === 'Scheduled backups').state).toBe('CONFIGURED');
    expect(configured.checks.find((check: { name: string }) => check.name === 'Verified backup record').state).toBe('MISSING');
    const backup = await database.backup.create({ data: { tenantId: customer.tenantId, websiteId: siteId, status: 'SUCCEEDED', verifiedAt: new Date(), integrityHash: 'a'.repeat(64), restoreReference: 'fixture://record-only', retentionUntil: new Date(0) } });
    const expired = (await app.inject({ method: 'GET', url, headers: { cookie: customer.cookie } })).json();
    expect(expired.checks.find((check: { name: string }) => check.name === 'Verified backup record').state).toBe('MISSING');
    await database.backup.update({ where: { id: backup.id }, data: { retentionUntil: new Date(Date.now() + 86400000) } });
    const retained = (await app.inject({ method: 'GET', url, headers: { cookie: customer.cookie } })).json();
    expect(retained.checks.find((check: { name: string }) => check.name === 'Verified backup record').state).toBe('RECORDED');
    expect(retained.checks.find((check: { name: string }) => check.name === 'Clean restore drill').state).toBe('NOT_VERIFIED');
  });

});
