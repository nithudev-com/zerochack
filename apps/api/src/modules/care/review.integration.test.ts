import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { database } from '@zerochack/database';
import { encryptSecret, hashOpaqueToken } from '@zerochack/auth';
import { loadEnvironment } from '@zerochack/config';
import { agentCatalogue } from '@zerochack/care';
import type { AiProviderAdapter } from '@zerochack/ai-gateway';
import { buildApp } from '../../app.js';
import { AiService } from '../ai/service.js';
import { runOneReview } from './review-service.js';
import { writeArtifact } from './repair-service.js';
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
  async function createWorkspace(overrides: Record<string, unknown> = {}) {
    const review = await createReview(['A01'], 1000000, { files: [{ path: 'src/value.ts', content: 'export const count: number = 1;' }], ...overrides });
    const args = { requestKey: randomUUID(), revisionId: review.revision.id, sourceDigest: review.revision.sourceDigest, authorizeTextWorkspace: true };
    const response = await request('POST', `/jobs/${review.job.id}/workspaces`, args);
    expect(response.statusCode, response.body).toBe(201);
    const id = response.json().jobId;
    const state = (await request('GET', `/workspaces/${id}`)).json();
    return { id, review, args, state };
  }
  it('creates durable text copies, retries idempotently, preserves original versions and survives reload and close', async () => {
    const { id, review, args, state } = await createWorkspace();
    expect(state).toMatchObject({ execution: 'NEVER_EXECUTED', releaseEligible: false });
    expect((await request('POST', `/jobs/${review.job.id}/workspaces`, args)).statusCode).toBe(200);
    expect((await request('POST', `/jobs/${review.job.id}/workspaces`, { ...args, sourceDigest: '0'.repeat(64) })).statusCode).toBe(409);
    const patch = { requestKey: randomUUID(), version: 1, sourceDigest: state.revision.sourceDigest, authorizeTextPatch: true, patches: [{ path: 'src/value.ts', before: '= 1', after: '= 2' }] };
    const saved = await request('POST', `/workspaces/${id}/patches`, patch);
    expect(saved.statusCode, saved.body).toBe(201); expect(saved.json().revision.version).toBe(2);
    expect((await request('POST', `/workspaces/${id}/patches`, patch)).json().revision.id).toBe(saved.json().revision.id);
    expect((await request('POST', `/workspaces/${id}/patches`, { ...patch, patches: [{ path: 'src/value.ts', before: '= 1', after: '= 3' }] })).statusCode).toBe(409);
    expect((await request('GET', `/workspaces/${id}/versions/1`)).json().files[0].content).toContain('= 1');
    expect((await request('GET', `/workspaces/${id}/versions/2`)).json().files[0].content).toContain('= 2');
    const reloaded = (await request('GET', `/workspaces/${id}`)).json();
    expect(reloaded.history).toHaveLength(2); expect(reloaded.revision.version).toBe(2);
    expect((await request('POST', `/jobs/${id}/cancel`)).statusCode).toBe(200);
    expect((await request('GET', `/workspaces/${id}`)).json().history).toHaveLength(2);
    expect((await request('POST', `/workspaces/${id}/patches`, { ...patch, requestKey: randomUUID(), version: 2, sourceDigest: reloaded.revision.sourceDigest })).json().error.code).toBe('WORKSPACE_CLOSED');
    expect(await database.careRelease.count({ where: { jobId: id } })).toBe(0); expect(calls).toHaveLength(0);
  });
  it('requires explicit exact staging source consent and rejects stale or out-of-scope patch requests', async () => {
    const { id, state, review, args } = await createWorkspace();
    expect((await request('POST', `/jobs/${review.job.id}/workspaces`, { ...args, requestKey: randomUUID(), authorizeTextWorkspace: false })).statusCode).toBe(400);
    expect((await request('POST', `/jobs/${review.job.id}/workspaces`, { ...args, requestKey: randomUUID(), sourceDigest: '0'.repeat(64) })).statusCode).toBe(409);
    const prod = await createReview(['A01'], 1000000, { environment: 'PRODUCTION' });
    expect((await request('POST', `/jobs/${prod.job.id}/workspaces`, { ...args, requestKey: randomUUID(), revisionId: prod.revision.id, sourceDigest: prod.revision.sourceDigest })).statusCode).toBe(404);
    const patch = { requestKey: randomUUID(), version: 1, sourceDigest: state.revision.sourceDigest, authorizeTextPatch: true, patches: [{ path: 'src/value.ts', before: '= 1', after: '= 2' }] };
    expect((await request('POST', `/workspaces/${id}/patches`, { ...patch, sourceDigest: '0'.repeat(64) })).json().error.code).toBe('WORKSPACE_STALE');
    expect((await request('POST', `/workspaces/${id}/patches`, { ...patch, tenantId: randomUUID() })).statusCode).toBe(400);
    expect((await request('POST', `/workspaces/${id}/patches`, { ...patch, patches: [{ path: '../outside.ts', before: '1', after: '2' }] })).statusCode).toBe(400);
    expect((await request('POST', `/workspaces/${id}/patches`, { ...patch, authorizeTextPatch: false })).statusCode).toBe(400);
    expect((await request('GET', `/workspaces/${randomUUID()}`)).statusCode).toBe(404);
    expect((await request('GET', `/workspaces/${id}`)).json().history).toHaveLength(1);
  });
  it('serializes concurrent patches so only one exact base version can advance', async () => {
    const { id, state } = await createWorkspace();
    const patches = [2,3].map((next) => ({ requestKey: randomUUID(), version: 1, sourceDigest: state.revision.sourceDigest, authorizeTextPatch: true, patches: [{ path: 'src/value.ts', before: '= 1', after: `= ${next}` }] }));
    const results = await Promise.all(patches.map((patch) => request('POST', `/workspaces/${id}/patches`, patch)));
    expect(results.map((result) => result.statusCode).sort()).toEqual([201,409]);
    expect((await request('GET', `/workspaces/${id}`)).json().history).toHaveLength(2);
  });
  it('persists real lint/type results, binds them to revisions and retains them after a later edit', async () => {
    const { id, state } = await createWorkspace({ files: [{ path: 'src/value.ts', content: 'export var count: number = "wrong";' }] });
    const args = { requestKey: randomUUID(), version: 1, sourceDigest: state.revision.sourceDigest };
    const lint = await request('POST', `/workspaces/${id}/checks/T33`, args);
    expect(lint.statusCode, lint.body).toBe(201); expect(lint.json().output.diagnostics[0].code).toBe('NO_VAR');
    const checked = await request('POST', `/workspaces/${id}/checks/T34`, { ...args, requestKey: randomUUID() });
    expect(checked.statusCode, checked.body).toBe(201); expect(checked.json().output.diagnostics[0].code).toBe('TS2322');
    expect((await request('POST', `/workspaces/${id}/checks/T33`, args)).json().artifactId).toBe(lint.json().artifactId);
    expect((await request('POST', `/workspaces/${id}/checks/T33`, { ...args, sourceDigest: '0'.repeat(64) })).statusCode).toBe(409);
    expect((await request('POST', `/workspaces/${id}/checks/T35`, args)).statusCode).toBe(400);
    const patch = { ...args, requestKey: randomUUID(), authorizeTextPatch: true, patches: [{ path: 'src/value.ts', before: '"wrong"', after: '2' }] };
    expect((await request('POST', `/workspaces/${id}/patches`, patch)).statusCode).toBe(201);
    const history = (await request('GET', `/workspaces/${id}`)).json(); expect(history.checks).toHaveLength(2);
    expect((await request('GET', `/workspaces/${id}/check-results/${checked.json().artifactId}`)).json()).toMatchObject({ version: 1, sourceDigest: args.sourceDigest, releaseEligible: false });
    expect((await request('GET', `/workspaces/${id}/check-results/${state.revision.sourceId}`)).statusCode).toBe(404);
    expect((await request('POST', `/workspaces/${id}/checks/T34`, { ...args, requestKey: randomUUID() })).json().error.code).toBe('WORKSPACE_STALE');
    expect(calls).toHaveLength(0);
  });
  it('fails closed on source tampering and preserves old history when a version quota is reached', async () => {
    const { id, state } = await createWorkspace();
    const original = await database.careArtifact.findUniqueOrThrow({ where: { id: state.revision.sourceId } });
    await database.careArtifact.update({ where: { id: original.id }, data: { digest: '0'.repeat(64) } });
    expect((await request('GET', `/workspaces/${id}`)).json().error.code).toBe('WORKSPACE_INTEGRITY');
    await database.careArtifact.update({ where: { id: original.id }, data: { digest: original.digest } });
    await database.careRevision.update({ where: { id: state.revision.id }, data: { version: 50 } });
    await database.careJob.update({ where: { id }, data: { planVersion: 50 } });
    const patch = { requestKey: randomUUID(), version: 50, sourceDigest: original.digest, authorizeTextPatch: true, patches: [{ path: 'src/value.ts', before: '= 1', after: '= 2' }] };
    expect((await request('POST', `/workspaces/${id}/patches`, patch)).statusCode).toBe(429);
    expect((await request('GET', `/workspaces/${id}/versions/50`)).json().files[0].content).toContain('= 1');
  });
  it('compares actual same-job screenshots and rejects foreign job artifacts or corrupted content', async () => {
    const first = await createReview(['A01']); const second = await createReview(['A01']);
    const save = async (jobId: string, background: string) => {
      const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background } }).png().toBuffer();
      return database.$transaction((tx) => writeArtifact(tx, { tenantId, websiteId: siteId, environment: 'STAGING', jobId, createdBy: userId }, bytes, 'SCREENSHOT', 'sanitized.png', 'image/png', env));
    };
    const baseline = await save(first.job.id, '#ffffff'); const candidate = await save(first.job.id, '#000000'); const foreign = await save(second.job.id, '#000000');
    const url = `/jobs/${first.job.id}/tools/T29`;
    expect((await request('POST', url, { baselineArtifactId: baseline.id, candidateArtifactId: candidate.id })).json().output).toMatchObject({ changedPixels: 4, changedRatio: 1 });
    expect((await request('POST', url, { baselineArtifactId: baseline.id, candidateArtifactId: foreign.id })).statusCode).toBe(404);
    await database.careArtifact.update({ where: { id: candidate.id }, data: { digest: '0'.repeat(64) } });
    expect((await request('POST', url, { baselineArtifactId: baseline.id, candidateArtifactId: candidate.id })).json().error.code).toBe('ARTIFACT_INTEGRITY');
  });
  it('confines workspace reads and mutations to the authenticated tenant and enforces zero-cost draft constraints', async () => {
    const { id, state } = await createWorkspace();
    const foreignTenant = await database.tenant.create({ data: { name: 'Foreign workspace fixture', slug: `foreign-workspace-${randomUUID()}` } });
    const foreignSite = await database.website.create({ data: { tenantId: foreignTenant.id, name: 'Foreign fixture', url: 'https://example.com/', normalizedHost: 'example.com' } });
    const foreign = await database.careJob.create({ data: { tenantId: foreignTenant.id, websiteId: foreignSite.id, userId, requestKey: randomUUID(), kind: 'WORKSPACE', environment: 'STAGING', state: 'WAITING_FOR_INPUT', summary: 'Private foreign source' } });
    expect((await request('GET', `/workspaces/${foreign.id}`)).statusCode).toBe(404);
    expect((await request('GET', `/workspaces/${foreign.id}/versions/1`)).statusCode).toBe(404);
    const patch = { requestKey: randomUUID(), version: 1, sourceDigest: state.revision.sourceDigest, authorizeTextPatch: true, patches: [{ path: 'src/value.ts', before: '= 1', after: '= 2' }] };
    expect((await request('POST', `/workspaces/${foreign.id}/patches`, patch)).statusCode).toBe(404);
    // The migration must not allow a zero-budget draft to become an approved model plan.
    await expect(database.careRevision.update({ where: { id: state.revision.id }, data: { state: 'APPROVED' } })).rejects.toThrow();
    await expect(database.careRevision.update({ where: { id: state.revision.id }, data: { plan: {} } })).rejects.toThrow();
    expect((await request('POST', `/review-plans/${state.revision.id}/approve`, { sourceDigest: state.revision.sourceDigest, version: 1, budgetMicros: 1, planFingerprint: '0'.repeat(64), authorizeSourceReview: true })).statusCode).toBe(409);
    expect((await request('GET', `/workspaces/${id}`)).json().revision.state).toBe('DRAFT');
  });
  it('dispatches bounded tools only with exact current source approval and strict arguments', async () => {
    const value = await createReview(['A01'], 1000000, { files: [...files, { path: 'before.css', content: ':root { --color: blue; }' }, { path: 'after.css', content: ':root { --color: green; }' }] });
    const url = `/jobs/${value.job.id}/tools/`;
    expect((await request('POST', url + 'T17', {})).statusCode).toBe(403);
    expect((await approve(value.revision)).statusCode).toBe(200);
    for (const id of ['T17','T18','T22','T38','T45','T47']) expect((await request('POST', url + id, {})).statusCode).toBe(200);
    expect((await request('POST', url + 'T06', { query: 'source' })).json().output[0].provenance).toBe('BUNDLED_CARE_POLICY');
    expect((await request('POST', url + 'T07', { id: 'source-evidence', version: 'old' })).statusCode).toBe(400);
    expect((await request('POST', url + 'T30', { baselinePath: 'before.css', candidatePath: 'after.css' })).json().output.changes).toEqual([{ token: '--color', change: 'DECLARATIONS_CHANGED' }]);
    expect((await request('POST', url + 'T17', { tenantId: randomUUID() })).statusCode).toBe(400);
    expect((await request('POST', url + 'T35', {})).json().error.code).toBe('TOOL_UNAVAILABLE');
    expect(calls).toHaveLength(0);
    await database.careRevision.update({ where: { id: value.revision.id }, data: { approvalExpiresAt: new Date(0) } });
    expect((await request('POST', url + 'T17', {})).statusCode).toBe(403);
  });
  it('returns actual retained findings and summaries without requiring another model call', async () => {
    const value = await createReview(['A09']); await approve(value.revision); await runOneReview(env, ai);
    const url = `/jobs/${value.job.id}/tools/`;
    const evidence = await request('POST', url + 'T05', {});
    expect(evidence.statusCode, evidence.body).toBe(200);
    expect(evidence.json().output).toMatchObject({ state: 'RECORDED_EVIDENCE', totalFindings: 1, truncated: false });
    expect(evidence.json().output.findings[0].evidence[0].quote).toBe('<button>Save</button>');
    expect((await request('POST', url + 'T62', {})).json().output.reports[0]).toMatchObject({ roleId: 'A09', findingCount: 1 });
    expect((await request('POST', url + 'T51', {})).json().output.state).toBe('NOT_OBSERVED');
    expect((await request('POST', url + 'T56', {})).json().output.state).toBe('NOT_OBSERVED');
    expect((await request('POST', url + 'T58', {})).json().output.state).toBe('NOT_OBSERVED');
    expect((await request('POST', url + 'T57', {})).json().output.job.errorCode).toBeNull();
    expect((await request('POST', url + 'T05', { websiteId: randomUUID() })).statusCode).toBe(400);
    expect(calls).toEqual(['A09']);
  });
  it('compares only same-job artifacts, checks integrity and identifies stale plan bindings', async () => {
    const value = await createReview(['A01']); const other = await createReview(['A01']);
    const bytes = Buffer.from(JSON.stringify({ files: [{ path: 'src/page.tsx', content: 'export const value = 2;' }, { path: 'new.txt', content: 'new supplied text' }] }));
    const candidate = await database.$transaction((tx) => writeArtifact(tx, { tenantId, websiteId: siteId, jobId: value.job.id, environment: 'STAGING', createdBy: userId }, bytes, 'SOURCE_BUNDLE', 'candidate.json', 'application/json', env));
    const url = `/jobs/${value.job.id}/tools/`;
    const diff = await request('POST', url + 'T12', { baselineArtifactId: value.revision.sourceId, candidateArtifactId: candidate.id });
    expect(diff.statusCode, diff.body).toBe(200);
    expect(diff.json().output.changes).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'src/page.tsx', change: 'MODIFIED' }), expect.objectContaining({ path: 'new.txt', change: 'ADDED' })]));
    expect((await request('POST', url + 'T12', { baselineArtifactId: other.revision.sourceId, candidateArtifactId: candidate.id })).statusCode).toBe(404);
    const args = { revisionId: value.revision.id, sourceDigest: value.revision.sourceDigest };
    expect((await request('POST', url + 'T16', args)).json().output.conflict).toBe(false);
    await database.careJob.update({ where: { id: value.job.id }, data: { planVersion: 2 } });
    expect((await request('POST', url + 'T16', args)).json().output.conflict).toBe(true);
    await database.careArtifact.update({ where: { id: candidate.id }, data: { digest: 'a'.repeat(64) } });
    expect((await request('POST', url + 'T12', { baselineArtifactId: value.revision.sourceId, candidateArtifactId: candidate.id })).json().error.code).toBe('ARTIFACT_INTEGRITY');
  });
  it('reviews newly supported source and persists YAML checks with the approved report', async () => {
    const value = await createReview(['A12'], 1000000, { files: [...files, { path: 'Program.cs', content: 'public class Program {}' }, { path: 'infra/main.tf', content: 'terraform {}' }, { path: 'deploy.yaml', content: 'replicas: 2\nreplicas: 3\n' }] });
    expect(value.revision.plan.policy).toBe('source-review-v4');
    expect(calls).toHaveLength(0);
    expect((await approve(value.revision)).statusCode).toBe(200);
    expect(await runOneReview(env, ai)).toBe(true);
    const result = (await request('GET', `/jobs/${value.job.id}/review`)).json();
    expect(result.job.state).toBe('COMPLETED');
    expect(result.revision.verification.toolIds).toContain('T67');
    expect(result.revision.verification.staticChecks).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'yaml-syntax', state: 'OBSERVATIONS', diagnostics: [expect.objectContaining({ path: 'deploy.yaml', line: 2, code: 'YAML_DUPLICATE_KEY' })] })]));
    expect(result.revision.verification.runtimeTests).toBe('NOT_RUN');
    expect(await database.careRelease.count({ where: { jobId: value.job.id } })).toBe(0);
  });
  it('does not return a prepared review if its transaction fails after writing the plan', async () => {
    const body = { requestKey: randomUUID(), summary: 'Review source and identify missing verification', expectedBehavior: 'Provide cited observations and explicit limitations', environment: 'STAGING', language: 'ta', roleIds: ['A01'], files, privacyReviewed: true, budgetMicros: 1000000 };
    const transaction = database.$transaction.bind(database);
    let wroteBeforeFailure = false;
    const failure = vi.spyOn(database, '$transaction').mockImplementationOnce((callback) => transaction(async (tx) => {
      await callback(tx);
      wroteBeforeFailure = true;
      throw new Error('Synthetic commit failure after route writes');
    }));
    const artifactsBefore = await database.careArtifact.count({ where: { tenantId } });
    try { expect((await request('POST', `/websites/${siteId}/reviews`, body)).statusCode).toBe(500); }
    finally { failure.mockRestore(); database.$transaction = transaction; }
    expect(wroteBeforeFailure).toBe(true);
    expect(await database.careJob.count({ where: { tenantId, requestKey: body.requestKey } })).toBe(0);
    expect(await database.careArtifact.count({ where: { tenantId } })).toBe(artifactsBefore);
    const created = await request('POST', `/websites/${siteId}/reviews`, body);
    expect(created.statusCode, created.body).toBe(201);
    expect((await request('GET', `/jobs/${created.json().jobId}/review`)).statusCode).toBe(200);
    expect(calls).toHaveLength(0);
  });
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
  it('preserves encrypted evidence and conversation across maintenance and API restart', async () => {
    const value = await createReview(['A09']); await approve(value.revision); await runOneReview(env, ai);
    const before = await database.careArtifact.findMany({ where: { jobId: value.job.id }, orderBy: { id: 'asc' } });
    expect(before.every((artifact) => artifact.expiresAt === null)).toBe(true);
    await maintainCareRecords(new Date(Date.now() + 365 * 86400000));
    expect(await database.careArtifact.findMany({ where: { jobId: value.job.id }, orderBy: { id: 'asc' } })).toEqual(before);
    await app.close(); app = await buildApp(env, { aiAdapters: [adapter] });
    const reopened = await request('GET', `/jobs/${value.job.id}/review`);
    expect(reopened.statusCode).toBe(200); expect(reopened.json().reports).toHaveLength(1);
    expect(reopened.json().revision.verification.staticChecks.map((check: { check: string }) => check.check)).toEqual(['accessibility','links','source-syntax','css-syntax','yaml-syntax','security-source','security-config','api-contract-structure','infrastructure-manifest']);
    expect((await request('GET', `/websites/${siteId}/chat?environment=STAGING`)).body).toContain('A09 source review');
    expect(calls).toHaveLength(1);
  });
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
