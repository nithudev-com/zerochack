import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database } from '@zerochack/database';
import { encryptSecret, hashOpaqueToken } from '@zerochack/auth';
import { loadEnvironment } from '@zerochack/config';
import { agentCatalogue } from '@zerochack/care';
import type { AiProviderAdapter } from '@zerochack/ai-gateway';
import { buildApp } from '../../app.js';
import { AiService } from '../ai/service.js';
import { runOneReview } from './review-service.js';
import { maintainCareRecords } from '../../../../worker/src/care-maintenance.js';

const env = loadEnvironment({ NODE_ENV: 'test', CARE_ENABLED: 'true', CARE_REVIEW_ENABLED: 'true', DATABASE_URL: process.env.DATABASE_URL, LOG_LEVEL: 'silent', REDIS_URL: 'redis://127.0.0.1:6380', CORS_ORIGINS: 'http://localhost:3000', SESSION_SECRET: 'review-test-session-key-at-least-32-characters', CARE_VAULT_KEY: Buffer.alloc(32, 33).toString('base64'), CARE_ARTIFACT_KEY: Buffer.alloc(32, 34).toString('base64') });
const files = [{ path: 'src/page.tsx', content: 'export function Page() {\n  return <button>Save</button>;\n}\n' }];
let calls: string[] = []; let invalidEvidence = false; let duringModel: (() => Promise<void>) | undefined; let testAddress = 1;
const adapter: AiProviderAdapter = { key: 'anthropic-messages', async complete(input) {
  const roleId = /Assigned role: (A\d+)/.exec(input.prompt)?.[1]; expect(roleId).toBeDefined(); calls.push(roleId!);
  expect(input.tools).toBeUndefined(); expect(input.instructions).toContain('No tools, network, shell');
  if (duringModel) await duringModel();
  return { text: JSON.stringify({ roleId, status: 'REVIEWED', summary: 'The provided source includes a Save button that needs interaction testing.', findings: [{ title: 'Review button behavior', priority: 'LOW', explanation: 'A Save button is declared in the supplied source.', recommendation: 'Check keyboard interaction in a separate browser test.', evidence: [{ path: 'src/page.tsx', startLine: 2, endLine: 2, quote: invalidEvidence ? 'fabricated source evidence' : '<button>Save</button>' }] }], limitations: ['No browser, runtime or live website checks were performed.'], nextSteps: ['Test the intended interaction using an isolated fixture.'] }), inputTokens: 100, outputTokens: 30 };
} };
let app: Awaited<ReturnType<typeof buildApp>>; let ai: AiService; let tenantId: string; let userId: string; let siteId: string; let cookie: string;
function request(method: 'GET' | 'POST', url: string, payload?: unknown) { return app.inject({ method, url: `/v1${url}`, remoteAddress: `127.4.0.${testAddress}`, headers: { cookie, ...(payload === undefined ? {} : { 'content-type': 'application/json' }), 'x-csrf-protection': '1' }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) }); }
async function createReview(roleIds = ['A01','A09','A18'], budgetMicros = 1000000, overrides: Record<string, unknown> = {}) {
  const body = { requestKey: randomUUID(), summary: 'Review source and identify missing verification', expectedBehavior: 'Provide cited observations and explicit limitations', environment: 'STAGING', language: 'ta', roleIds, files, privacyReviewed: true, budgetMicros, ...overrides };
  const prepared = await request('POST', `/websites/${siteId}/reviews`, body);
  expect(prepared.statusCode, prepared.body).toBe(201);
  const data = (await request('GET', `/jobs/${prepared.json().jobId}/review`)).json();
  return { ...data, body };
}
async function approve(revision: { id: string; sourceDigest: string; version: number; budgetMicros: number; plan: { requestFingerprint: string } }, override: Record<string, unknown> = {}) {
  return request('POST', `/review-plans/${revision.id}/approve`, { sourceDigest: revision.sourceDigest, version: revision.version, budgetMicros: revision.budgetMicros, planFingerprint: revision.plan.requestFingerprint, authorizeSourceReview: true, ...override });
}
beforeAll(async () => {
  if (!new URL(env.DATABASE_URL).pathname.includes('test')) throw new Error('A disposable test database is required.');
  app = await buildApp(env, { aiAdapters: [adapter] }); ai = new AiService(env, undefined, [adapter]);
  tenantId = (await database.tenant.create({ data: { name: 'Source review fixture', slug: `review-${randomUUID()}` } })).id;
  userId = (await database.user.create({ data: { email: `review-${randomUUID()}@example.test`, passwordHash: 'unused', status: 'APPROVED', emailVerifiedAt: new Date() } })).id;
  const role = await database.role.findFirstOrThrow({ where: { name: 'Customer', tenantId: null } });
  await database.tenantMembership.create({ data: { tenantId, userId, status: 'ACTIVE' } }); await database.userRole.create({ data: { tenantId, userId, roleId: role.id } });
  const token = randomUUID(); cookie = `zerochack_session=${token}`; await database.session.create({ data: { tenantId, userId, tokenHash: hashOpaqueToken(token, env.SESSION_SECRET), expiresAt: new Date(Date.now() + 3600000) } });
  siteId = (await database.website.create({ data: { tenantId, name: 'Review fixture', url: 'https://example.com/', normalizedHost: 'example.com' } })).id;
  await database.aiTenantPolicy.create({ data: { tenantId, enabled: true, dailyCostLimitMicros: 100000000, requestsPerMinute: 1000, requestsPerUserMinute: 1000 } });
  const provider = await database.aiProvider.create({ data: { name: `Source review fixture ${randomUUID()}`, adapterKey: adapter.key, enabled: true, requestsPerMinute: 1000 } });
  await database.aiCredential.create({ data: { providerId: provider.id, label: 'Fixture credential', encryptedSecret: encryptSecret('synthetic-provider-key', env.AI_CREDENTIAL_ENCRYPTION_KEY) } });
  await database.aiModel.create({ data: { providerId: provider.id, name: 'Review fixture', providerModel: 'fixture-review-model', maxOutputTokens: 2048, inputCostMicrosPerM: 1000000, outputCostMicrosPerM: 1000000, requestsPerMinute: 1000 } });
});
beforeEach(async () => { testAddress++; calls = []; invalidEvidence = false; duringModel = undefined; await database.careJob.updateMany({ where: { tenantId, kind: 'REVIEW', state: { not: 'COMPLETED' } }, data: { state: 'CANCELLED' } }); await database.careRevision.updateMany({ where: { tenantId, budgetState: { in: ['RESERVED','UNKNOWN'] } }, data: { budgetState: 'SETTLED' } }); await database.aiTenantPolicy.update({ where: { tenantId }, data: { dailyCostLimitMicros: 100000000 } }); });
afterAll(async () => { await app?.close(); await database.$disconnect(); });

