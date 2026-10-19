import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { database } from '@zerochack/database';
import { hashOpaqueToken } from '@zerochack/auth';
import { loadEnvironment } from '@zerochack/config';
import type { AiProviderConfiguration } from '@zerochack/ai-gateway';
import { buildApp } from '../../app.js';
import { AiService } from '../ai/service.js';
import { claimCareWebsite } from '../care/runtime.js';
import { claimReleaseWebsite } from '../care/release-service.js';
import { assertSecurityWorkplaceTestDatabase } from './fixture-guard.test-helper.js';
import { createSecurityRepairJournal } from './journal.js';

const env = loadEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: 'redis://127.0.0.1:6380', LOG_LEVEL: 'silent', CORS_ORIGINS: 'http://localhost:3000', SESSION_SECRET: 'security-conflict-fixture-session-at-least32', CARE_ENABLED: 'true', CARE_REPAIR_ENABLED: 'true', CARE_REVIEW_ENABLED: 'true', CARE_RELEASE_ENABLED: 'true', CARE_JOB_BUDGET_MICROS: '1000000', CARE_VAULT_KEY: Buffer.alloc(32, 71).toString('base64'), CARE_ARTIFACT_KEY: Buffer.alloc(32, 72).toString('base64') });
const configuration: AiProviderConfiguration = {
  providerId: randomUUID(), providerName: 'Synthetic configuration only', adapterKey: 'anthropic-messages', providerEnabled: true, providerHealth: 'HEALTHY', providerRequestsPerMinute: 100, providerMaxConcurrent: 1,
  credentialId: randomUUID(), encryptedCredential: 'synthetic-not-used', credentialEnabled: true, credentialHealth: 'HEALTHY', modelId: randomUUID(), model: 'synthetic-not-called', modelEnabled: true,
  maxOutputTokens: 1024, modelRequestsPerMinute: 100, modelMaxConcurrent: 1, inputCostMicrosPerMillion: 1, outputCostMicrosPerMillion: 1,
  tenantEnabled: true, tenantRequestsPerMinute: 100, userRequestsPerMinute: 100, tenantMaxConcurrent: 1, dailyCostLimitMicros: 1000000
};
const source = '<!doctype html><html lang="en"><head><title>Scoped fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Approved fixture</h1></body></html>';
const retained: Array<{ tenantId: string; actorId: string }> = [];
let app: Awaited<ReturnType<typeof buildApp>>;
let configurationMock: { mockRestore(): void } | undefined;
beforeAll(async () => {
  await assertSecurityWorkplaceTestDatabase();
  configurationMock = vi.spyOn(AiService.prototype, 'configuration').mockResolvedValue(configuration);
  app = await buildApp(env, { aiAdapters: [{ key: 'anthropic-messages', async complete() { throw new Error('No model calls permitted by conflict fixtures'); } }] });
});
afterAll(async () => {
  await app?.close(); configurationMock?.mockRestore();
  for (const fixture of retained) {
    const where = { tenantId: fixture.tenantId };
    await database.securityRepairCostEntry.deleteMany({ where });
    await database.securityRepairOutbox.deleteMany({ where });
    await database.securityRepairDecision.deleteMany({ where });
    await database.securityGraphWrite.deleteMany({ where });
    await database.securityGraphCheckpoint.deleteMany({ where });
    await database.securityRepairAttempt.deleteMany({ where });
    await database.securityRepairRun.deleteMany({ where });
    await database.auditLog.deleteMany({ where });
    await database.tenant.delete({ where: { id: fixture.tenantId } });
    await database.user.delete({ where: { id: fixture.actorId } });
  }
  await database.$disconnect();
});
async function fixture() {
  const now = new Date();
  const tenant = await database.tenant.create({ data: { name: 'Shared security conflict fixture', slug: `security-conflict-${randomUUID()}` } });
  const actor = await database.user.create({ data: { email: `${randomUUID()}@example.test`, status: 'APPROVED', emailVerifiedAt: now, mfaEnabledAt: now } });
  retained.push({ tenantId: tenant.id, actorId: actor.id });
  await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: actor.id, status: 'ACTIVE' } });
  const role = await database.role.findFirstOrThrow({ where: { name: 'Customer', tenantId: null } });
  await database.userRole.create({ data: { tenantId: tenant.id, userId: actor.id, roleId: role.id } });
  const token = randomUUID();
  const session = await database.session.create({ data: { tenantId: tenant.id, userId: actor.id, tokenHash: hashOpaqueToken(token, env.SESSION_SECRET), expiresAt: new Date(now.getTime() + 3600000), mfaVerifiedAt: now } });
  const website = await database.website.create({ data: { tenantId: tenant.id, name: 'Conflict fixture', url: 'https://example.test/', normalizedHost: 'example.test', connectionStatus: 'VERIFIED' } });
  return {
    tenantId: tenant.id, websiteId: website.id, actorId: actor.id, sessionId: session.id,
    request(method: 'POST' | 'DELETE', url: string, payload?: Record<string, unknown>) { return app.inject({ method, url: `/v1${url}`, headers: { cookie: `zerochack_session=${token}` }, ...(payload ? { payload } : {}) }); }
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function securityRun(f: Fixture, phase = 'PLANNING', environment = 'PRODUCTION') {
  // Frozen fixture state, not an execution bypass or product admission path.
  return database.securityRepairRun.create({ data: { tenantId: f.tenantId, websiteId: f.websiteId, environment, requestKey: randomUUID(), actorId: f.actorId, sessionId: f.sessionId, inputDigest: 'a'.repeat(64), authorityDigest: 'b'.repeat(64), allowanceMicros: 100, expiresAt: new Date(Date.now() + 60000), phase } });
}
async function repair(f: Fixture) {
  const created = await f.request('POST', `/websites/${f.websiteId}/jobs`, { requestKey: randomUUID(), summary: 'Correct the approved fixture heading', expectedBehavior: 'Preserve all unrelated fixture content', environment: 'STAGING' });
  expect(created.statusCode, created.body).toBe(201); const job = created.json();
  const uploaded = await f.request('POST', `/websites/${f.websiteId}/artifacts`, { jobId: job.id, kind: 'SOURCE', base64: Buffer.from(source).toString('base64'), privacyReviewed: true });
  expect(uploaded.statusCode, uploaded.body).toBe(201); const artifact = uploaded.json();
  const prepared = await f.request('POST', `/jobs/${job.id}/change-plan`, { sourceId: artifact.id, budgetMicros: 100000 });
  expect(prepared.statusCode, prepared.body).toBe(201); const revision = prepared.json();
  return { job, artifact, revision, approve: () => f.request('POST', `/change-plans/${revision.id}/approve`, { sourceDigest: revision.sourceDigest, version: revision.version, budgetMicros: revision.budgetMicros, authorizeRepair: true }) };
}
async function release(f: Fixture) {
  const value = await repair(f);
  // Synthetic reviewed candidate: no model or remote executor is run in these gate tests.
  await database.careRevision.update({ where: { id: value.revision.id }, data: { state: 'VERIFIED', candidateId: value.artifact.id, candidateDigest: value.artifact.digest } });
  const credential = await database.careCredential.create({ data: { tenantId: f.tenantId, websiteId: f.websiteId, environment: 'PRODUCTION', kind: 'SSH', host: 'fixture.example.test', username: 'fixture', authMethod: 'PASSWORD', encryptedEnvelope: 'synthetic-not-used', authorizedBy: f.actorId, authorizationExpiresAt: new Date(Date.now() + 60000) } });
  const row = await database.careRelease.create({ data: { tenantId: f.tenantId, websiteId: f.websiteId, jobId: value.job.id, revisionId: value.revision.id, requestKey: randomUUID(), credentialId: credential.id, credentialVersion: credential.version, remotePath: '/srv/www/fixture/index.html', sourceDigest: value.artifact.digest, candidateDigest: value.artifact.digest } });
  return { ...value, row, approve: () => f.request('POST', `/releases/${row.id}/approve`, { candidateDigest: row.candidateDigest, sourceDigest: row.sourceDigest, remotePath: row.remotePath, credentialId: row.credentialId, authorizeProductionAndRollback: true }) };
}
async function assertSecurityOwnerCanReclaim(f: Fixture, runId: string) {
  const scope = { tenantId: f.tenantId, websiteId: f.websiteId, environment: 'PRODUCTION' as const, runId };
  // Trusted synthetic journal authority only; no provider/runtime effect or API activation.
  const journal = createSecurityRepairJournal({ database, async assertAuthority(_tx, requested) { expect(requested).toEqual(scope); } });
  const fence = await journal.claimRun(scope, randomUUID());
  await journal.releaseLease(scope, fence);
  expect(await database.securityRepairAttempt.count({ where: { runId } })).toBe(0);
  expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: runId } })).toMatchObject({ phase: 'PLANNING', reservedMicros: 0, chargedMicros: 0, leaseOwnerId: null });
}
describe.sequential('legacy route/worker conflict preservation with authenticated disposable fixtures', () => {
  it('rejects inverse-order new review and repair drafts without stranding the existing security owner', async () => {
    const f = await fixture();
    const body = { requestKey: randomUUID(), summary: 'Review the supplied fixture source', expectedBehavior: 'Only report verified source observations', environment: 'STAGING', roleIds: ['A01'], files: [{ path: 'index.html', content: source }], privacyReviewed: true, budgetMicros: 100000 };
    const prepared = await f.request('POST', `/websites/${f.websiteId}/reviews`, body);
    expect(prepared.statusCode, prepared.body).toBe(201);
    await database.careJob.update({ where: { id: prepared.json().jobId }, data: { state: 'COMPLETED' } });
    const run = await securityRun(f);
    const repeated = await f.request('POST', `/websites/${f.websiteId}/reviews`, body);
    expect(repeated.statusCode, repeated.body).toBe(200); expect(repeated.json().jobId).toBe(prepared.json().jobId);
    const review = await f.request('POST', `/websites/${f.websiteId}/reviews`, { ...body, requestKey: randomUUID() });
    expect(review.statusCode, review.body).toBe(409); expect(review.json().error.code).toBe('SECURITY_WEBSITE_WORK_CONFLICT');
    const repair = await f.request('POST', `/websites/${f.websiteId}/jobs`, { requestKey: randomUUID(), summary: 'Prepare a new scoped fixture repair', expectedBehavior: 'Preserve unrelated fixture content', environment: 'STAGING' });
    expect(repair.statusCode, repair.body).toBe(409); expect(repair.json().error.code).toBe('SECURITY_WEBSITE_WORK_CONFLICT');
    expect(await database.careJob.count({ where: { tenantId: f.tenantId, state: { not: 'COMPLETED' } } })).toBe(0);
    expect(await database.careRevision.count({ where: { tenantId: f.tenantId } })).toBe(1);
    await assertSecurityOwnerCanReclaim(f, run.id);
  });
  it('rejects inverse-order new release and plan drafts while preserving exact existing request receipts', async () => {
    const f = await fixture(); const value = await release(f);
    await database.careRelease.update({ where: { id: value.row.id }, data: { state: 'CANCELLED' } });
    await database.careJob.update({ where: { id: value.job.id }, data: { state: 'COMPLETED' } });
    const run = await securityRun(f);
    const body = { requestKey: value.row.requestKey, revisionId: value.row.revisionId, credentialId: value.row.credentialId, remotePath: value.row.remotePath };
    const repeated = await f.request('POST', `/jobs/${value.job.id}/releases`, body);
    expect(repeated.statusCode, repeated.body).toBe(200); expect(repeated.json().id).toBe(value.row.id);
    const denied = await f.request('POST', `/jobs/${value.job.id}/releases`, { ...body, requestKey: randomUUID() });
    expect(denied.statusCode, denied.body).toBe(409); expect(denied.json().error.code).toBe('SECURITY_WEBSITE_WORK_CONFLICT');
    // Model a completed historical job with a new plan version available; do not
    // let its fresh unapproved plan take the active security owner's slot.
    await database.careJob.update({ where: { id: value.job.id }, data: { planVersion: 2 } });
    const plan = await f.request('POST', `/jobs/${value.job.id}/change-plan`, { sourceId: value.artifact.id, budgetMicros: 100000 });
    expect(plan.statusCode, plan.body).toBe(409); expect(plan.json().error.code).toBe('SECURITY_WEBSITE_WORK_CONFLICT');
    const feedback = await f.request('POST', `/jobs/${value.job.id}/feedback`, { content: 'Prepare a revised fixture heading after this completed job' });
    expect(feedback.statusCode, feedback.body).toBe(409); expect(feedback.json().error.code).toBe('SECURITY_WEBSITE_WORK_CONFLICT');
    expect(await database.careRelease.count({ where: { tenantId: f.tenantId } })).toBe(1);
    expect(await database.careRevision.count({ where: { jobId: value.job.id, version: 2 } })).toBe(0);
    expect(await database.careJob.findUniqueOrThrow({ where: { id: value.job.id } })).toMatchObject({ state: 'COMPLETED', planVersion: 2 });
    expect(await database.careRevision.findUniqueOrThrow({ where: { id: value.revision.id } })).toMatchObject({ state: 'VERIFIED' });
    await assertSecurityOwnerCanReclaim(f, run.id);
  });
  it('rejects repair approval across environments for active, stale and unknown security runs without reserving legacy costs', async () => {
    const f = await fixture(); const value = await repair(f); const run = await securityRun(f);
    for (const phase of ['PLANNING', 'STALE', 'OUTCOME_UNKNOWN']) {
      await database.securityRepairRun.update({ where: { id: run.id }, data: { phase } });
      const response = await value.approve();
      expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe('SECURITY_WEBSITE_WORK_CONFLICT');
      expect(await database.careJob.findUniqueOrThrow({ where: { id: value.job.id } })).toMatchObject({ state: 'AWAITING_APPROVAL' });
      expect(await database.careRevision.findUniqueOrThrow({ where: { id: value.revision.id } })).toMatchObject({ budgetState: 'UNRESERVED' });
    }
    await database.securityRepairRun.update({ where: { id: run.id }, data: { phase: 'CANCELLED' } });
    expect((await value.approve()).statusCode).toBe(200);
  });
  it('preserves review preparation while refusing approval until the security workflow is terminal', async () => {
    const f = await fixture();
    const created = await f.request('POST', `/websites/${f.websiteId}/reviews`, { requestKey: randomUUID(), summary: 'Review the supplied fixture source', expectedBehavior: 'Only report verified source observations', environment: 'STAGING', roleIds: ['A01'], files: [{ path: 'index.html', content: source }], privacyReviewed: true, budgetMicros: 100000 });
    expect(created.statusCode, created.body).toBe(201);
    const revision = await database.careRevision.findUniqueOrThrow({ where: { jobId_version: { jobId: created.json().jobId, version: 1 } } });
    const body = { sourceDigest: revision.sourceDigest, planFingerprint: (revision.plan as { requestFingerprint: string }).requestFingerprint, version: 1, budgetMicros: revision.budgetMicros, authorizeSourceReview: true };
    const run = await securityRun(f, 'OUTCOME_UNKNOWN');
    const denied = await f.request('POST', `/review-plans/${revision.id}/approve`, body);
    expect(denied.statusCode, denied.body).toBe(409); expect(denied.json().error.code).toBe('SECURITY_WEBSITE_WORK_CONFLICT');
    expect(await database.careAgentRun.count({ where: { jobId: created.json().jobId } })).toBe(0);
    await database.securityRepairRun.update({ where: { id: run.id }, data: { phase: 'FAILED' } });
    expect((await f.request('POST', `/review-plans/${revision.id}/approve`, body)).statusCode).toBe(200);
  });
  it('refuses static production release approval while preserving pending state and permits it after terminal security work', async () => {
    const f = await fixture(); const value = await release(f); const run = await securityRun(f, 'STALE');
    const denied = await value.approve();
    expect(denied.statusCode, denied.body).toBe(409); expect(denied.json().error.code).toBe('SECURITY_WEBSITE_WORK_CONFLICT');
    expect(await database.careRelease.findUniqueOrThrow({ where: { id: value.row.id } })).toMatchObject({ state: 'AWAITING_APPROVAL' });
    await database.securityRepairRun.update({ where: { id: run.id }, data: { phase: 'COMPLETED' } });
    expect((await value.approve()).statusCode).toBe(200);
    // Keep this test's own queue clean without touching any other tenant.
    await database.careRelease.update({ where: { id: value.row.id }, data: { state: 'CANCELLED' } });
  });
  it('excludes blocked sites from the exact legacy worker selectors without changing queued jobs or opening a remote connection', async () => {
    const f = await fixture(); const value = await release(f); await securityRun(f);
    await database.careJob.update({ where: { id: value.job.id }, data: { state: 'QUEUED' } });
    await database.careRelease.update({ where: { id: value.row.id }, data: { state: 'QUEUED' } });
    // Selectors only lock/read; they may select unrelated eligible fixture sites,
    // but this test never claims, changes or executes their jobs.
    expect(await database.$transaction(tx => claimCareWebsite(tx, 'REPAIR'))).not.toBe(f.websiteId);
    expect((await database.$transaction(tx => claimReleaseWebsite(tx)))?.id).not.toBe(f.websiteId);
    expect(await database.careJob.findUniqueOrThrow({ where: { id: value.job.id } })).toMatchObject({ state: 'QUEUED' });
    expect(await database.careRelease.findUniqueOrThrow({ where: { id: value.row.id } })).toMatchObject({ state: 'QUEUED' });
    expect(await database.careEvent.count({ where: { tenantId: f.tenantId, eventType: 'release.started' } })).toBe(0);
  });
  it('retains security receipt provenance after completion and rejects both API wiping and cascading row deletion', async () => {
    const f = await fixture(); const value = await repair(f); const run = await securityRun(f, 'COMPLETED', 'STAGING');
    await database.securityRepairAttempt.create({ data: { tenantId: f.tenantId, websiteId: f.websiteId, environment: 'STAGING', runId: run.id, stepKey: 'retained.fixture', kind: 'READ', inputDigest: 'a'.repeat(64), leaseVersion: 1, reserveMicros: 0, costMicros: 0, state: 'SUCCEEDED', artifactId: value.artifact.id, artifactDigest: value.artifact.digest, completedAt: new Date() } });
    const before = await database.careArtifact.findUniqueOrThrow({ where: { id: value.artifact.id } });
    const denied = await f.request('DELETE', `/artifacts/${value.artifact.id}`);
    expect(denied.statusCode, denied.body).toBe(409); expect(denied.json().error.code).toBe('SECURITY_ARTIFACT_RETAINED');
    await expect(database.careArtifact.delete({ where: { id: value.artifact.id } })).rejects.toThrow();
    expect(await database.careArtifact.findUniqueOrThrow({ where: { id: value.artifact.id } })).toEqual(before);
  });
  it('preserves saved decision artifacts independently of retained step rows', async () => {
    const f = await fixture(); const value = await repair(f); const run = await securityRun(f, 'COMPLETED', 'STAGING');
    await database.securityRepairDecision.create({ data: { tenantId: f.tenantId, websiteId: f.websiteId, environment: 'STAGING', runId: run.id, requestKey: randomUUID(), kind: 'CANDIDATE', artifactId: value.artifact.id, digest: value.artifact.digest, actorId: f.actorId, sessionId: f.sessionId, status: 'APPROVED', expiresAt: new Date(Date.now() + 30000) } });
    const before = await database.careArtifact.findUniqueOrThrow({ where: { id: value.artifact.id } });
    const denied = await f.request('DELETE', `/artifacts/${value.artifact.id}`);
    expect(denied.statusCode, denied.body).toBe(409); expect(denied.json().error.code).toBe('SECURITY_ARTIFACT_RETAINED');
    await expect(database.careArtifact.delete({ where: { id: value.artifact.id } })).rejects.toThrow();
    expect(await database.careArtifact.findUniqueOrThrow({ where: { id: value.artifact.id } })).toEqual(before);
  });
});
