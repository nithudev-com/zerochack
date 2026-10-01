import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database } from '@zerochack/database';
import { hashOpaqueToken } from '@zerochack/auth';
import { loadEnvironment } from '@zerochack/config';
import { REVIEW_POLICY_VERSION, VERIFICATION_POLICY } from '@zerochack/care';
import { buildApp } from '../../app.js';
import { writeArtifact } from './repair-service.js';
import type { VerificationInput, VerificationAdapter } from './verification-runner.js';
const env = loadEnvironment({ NODE_ENV: 'test', CARE_ENABLED: 'true', CARE_REVIEW_ENABLED: 'true', CARE_VERIFICATION_ENABLED: 'true', CARE_VERIFICATION_IMAGE: `sha256:${'a'.repeat(64)}`, DATABASE_URL: process.env.DATABASE_URL, LOG_LEVEL: 'silent', REDIS_URL: 'redis://127.0.0.1:6380', CORS_ORIGINS: 'http://localhost:3000', SESSION_SECRET: 'verification-test-session-key-at-least-32-characters', CARE_ARTIFACT_KEY: Buffer.alloc(32, 44).toString('base64') });
let app: Awaited<ReturnType<typeof buildApp>>; let tenantId: string; let userId: string; let siteId: string; let jobId: string; let cookie: string; let foreignCookie: string; let address = 1;
let duringVerification: (() => Promise<void>) | undefined;
const adapter = vi.fn<VerificationAdapter>(async (input: VerificationInput) => { if (duringVerification) await duringVerification(); return { policy: VERIFICATION_POLICY, toolId: input.toolId, nodeVersion: 'v24-fixture', outcome: 'PASSED' as const, checks: [{ name: 'fixture', passed: true }], limitations: ['Synthetic adapter in database tests; no container execution.'] }; });
function request(method: 'GET' | 'POST', path: string, payload?: unknown, session = cookie) { return app.inject({ method, url: `/v1${path}`, remoteAddress: `127.6.0.${address}`, headers: { cookie: session, 'x-csrf-protection': '1', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) }); }
async function identity() {
  const tenant = await database.tenant.create({ data: { name: 'Verification fixture', slug: `verification-${randomUUID()}` } });
  const user = await database.user.create({ data: { email: `verification-${randomUUID()}@example.test`, passwordHash: 'unused', status: 'APPROVED', emailVerifiedAt: new Date() } });
  const role = await database.role.findFirstOrThrow({ where: { name: 'Customer', tenantId: null } });
  await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: 'ACTIVE' } });
  await database.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
  const token = randomUUID(); await database.session.create({ data: { tenantId: tenant.id, userId: user.id, tokenHash: hashOpaqueToken(token, env.SESSION_SECRET), expiresAt: new Date(Date.now() + 3600000) } });
  return { tenantId: tenant.id, userId: user.id, cookie: `zerochack_session=${token}` };
}
beforeAll(async () => {
  if (!new URL(env.DATABASE_URL).pathname.includes('test')) throw new Error('Use a disposable test database.');
  app = await buildApp(env, { careVerification: adapter });
  const actor = await identity(); tenantId = actor.tenantId; userId = actor.userId; cookie = actor.cookie;
  foreignCookie = (await identity()).cookie;
});
beforeEach(async () => {
  address++; adapter.mockClear(); duringVerification = undefined; env.CARE_VERIFICATION_ENABLED = true;
  const host = `${randomUUID()}.example.org`;
  siteId = (await database.website.create({ data: { tenantId, name: 'Verification fixture', url: `https://${host}/`, normalizedHost: host } })).id;
  jobId = (await database.careJob.create({ data: { tenantId, websiteId: siteId, userId, requestKey: randomUUID(), environment: 'STAGING', kind: 'REVIEW', state: 'COMPLETED', summary: 'Fixture verification context' } })).id;
});
afterAll(async () => { await app?.close(); await database.$disconnect(); });
async function sourceInput() {
  const bytes = Buffer.from(JSON.stringify({ files: [{ path: 'test/unit.test.mjs', content: "import { test } from 'node:test'; test('fixture', () => {});" }] }));
  const source = await database.$transaction((tx) => writeArtifact(tx, { tenantId, websiteId: siteId, jobId, environment: 'STAGING', createdBy: userId }, bytes, 'SOURCE_BUNDLE', 'source.json', 'application/json', env));
  const revision = await database.careRevision.create({ data: { tenantId, websiteId: siteId, jobId, version: 1, sourceId: source.id, sourceDigest: source.digest, state: 'COMPLETED', plan: { policy: REVIEW_POLICY_VERSION }, budgetMicros: 100000, budgetState: 'SETTLED', approvedBy: userId, approvalExpiresAt: new Date(Date.now() + 3600000) } });
  return { requestKey: randomUUID(), toolId: 'T35', revisionId: revision.id, artifactId: source.id, sourceDigest: source.digest, imageDigest: env.CARE_VERIFICATION_IMAGE, authorizeVerification: true, syntheticDataOnly: true };
}
describe.sequential('consented verification with real authentication and durable storage', () => {
  it('requires both consents and rejects unsupported commands and mismatched images', async () => {
    const input = await sourceInput();
    for (const overrides of [{ authorizeVerification: false }, { syntheticDataOnly: false }, { url: 'https://example.test' }, { command: 'npm test' }, { toolId: 'T00' }, { path: '../index.html' }]) expect((await request('POST', `/jobs/${jobId}/verification-runs`, { ...input, ...overrides })).statusCode).toBe(400);
    expect(adapter).not.toHaveBeenCalled();
  });
  it('retains encrypted reports across reload and disabled execution', async () => {
    const input = await sourceInput();
    const response = await request('POST', `/jobs/${jobId}/verification-runs`, input); expect(response.statusCode, response.body).toBe(201);
    const runId = response.json().runId;
    env.CARE_VERIFICATION_ENABLED = false;
    const saved = await request('GET', `/jobs/${jobId}/verification-runs/${runId}`); expect(saved.json()).toMatchObject({ state: 'COMPLETED', result: { outcome: 'PASSED', selection: { artifactId: input.artifactId, imageDigest: input.imageDigest } } });
    const artifact = await database.careArtifact.findFirstOrThrow({ where: { jobId, kind: 'VERIFICATION_RESULT' } }); expect(artifact.encryptedBody).not.toContain('Synthetic adapter');
    expect(await database.auditLog.count({ where: { tenantId, resourceId: runId, action: { in: ['care.verification_authorized', 'care.verification_completed'] } } })).toBe(2);
    const options = (await request('GET', `/jobs/${jobId}/verification-options`)).json(); expect(options.enabled).toBe(false); expect(options.history[0].id).toBe(runId);
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, { ...input, requestKey: randomUUID() })).statusCode).toBe(503);
  });
  it('prevents duplicate execution and conflicts when the selected tool or actor changes', async () => {
    const input = await sourceInput(); const first = await request('POST', `/jobs/${jobId}/verification-runs`, input); expect(first.statusCode, first.body).toBe(201);
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, input)).json()).toMatchObject({ runId: first.json().runId, duplicate: true });
    for (const changes of [{ toolId: 'T36' }, { imageDigest: `sha256:${'b'.repeat(64)}` }]) expect((await request('POST', `/jobs/${jobId}/verification-runs`, { ...input, ...changes })).statusCode).toBe(409);
    expect(adapter).toHaveBeenCalledTimes(1);
  });
  it('denies cross-tenant jobs, artifacts, results and cursors', async () => {
    const input = await sourceInput(); const first = await request('POST', `/jobs/${jobId}/verification-runs`, input); const runId = first.json().runId;
    expect((await request('GET', `/jobs/${jobId}/verification-options`, undefined, foreignCookie)).statusCode).toBe(404);
    expect((await request('GET', `/jobs/${jobId}/verification-runs/${runId}`, undefined, foreignCookie)).statusCode).toBe(404);
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, input, foreignCookie)).statusCode).toBe(404);
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, { ...input, artifactId: randomUUID(), requestKey: randomUUID() })).statusCode).toBe(409);
    expect((await request('GET', `/jobs/${jobId}/verification-options?before=${randomUUID()}`)).statusCode).toBe(404);
  });
  it('rejects stale revisions and production scope before rendering', async () => {
    const input = await sourceInput();
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, { ...input, sourceDigest: 'f'.repeat(64) })).statusCode).toBe(409);
    await database.careJob.update({ where: { id: jobId }, data: { environment: 'PRODUCTION' } });
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, input)).statusCode).toBe(409); expect(adapter).not.toHaveBeenCalled();
  });
  it('rechecks cancellation after capture before persisting successful evidence', async () => {
    const input = await sourceInput(); duringVerification = () => database.careJob.update({ where: { id: jobId }, data: { state: 'CANCELLED' } }).then(() => undefined);
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, input)).statusCode).toBe(409);
    expect(await database.careArtifact.count({ where: { jobId, kind: 'VERIFICATION_RESULT' } })).toBe(0);
    expect((await database.careVerificationRun.findFirstOrThrow({ where: { jobId } })).state).toBe('FAILED');
  });
  it('rechecks a revoked session after capture', async () => {
    const input = await sourceInput(); duringVerification = () => database.session.updateMany({ where: { tenantId, userId }, data: { revokedAt: new Date() } }).then(() => undefined);
    try { expect((await request('POST', `/jobs/${jobId}/verification-runs`, input)).statusCode).toBe(401); expect(await database.careArtifact.count({ where: { jobId, kind: 'VERIFICATION_RESULT' } })).toBe(0); }
    finally { await database.session.updateMany({ where: { tenantId, userId }, data: { revokedAt: null } }); }
  });
  it('rechecks the current revision after capture', async () => {
    const input = await sourceInput(); duringVerification = () => database.careJob.update({ where: { id: jobId }, data: { planVersion: 2 } }).then(() => undefined);
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, input)).statusCode).toBe(409); expect(await database.careArtifact.count({ where: { jobId, kind: 'VERIFICATION_RESULT' } })).toBe(0);
  });
  it('retains interrupted runs without replay and paginates scoped history', async () => {
    const input = await sourceInput(); const response = await request('POST', `/jobs/${jobId}/verification-runs`, input); const run = await database.careVerificationRun.findUniqueOrThrow({ where: { id: response.json().runId } });
    await database.careVerificationRun.update({ where: { id: run.id }, data: { state: 'RUNNING', expiresAt: new Date(0), resultArtifactId: null, completedAt: null } });
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, input)).json()).toMatchObject({ state: 'INTERRUPTED', duplicate: true }); expect(adapter).toHaveBeenCalledTimes(1);
    await database.careVerificationRun.createMany({ data: Array.from({ length: 22 }, () => ({ tenantId, websiteId: siteId, jobId, actorId: userId, requestKey: randomUUID(), toolId: 'T35', inputDigest: run.inputDigest, sourceBinding: run.sourceBinding, state: 'FAILED', expiresAt: new Date(), errorCode: 'FIXTURE' })) });
    const page = (await request('GET', `/jobs/${jobId}/verification-options`)).json(); expect(page.history).toHaveLength(20);
    const older = (await request('GET', `/jobs/${jobId}/verification-options?before=${page.nextCursor}`)).json(); expect(older.history).toHaveLength(3); expect(older.nextCursor).toBeNull();
  });
  it('records adapter failures without successful evidence', async () => {
    const input = await sourceInput(); duringVerification = async () => { throw new Error('synthetic runtime failure'); };
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, input)).statusCode).toBe(502);
    const options = (await request('GET', `/jobs/${jobId}/verification-options`)).json(); expect(options.history[0]).toMatchObject({ state: 'FAILED', errorCode: 'VERIFICATION_FAILED' });
    expect(await database.careArtifact.count({ where: { jobId, kind: 'VERIFICATION_RESULT' } })).toBe(0);
  });
  it('requires a different same-job baseline and binds its immutable digest', async () => {
    const input = await sourceInput();
    for (const extra of [{}, { baselineArtifactId: input.artifactId, baselineDigest: input.sourceDigest }]) expect((await request('POST', `/jobs/${jobId}/verification-runs`, { ...input, toolId: 'T40', ...extra })).statusCode).toBe(400);
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, { ...input, toolId: 'T40', baselineArtifactId: randomUUID(), baselineDigest: 'a'.repeat(64) })).statusCode).toBe(409);
    const baseline = await database.$transaction((tx) => writeArtifact(tx, { tenantId, websiteId: siteId, jobId, environment: 'STAGING', createdBy: userId }, Buffer.from(JSON.stringify({ files: [{ path: 'app/value.ts', content: 'export const value = 1;' }] })), 'SOURCE_BUNDLE', 'baseline.json', 'application/json', env));
    const response = await request('POST', `/jobs/${jobId}/verification-runs`, { ...input, toolId: 'T40', baselineArtifactId: baseline.id, baselineDigest: baseline.digest });
    expect(response.statusCode, response.body).toBe(201); expect(adapter.mock.calls[0]![0].baseline).toEqual([{ path: 'app/value.ts', content: 'export const value = 1;' }]);
    const saved = (await request('GET', `/jobs/${jobId}/verification-runs/${response.json().runId}`)).json(); expect(saved.result.selection.baselineDigest).toBe(baseline.digest);
  });
  it('fences results when the runtime image or authorization changes while executing', async () => {
    const input = await sourceInput(); const image = env.CARE_VERIFICATION_IMAGE;
    duringVerification = async () => { env.CARE_VERIFICATION_IMAGE = `sha256:${'c'.repeat(64)}`; };
    try { expect((await request('POST', `/jobs/${jobId}/verification-runs`, input)).statusCode).toBe(409); expect(await database.careArtifact.count({ where: { jobId, kind: 'VERIFICATION_RESULT' } })).toBe(0); }
    finally { env.CARE_VERIFICATION_IMAGE = image; }
  });
  it('retains actual failed checks without presenting them as passing', async () => {
    const input = await sourceInput();
    adapter.mockImplementationOnce(async (selection: VerificationInput) => ({ policy: VERIFICATION_POLICY, toolId: selection.toolId, nodeVersion: 'v24-fixture', outcome: 'FAILED', checks: [{ name: 'synthetic-failing-check', passed: false }], limitations: ['A failed check, not a transport failure.'] }));
    const response = await request('POST', `/jobs/${jobId}/verification-runs`, input); expect(response.statusCode, response.body).toBe(201);
    expect((await request('GET', `/jobs/${jobId}/verification-runs/${response.json().runId}`)).json()).toMatchObject({ state: 'COMPLETED', result: { outcome: 'FAILED' } });
  });
  it('rejects reports that claim passing despite failed assertions', async () => {
    const input = await sourceInput();
    adapter.mockImplementationOnce(async (selection: VerificationInput) => ({ policy: VERIFICATION_POLICY, toolId: selection.toolId, nodeVersion: 'v24-fixture', outcome: 'PASSED', checks: [{ name: 'contradiction', passed: false }], limitations: ['Invalid evidence.'] }));
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, input)).statusCode).toBe(502);
    expect(await database.careArtifact.count({ where: { jobId, kind: 'VERIFICATION_RESULT' } })).toBe(0);
  });
  it('fences a paused job even when its source version has not changed', async () => {
    const input = await sourceInput();
    duringVerification = () => database.careJob.update({ where: { id: jobId }, data: { state: 'WAITING_FOR_INPUT', leaseVersion: { increment: 1 } } }).then(() => undefined);
    expect((await request('POST', `/jobs/${jobId}/verification-runs`, input)).statusCode).toBe(409);
    expect(await database.careArtifact.count({ where: { jobId, kind: 'VERIFICATION_RESULT' } })).toBe(0);
  });
});
