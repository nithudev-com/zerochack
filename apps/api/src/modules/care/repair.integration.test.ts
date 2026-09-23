import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database } from '@zerochack/database';
import { encryptSecret, hashOpaqueToken, totp } from '@zerochack/auth';
import { loadEnvironment } from '@zerochack/config';
import { digestBytes } from '@zerochack/care';
import type { AiProviderAdapter } from '@zerochack/ai-gateway';
import { buildApp } from '../../app.js';
import { AiService } from '../ai/service.js';
import { readArtifact, runOneRepair } from './repair-service.js';
import { reconcileRelease, runOneRelease } from './release-service.js';
import type { StaticTarget } from './static-target.js';

const env = loadEnvironment({ NODE_ENV: 'test', CARE_ENABLED: 'true', CARE_REPAIR_ENABLED: 'true', CARE_RELEASE_ENABLED: 'true', DATABASE_URL: process.env.DATABASE_URL, LOG_LEVEL: 'silent', REDIS_URL: 'redis://127.0.0.1:6380', CORS_ORIGINS: 'http://localhost:3000', SESSION_SECRET: 'repair-test-session-key-at-least-32-characters', CARE_VAULT_KEY: Buffer.alloc(32, 31).toString('base64'), CARE_ARTIFACT_KEY: Buffer.alloc(32, 32).toString('base64') });
const source = '<!doctype html><html lang="en"><head><title>Fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Old heading</h1></body></html>';
let testAddress = 1; beforeEach(() => { testAddress++; });
let calls = 0; let forbidden = false; let pauseDuringModel: (() => Promise<void>) | undefined;
const adapter: AiProviderAdapter = { key: 'anthropic-messages', async complete(input) { calls++; expect(input.tools).toBeUndefined(); expect(input.prompt).toContain('Old heading'); if (pauseDuringModel) await pauseDuringModel(); return { text: JSON.stringify({ summary: 'Corrected the page heading.', replacements: [{ before: 'Old heading', after: forbidden ? '<script>alert(1)</script>' : 'Correct heading' }] }), inputTokens: 100, outputTokens: 30 }; } };
let app: Awaited<ReturnType<typeof buildApp>>; let ai: AiService; let tenantId: string; let userId: string; let siteId: string; let cookie: string; let credentialId: string;
async function request(method: 'GET' | 'POST' | 'DELETE', path: string, payload?: Record<string, unknown>) { return app.inject({ remoteAddress: `192.0.2.${testAddress}`, method, url: `/v1${path}`, headers: { cookie }, ...(payload ? { payload } : {}) }); }
async function newCase() {
  const created = await request('POST', `/websites/${siteId}/jobs`, { requestKey: randomUUID(), summary: 'The page shows the old heading', expectedBehavior: 'Show Correct heading in the main heading', environment: 'STAGING' });
  expect(created.statusCode, created.body).toBe(201); const job = created.json();
  const uploaded = await request('POST', `/websites/${siteId}/artifacts`, { jobId: job.id, kind: 'SOURCE', privacyReviewed: true, base64: Buffer.from(source).toString('base64') });
  expect(uploaded.statusCode, uploaded.body).toBe(201); const artifact = uploaded.json();
  const prepared = await request('POST', `/jobs/${job.id}/change-plan`, { sourceId: artifact.id, budgetMicros: 100000 });
  expect(prepared.statusCode, prepared.body).toBe(201); return { job, artifact, revision: prepared.json() };
}
async function approve(revision: { id: string; version: number; sourceDigest: string; budgetMicros: number }) {
  return request('POST', `/change-plans/${revision.id}/approve`, { sourceDigest: revision.sourceDigest, version: revision.version, budgetMicros: revision.budgetMicros, authorizeRepair: true });
}
async function readyRelease() {
  const value = await newCase(); expect((await approve(value.revision)).statusCode).toBe(200); await runOneRepair(env, ai);
  const release = await request('POST', `/jobs/${value.job.id}/releases`, { requestKey: randomUUID(), revisionId: value.revision.id, credentialId, remotePath: '/var/www/site/index.html' });
  expect(release.statusCode, release.body).toBe(201); return release.json();
}
function transport(mode: 'healthy' | 'rollback' | 'drift' | 'unknown') {
  let current: Buffer = Buffer.from(mode === 'drift' ? 'someone else changed this page' : source); let writes = 0; let locks = 0;
  const target: StaticTarget = { async lock() { locks++; }, async read() { return current; }, async replace(bytes, expected, beforeCommit) { expect(digestBytes(current)).toBe(expected); await beforeCommit?.(); writes++; current = bytes; if (mode === 'unknown') throw new Error('response lost after mutation'); }, async unlock() { locks--; }, close() {} };
  return { dependencies: { async open() { return target; }, async health(_url: string, expected: string) { return digestBytes(current) === expected && !(mode === 'rollback' && expected !== digestBytes(source)); } }, result: () => ({ writes, locks, current }) };
}
beforeAll(async () => {
  if (!new URL(env.DATABASE_URL).pathname.includes('test')) throw new Error('A disposable test database is required.');
  app = await buildApp(env, { aiAdapters: [adapter] }); ai = new AiService(env, undefined, [adapter]);
  tenantId = (await database.tenant.create({ data: { name: 'Repair fixture', slug: `repair-${randomUUID()}` } })).id;
  userId = (await database.user.create({ data: { email: `repair-${randomUUID()}@example.test`, passwordHash: 'unused', status: 'APPROVED', emailVerifiedAt: new Date() } })).id;
  const role = await database.role.findFirstOrThrow({ where: { name: 'Customer', tenantId: null } });
  await database.tenantMembership.create({ data: { tenantId, userId, status: 'ACTIVE' } }); await database.userRole.create({ data: { tenantId, userId, roleId: role.id } });
  const token = randomUUID(); cookie = `zerochack_session=${token}`; await database.session.create({ data: { tenantId, userId, tokenHash: hashOpaqueToken(token, env.SESSION_SECRET), expiresAt: new Date(Date.now() + 3600000) } });
  siteId = (await database.website.create({ data: { tenantId, name: 'Standalone fixture', url: 'https://example.com/', normalizedHost: 'example.com', connectionStatus: 'VERIFIED' } })).id;
  await database.aiTenantPolicy.create({ data: { tenantId, enabled: true, dailyCostLimitMicros: 2000000, requestsPerMinute: 100, requestsPerUserMinute: 100 } });
  const provider = await database.aiProvider.create({ data: { name: `Repair fixture ${randomUUID()}`, adapterKey: adapter.key, enabled: true, requestsPerMinute: 100 } });
  await database.aiCredential.create({ data: { providerId: provider.id, label: 'Synthetic adapter credential', encryptedSecret: encryptSecret('synthetic-provider-key', env.AI_CREDENTIAL_ENCRYPTION_KEY) } });
  await database.aiModel.create({ data: { providerId: provider.id, name: 'Fixture model', providerModel: 'fixture-model', maxOutputTokens: 1024, inputCostMicrosPerM: 1000000, outputCostMicrosPerM: 1000000, requestsPerMinute: 100 } });
  const setup = await request('POST', '/auth/mfa/setup'); expect(setup.statusCode, setup.body).toBe(200); const code = totp(setup.json().secret);
  expect((await request('POST', '/auth/mfa/enable', { code })).statusCode).toBe(200); expect((await request('POST', '/auth/mfa/step-up', { code })).statusCode).toBe(200);
  const captured = await request('POST', `/websites/${siteId}/chat/ingest`, { mode: 'SECURE', idempotencyKey: randomUUID(), content: 'Host: server.example.com\nUsername: deployment\nPassword: synthetic-server-credential', environment: 'PRODUCTION', authorizationConfirmed: true });
  expect(captured.statusCode, captured.body).toBe(201); credentialId = captured.json().credentials[0].id;
  await database.website.update({ where: { id: siteId }, data: { connectionStatus: 'VERIFIED' } });
  await database.websiteAccessCredential.update({ where: { websiteId: siteId }, data: { hostKeyFingerprint: `SHA256:${Buffer.alloc(32, 12).toString('base64')}` } });
});
afterAll(async () => { await app?.close(); await database.$disconnect(); });