describe.sequential('durable approved multi-role source reviews with real authentication and fixture model', () => {
  it('runs all 24 roles once, checkpoints every step, encrypts reports and exposes citations without changing source', async () => {
    const value = await createReview(agentCatalogue.map((role) => role.id), 4000000);
    expect(await runOneReview(env, ai)).toBe(false); expect(calls).toHaveLength(0);
    expect((await approve(value.revision, { sourceDigest: 'b'.repeat(64) })).statusCode).toBe(409);
    expect((await approve(value.revision)).statusCode).toBe(200); expect((await approve(value.revision)).statusCode).toBe(409);
    for (let index = 0; index < 24; index++) {
      // A new AiService each step models process restarts between durable checkpoints.
      expect(await runOneReview(env, new AiService(env, undefined, [adapter]))).toBe(true);
      const current = await request('GET', `/jobs/${value.job.id}/review`);
      expect(current.statusCode, current.body).toBe(200); expect(current.json().completedSteps).toBe(index + 1);
    }
    expect(new Set(calls).size).toBe(24); expect(await runOneReview(env, ai)).toBe(false);
    const result = (await request('GET', `/jobs/${value.job.id}/review`)).json();
    expect(result.job.state).toBe('COMPLETED'); expect(result.revision).toMatchObject({ state: 'COMPLETED', budgetState: 'SETTLED', chargedMicros: 3120 });
    expect(result.reports).toHaveLength(24); expect(result.reports.every((report: { repairsApplied: boolean; runtimeVerification: string }) => !report.repairsApplied && report.runtimeVerification === 'NOT_RUN')).toBe(true);
    const artifacts = await database.careArtifact.findMany({ where: { jobId: value.job.id } });
    expect(artifacts).toHaveLength(25); expect(artifacts.every((artifact) => !artifact.encryptedBody.includes('<button>'))).toBe(true);
    const usage = await database.aiUsage.findMany({ where: { requestId: value.job.id } }); expect(usage).toHaveLength(24); expect(usage.every((item) => item.responseText === null)).toBe(true);
    expect(await database.careRelease.count({ where: { jobId: value.job.id } })).toBe(0);
  }, 90000);
  it('rejects stale role scope and reuses identical preparation requests without duplicate jobs', async () => {
    const value = await createReview();
    expect((await request('POST', `/websites/${siteId}/reviews`, value.body)).json().jobId).toBe(value.job.id);
    expect((await request('POST', `/websites/${siteId}/reviews`, { ...value.body, roleIds: ['A05'] })).statusCode).toBe(409);
    expect((await approve(value.revision, { planFingerprint: 'c'.repeat(64) })).statusCode).toBe(409);
    expect(calls).toHaveLength(0);
  });
  it('rejects credentials and foreign-tenant source access before invoking a model', async () => {
    const value = await createReview();
    const privateFile = await request('POST', `/websites/${siteId}/reviews`, { ...value.body, requestKey: randomUUID(), files: [{ path: 'settings.txt', content: 'password: fixture-sensitive-value' }] });
    expect(privateFile.statusCode).toBe(400);
    const foreign = await database.tenant.create({ data: { name: 'Other review tenant', slug: randomUUID() } });
    const site = await database.website.create({ data: { tenantId: foreign.id, name: 'Other site', url: 'https://example.org', normalizedHost: 'example.org' } });
    expect((await request('POST', `/websites/${site.id}/reviews`, value.body)).statusCode).toBe(404);
    const foreignJob = await database.careJob.create({ data: { tenantId: foreign.id, websiteId: site.id, userId, requestKey: randomUUID(), kind: 'REVIEW', state: 'CANCELLED', summary: 'Other source review' } });
    expect((await request('GET', `/jobs/${foreignJob.id}/review`)).statusCode).toBe(404); expect(calls).toHaveLength(0);
  });
  it('stops downstream roles on fabricated citations and settles measured model usage', async () => {
    const value = await createReview(); await approve(value.revision); invalidEvidence = true;
    await runOneReview(env, ai); invalidEvidence = false;
    const result = (await request('GET', `/jobs/${value.job.id}/review`)).json();
    expect(result.job).toMatchObject({ state: 'FAILED', errorCode: 'REVIEW_EVIDENCE_INVALID' }); expect(result.reports).toHaveLength(0);
    expect(result.revision).toMatchObject({ chargedMicros: 130, budgetState: 'SETTLED' });
    expect(result.agents.slice(1).every((agent: { state: string }) => agent.state === 'WAITING_FOR_INPUT')).toBe(true);
    expect(await runOneReview(env, ai)).toBe(false); expect(calls).toHaveLength(1);
  });
  it('fences an in-flight result after customer cancellation and releases unspent allowance', async () => {
    const value = await createReview(); await approve(value.revision);
    duringModel = async () => { expect((await request('POST', `/jobs/${value.job.id}/cancel`)).statusCode).toBe(200); };
    await runOneReview(env, ai); duringModel = undefined;
    const result = (await request('GET', `/jobs/${value.job.id}/review`)).json();
    expect(result.job.state).toBe('CANCELLED'); expect(result.reports).toHaveLength(0); expect(result.revision.budgetState).toBe('SETTLED'); expect(result.revision.chargedMicros).toBe(130);
    expect(await runOneReview(env, ai)).toBe(false);
  });
  it('checks current authorization and expired approvals before the model invocation', async () => {
    const expired = await createReview(); await approve(expired.revision);
    await database.careRevision.update({ where: { id: expired.revision.id }, data: { approvalExpiresAt: new Date(0) } });
    expect(await runOneReview(env, ai)).toBe(false); expect(calls).toHaveLength(0);
    const revoked = await createReview(); await approve(revoked.revision);
    await database.tenantMembership.updateMany({ where: { tenantId, userId }, data: { status: 'SUSPENDED' } });
    try { await runOneReview(env, ai); expect(calls).toHaveLength(0); } finally { await database.tenantMembership.updateMany({ where: { tenantId, userId }, data: { status: 'ACTIVE' } }); }
    expect((await database.careJob.findUniqueOrThrow({ where: { id: revoked.job.id } })).errorCode).toBe('AUTHORIZATION_REVOKED');
  });
  it('reserves shared tenant cost before queueing a second review', async () => {
    const first = await createReview(); const second = await createReview();
    await database.aiTenantPolicy.update({ where: { tenantId }, data: { dailyCostLimitMicros: 1100000 } });
    expect((await approve(first.revision)).statusCode).toBe(200); expect((await approve(second.revision)).json().error.code).toBe('BUDGET_EXCEEDED');
    expect((await request('POST', `/jobs/${first.job.id}/cancel`)).statusCode).toBe(200); expect((await approve(second.revision)).statusCode).toBe(200);
  });
  it('keeps a second worker from starting another review on the same website', async () => {
    const first = await createReview(); const second = await createReview(); await approve(first.revision); await approve(second.revision);
    let release!: () => void; let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<void>((resolve) => { release = resolve; });
    duringModel = async () => { entered(); await pending; };
    const running = runOneReview(env, ai); await started;
    try { expect(await runOneReview(env, new AiService(env, undefined, [adapter]))).toBe(false); expect(calls).toHaveLength(1); }
    finally { duringModel = undefined; release(); await running; }
    expect((await request('GET', `/jobs/${first.job.id}/review`)).json().completedSteps).toBe(1);
    expect((await request('GET', `/jobs/${second.job.id}/review`)).json().completedSteps).toBe(0);
  });
  it('blocks stale workers and preserves uncertain cost without automatic model replay', async () => {
    const value = await createReview(); await approve(value.revision);
    await database.careJob.update({ where: { id: value.job.id }, data: { state: 'RUNNING', heartbeatAt: new Date(0) } });
    await database.careAgentRun.updateMany({ where: { jobId: value.job.id, stepIndex: 0 }, data: { state: 'RUNNING', heartbeatAt: new Date(0) } });
    await maintainCareRecords();
    expect((await database.careJob.findUniqueOrThrow({ where: { id: value.job.id } })).state).toBe('STALE');
    expect((await database.careRevision.findUniqueOrThrow({ where: { id: value.revision.id } })).budgetState).toBe('UNKNOWN');
    expect(await runOneReview(env, ai)).toBe(false); expect(calls).toHaveLength(0);
  });
});