describe.sequential('approved static repair and deterministic release with real authorization and persistence', () => {
  it('queues only exact approvals, persists a verified candidate and keeps source out of chat/usage', async () => {
    const value = await newCase(); const stored = await database.careArtifact.findUniqueOrThrow({ where: { id: value.artifact.id } }); expect(stored.encryptedBody).not.toContain(source);
    expect((await approve({ ...value.revision, sourceDigest: 'a'.repeat(64) })).statusCode).toBe(409);
    expect((await approve(value.revision)).statusCode).toBe(200); expect((await approve(value.revision)).statusCode).toBe(409);
    const before = calls; expect(await runOneRepair(env, ai)).toBe(true); expect(calls, (await database.careJob.findUniqueOrThrow({ where: { id: value.job.id } })).errorCode ?? 'model invocation').toBe(before + 1); expect(await runOneRepair(env, ai)).toBe(false);
    const revision = await database.careRevision.findUniqueOrThrow({ where: { id: value.revision.id } }); expect(revision).toMatchObject({ state: 'VERIFIED', budgetState: 'SETTLED', chargedMicros: 130 });
    const candidate = await database.careArtifact.findUniqueOrThrow({ where: { id: revision.candidateId! } }); expect(readArtifact(candidate, env).toString()).toContain('<h1>Correct heading</h1>');
    const preview = await request('GET', `/artifacts/${candidate.id}/preview`); expect(preview.headers['cache-control']).toContain('no-store'); expect(preview.json().html).toContain('Content-Security-Policy');
    expect((await database.aiUsage.findUniqueOrThrow({ where: { id: revision.usageId! } })).responseText).toBeNull();
    expect(JSON.stringify(await database.chatMessage.findMany({ where: { websiteId: siteId } }))).not.toContain('<!doctype');
  });
  it('blocks another tenant, executable attachments, and changed approvals', async () => {
    const value = await newCase();
    const blocked = await request('POST', `/websites/${siteId}/artifacts`, { jobId: value.job.id, kind: 'SOURCE', privacyReviewed: true, base64: Buffer.from('<script>alert(1)</script>').toString('base64') }); expect(blocked.statusCode).toBe(400);
    const foreign = await database.tenant.create({ data: { name: 'Other fixture', slug: randomUUID() } }); const site = await database.website.create({ data: { tenantId: foreign.id, name: 'Other', url: 'https://example.org', normalizedHost: 'example.org' } });
    expect((await request('POST', `/websites/${site.id}/artifacts`, { jobId: value.job.id, kind: 'SOURCE', privacyReviewed: true, base64: Buffer.from(source).toString('base64') })).statusCode).toBe(404);
    expect((await request('POST', `/jobs/${value.job.id}/feedback`, { content: 'Use the heading Correct heading and retain the original spacing.' })).statusCode).toBe(200);
    expect((await approve(value.revision)).statusCode).toBe(409);
    const changed = await database.careJob.findUniqueOrThrow({ where: { id: value.job.id } }); expect(changed.planVersion).toBe(value.revision.version + 1); expect(changed.expectedBehavior).toContain('original spacing'); expect(changed.expectedBehavior).toContain('Show Correct heading in the main heading');
  });
  it('rejects an unsafe model patch and settles measured usage without creating a candidate', async () => {
    const value = await newCase(); await approve(value.revision); forbidden = true;
    try { await runOneRepair(env, ai); } finally { forbidden = false; }
    expect(await database.careRevision.findUniqueOrThrow({ where: { id: value.revision.id } })).toMatchObject({ state: 'FAILED', candidateId: null, budgetState: 'SETTLED', chargedMicros: 130 });
  });
  it('fences an in-flight candidate after customer cancellation', async () => {
    const value = await newCase(); await approve(value.revision); pauseDuringModel = async () => { expect((await request('POST', `/jobs/${value.job.id}/cancel`)).statusCode).toBe(200); };
    try { await runOneRepair(env, ai); } finally { pauseDuringModel = undefined; }
    expect(await database.careJob.findUniqueOrThrow({ where: { id: value.job.id } })).toMatchObject({ state: 'CANCELLED' });
    expect(await database.careArtifact.count({ where: { jobId: value.job.id, kind: 'CANDIDATE' } })).toBe(0);
  });
  it('reserves the tenant allowance and releases unused budget after cancellation', async () => {
    const first = await newCase(); const second = await newCase();
    await database.aiTenantPolicy.update({ where: { tenantId }, data: { dailyCostLimitMicros: 101000 } });
    expect((await approve(first.revision)).statusCode).toBe(200); expect((await approve(second.revision)).json().error.code).toBe('BUDGET_EXCEEDED');
    expect((await request('POST', `/jobs/${first.job.id}/cancel`)).statusCode).toBe(200);
    expect((await approve(second.revision)).statusCode).toBe(200); await request('POST', `/jobs/${second.job.id}/cancel`);
    expect((await database.careRevision.findUniqueOrThrow({ where: { id: first.revision.id } })).budgetState).toBe('RELEASED');
    await database.aiTenantPolicy.update({ where: { tenantId }, data: { dailyCostLimitMicros: 2000000 } });
  });
  it('rechecks the exact account version before opening a release connection', async () => {
    const release = await readyRelease();
    expect((await request('POST', `/releases/${release.id}/approve`, { candidateDigest: release.candidateDigest, sourceDigest: release.sourceDigest, credentialId, remotePath: release.remotePath, authorizeProductionAndRollback: true })).statusCode).toBe(200);
    await database.careCredential.update({ where: { id: credentialId }, data: { version: 2 } });
    let opened = false;
    try { await runOneRelease(env, { async open() { opened = true; throw new Error('should not connect'); }, async health() { return true; } }); }
    finally { await database.careCredential.update({ where: { id: credentialId }, data: { version: 1 } }); }
    expect(opened).toBe(false); expect(await database.careRelease.findUniqueOrThrow({ where: { id: release.id } })).toMatchObject({ state: 'FAILED', errorCode: 'APPROVAL_STALE' });
  });
  it('cancels an approved but unstarted release without opening its target', async () => {
    const release = await readyRelease();
    expect((await request('POST', `/releases/${release.id}/approve`, { candidateDigest: release.candidateDigest, sourceDigest: release.sourceDigest, credentialId, remotePath: release.remotePath, authorizeProductionAndRollback: true })).statusCode).toBe(200);
    expect((await request('POST', `/releases/${release.id}/cancel`)).statusCode).toBe(200);
    let opened = false; expect(await runOneRelease(env, { async open() { opened = true; throw new Error('should not connect'); }, async health() { return true; } })).toBe(false); expect(opened).toBe(false);
  });
  for (const mode of ['healthy','rollback','drift','unknown'] as const) {
    it(`handles ${mode} release evidence without replaying an uncertain write`, async () => {
      const release = await readyRelease();
      const approved = await request('POST', `/releases/${release.id}/approve`, { candidateDigest: release.candidateDigest, sourceDigest: release.sourceDigest, credentialId, remotePath: release.remotePath, authorizeProductionAndRollback: true }); expect(approved.statusCode, approved.body).toBe(200);
      expect((await request('POST', `/jobs/${release.jobId}/feedback`, { content: 'A changed requirement while publishing' })).statusCode).toBe(400);
      const fixture = transport(mode); expect(await runOneRelease(env, fixture.dependencies)).toBe(true);
      let stored = await database.careRelease.findUniqueOrThrow({ where: { id: release.id } }); expect(stored.state).toBe(mode === 'healthy' ? 'COMPLETED' : mode === 'rollback' ? 'ROLLED_BACK' : mode === 'drift' ? 'FAILED' : 'OUTCOME_UNKNOWN');
      expect(fixture.result().writes).toBe(mode === 'drift' ? 0 : mode === 'rollback' ? 2 : 1);
      if (mode !== 'drift') { expect(stored.backupId).not.toBeNull(); expect(readArtifact(await database.careArtifact.findUniqueOrThrow({ where: { id: stored.backupId! } }), env).toString()).toBe(source); }
      expect(await runOneRelease(env, fixture.dependencies)).toBe(false);
      if (mode === 'unknown') {
        await expect(reconcileRelease(release.id, env, fixture.dependencies)).rejects.toMatchObject({ code: 'RECONCILIATION_NOT_READY' });
        await database.careRelease.update({ where: { id: release.id }, data: { heartbeatAt: new Date(Date.now() - 130000) } });
        expect(await reconcileRelease(release.id, env, fixture.dependencies)).toEqual({ state: 'COMPLETED' }); expect(fixture.result().writes).toBe(1);
        stored = await database.careRelease.findUniqueOrThrow({ where: { id: release.id } }); expect(stored.state).toBe('COMPLETED');
      }
    });
  }
});
