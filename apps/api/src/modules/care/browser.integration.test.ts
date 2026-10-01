import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database } from '@zerochack/database';
import { hashOpaqueToken } from '@zerochack/auth';
import { loadEnvironment } from '@zerochack/config';
import { REVIEW_POLICY_VERSION } from '@zerochack/care';
import { buildApp } from '../../app.js';
import { writeArtifact } from './repair-service.js';
import type { BrowserInput } from './static-browser.js';
const env = loadEnvironment({ NODE_ENV: 'test', CARE_ENABLED: 'true', CARE_REVIEW_ENABLED: 'true', CARE_BROWSER_ENABLED: 'true', DATABASE_URL: process.env.DATABASE_URL, LOG_LEVEL: 'silent', REDIS_URL: 'redis://127.0.0.1:6380', CORS_ORIGINS: 'http://localhost:3000', SESSION_SECRET: 'browser-test-session-key-at-least-32-characters', CARE_ARTIFACT_KEY: Buffer.alloc(32, 44).toString('base64') });
let app: Awaited<ReturnType<typeof buildApp>>; let tenantId: string; let userId: string; let siteId: string; let jobId: string; let cookie: string; let foreignCookie: string; let address = 1;
let duringBrowser: (() => Promise<void>) | undefined;
const screenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5N8AAAAASUVORK5CYII=', 'base64');
const adapter = vi.fn(async (input: BrowserInput) => { if (duringBrowser) await duringBrowser(); return { report: { rendered: true, toolId: input.toolId, boundary: 'Synthetic adapter; no real Chromium in database tests.' }, ...(input.toolId === 'T27' ? { screenshot } : {}) }; });
function request(method: 'GET' | 'POST', path: string, payload?: unknown, session = cookie) { return app.inject({ method, url: `/v1${path}`, remoteAddress: `127.6.0.${address}`, headers: { cookie: session, 'x-csrf-protection': '1', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) }); }
async function identity() {
  const tenant = await database.tenant.create({ data: { name: 'Browser fixture', slug: `browser-${randomUUID()}` } });
  const user = await database.user.create({ data: { email: `browser-${randomUUID()}@example.test`, passwordHash: 'unused', status: 'APPROVED', emailVerifiedAt: new Date() } });
  const role = await database.role.findFirstOrThrow({ where: { name: 'Customer', tenantId: null } });
  await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: 'ACTIVE' } });
  await database.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
  const token = randomUUID(); await database.session.create({ data: { tenantId: tenant.id, userId: user.id, tokenHash: hashOpaqueToken(token, env.SESSION_SECRET), expiresAt: new Date(Date.now() + 3600000) } });
  return { tenantId: tenant.id, userId: user.id, cookie: `zerochack_session=${token}` };
}
beforeAll(async () => {
  if (!new URL(env.DATABASE_URL).pathname.includes('test')) throw new Error('Use a disposable test database.');
  app = await buildApp(env, { careBrowser: adapter });
  const actor = await identity(); tenantId = actor.tenantId; userId = actor.userId; cookie = actor.cookie;
  foreignCookie = (await identity()).cookie;
});
beforeEach(async () => {
  address++; adapter.mockClear(); duringBrowser = undefined; env.CARE_BROWSER_ENABLED = true;
  const host = `${randomUUID()}.example.org`;
  siteId = (await database.website.create({ data: { tenantId, name: 'Browser fixture', url: `https://${host}/`, normalizedHost: host } })).id;
  jobId = (await database.careJob.create({ data: { tenantId, websiteId: siteId, userId, requestKey: randomUUID(), environment: 'STAGING', kind: 'REVIEW', state: 'COMPLETED', summary: 'Fixture browser context' } })).id;
});
afterAll(async () => { await app?.close(); await database.$disconnect(); });
async function sourceInput() {
  const bytes = Buffer.from(JSON.stringify({ files: [{ path: 'index.html', content: '<!doctype html><html lang="en"><head><title>Fixture</title></head><body><main><h1>Fixture</h1></main></body></html>' }] }));
  const source = await database.$transaction((tx) => writeArtifact(tx, { tenantId, websiteId: siteId, jobId, environment: 'STAGING', createdBy: userId }, bytes, 'SOURCE_BUNDLE', 'source.json', 'application/json', env));
  const revision = await database.careRevision.create({ data: { tenantId, websiteId: siteId, jobId, version: 1, sourceId: source.id, sourceDigest: source.digest, state: 'COMPLETED', plan: { policy: REVIEW_POLICY_VERSION }, budgetMicros: 100000, budgetState: 'SETTLED', approvedBy: userId, approvalExpiresAt: new Date(Date.now() + 3600000) } });
  return { requestKey: randomUUID(), toolId: 'T25', revisionId: revision.id, artifactId: source.id, sourceDigest: source.digest, path: 'index.html', viewport: 'MOBILE', privateIds: [], authorizeStaticBrowser: true, privacyReviewed: true };
}
describe.sequential('consented browser workflows with real authentication and durable storage', () => {
  it('requires both consents and rejects arbitrary URLs, paths and viewports before rendering', async () => {
    const input = await sourceInput();
    for (const overrides of [{ authorizeStaticBrowser: false }, { privacyReviewed: false }, { url: 'https://example.test' }, { viewport: 'CUSTOM' }, { privateIds: ['invalid selector'] }, { privateIds: ['same', 'same'] }, { path: '../index.html' }]) expect((await request('POST', `/jobs/${jobId}/browser-runs`, { ...input, ...overrides })).statusCode).toBe(400);
    expect(adapter).not.toHaveBeenCalled();
  });
  it('retains encrypted reports and screenshots across reload and disabled execution', async () => {
    const input = await sourceInput();
    const response = await request('POST', `/jobs/${jobId}/browser-runs`, { ...input, toolId: 'T27' }); expect(response.statusCode, response.body).toBe(201);
    const runId = response.json().runId;
    env.CARE_BROWSER_ENABLED = false;
    const saved = await request('GET', `/jobs/${jobId}/browser-runs/${runId}`); expect(saved.json()).toMatchObject({ state: 'COMPLETED', result: { rendered: true, selection: { artifactId: input.artifactId, path: 'index.html' } }, screenshot: `data:image/png;base64,${screenshot.toString('base64')}` });
    const artifact = await database.careArtifact.findFirstOrThrow({ where: { jobId, kind: 'BROWSER_RESULT' } }); expect(artifact.encryptedBody).not.toContain('rendered');
    expect(await database.auditLog.count({ where: { tenantId, resourceId: runId, action: { in: ['care.browser_authorized', 'care.browser_completed'] } } })).toBe(2);
    const options = (await request('GET', `/jobs/${jobId}/browser-options`)).json(); expect(options.enabled).toBe(false); expect(options.history[0].id).toBe(runId);
    expect((await request('POST', `/jobs/${jobId}/browser-runs`, { ...input, requestKey: randomUUID() })).statusCode).toBe(503);
  });
  it('prevents duplicate execution and conflicts when viewport, privacy selection or tool changes', async () => {
    const input = await sourceInput(); const first = await request('POST', `/jobs/${jobId}/browser-runs`, input); expect(first.statusCode, first.body).toBe(201);
    expect((await request('POST', `/jobs/${jobId}/browser-runs`, input)).json()).toMatchObject({ runId: first.json().runId, duplicate: true });
    for (const changes of [{ viewport: 'DESKTOP' }, { privateIds: ['other'] }, { toolId: 'T26' }]) expect((await request('POST', `/jobs/${jobId}/browser-runs`, { ...input, ...changes })).statusCode).toBe(409);
    expect(adapter).toHaveBeenCalledTimes(1);
  });
  it('denies cross-tenant jobs, artifacts, results and cursors', async () => {
    const input = await sourceInput(); const first = await request('POST', `/jobs/${jobId}/browser-runs`, input); const runId = first.json().runId;
    expect((await request('GET', `/jobs/${jobId}/browser-options`, undefined, foreignCookie)).statusCode).toBe(404);
    expect((await request('GET', `/jobs/${jobId}/browser-runs/${runId}`, undefined, foreignCookie)).statusCode).toBe(404);
    expect((await request('POST', `/jobs/${jobId}/browser-runs`, input, foreignCookie)).statusCode).toBe(404);
    expect((await request('POST', `/jobs/${jobId}/browser-runs`, { ...input, artifactId: randomUUID(), requestKey: randomUUID() })).statusCode).toBe(409);
    expect((await request('GET', `/jobs/${jobId}/browser-options?before=${randomUUID()}`)).statusCode).toBe(404);
  });
  it('rejects stale revisions and production scope before rendering', async () => {
    const input = await sourceInput();
    expect((await request('POST', `/jobs/${jobId}/browser-runs`, { ...input, sourceDigest: 'f'.repeat(64) })).statusCode).toBe(409);
    await database.careJob.update({ where: { id: jobId }, data: { environment: 'PRODUCTION' } });
    expect((await request('POST', `/jobs/${jobId}/browser-runs`, input)).statusCode).toBe(409); expect(adapter).not.toHaveBeenCalled();
  });
  it('rechecks cancellation after capture before persisting successful evidence', async () => {
    const input = await sourceInput(); duringBrowser = () => database.careJob.update({ where: { id: jobId }, data: { state: 'CANCELLED' } }).then(() => undefined);
    expect((await request('POST', `/jobs/${jobId}/browser-runs`, input)).statusCode).toBe(409);
    expect(await database.careArtifact.count({ where: { jobId, kind: 'BROWSER_RESULT' } })).toBe(0);
    expect((await database.careBrowserRun.findFirstOrThrow({ where: { jobId } })).state).toBe('FAILED');
  });
  it('rechecks a revoked session after capture', async () => {
    const input = await sourceInput(); duringBrowser = () => database.session.updateMany({ where: { tenantId, userId }, data: { revokedAt: new Date() } }).then(() => undefined);
    try { expect((await request('POST', `/jobs/${jobId}/browser-runs`, input)).statusCode).toBe(401); expect(await database.careArtifact.count({ where: { jobId, kind: 'BROWSER_RESULT' } })).toBe(0); }
    finally { await database.session.updateMany({ where: { tenantId, userId }, data: { revokedAt: null } }); }
  });
  it('rechecks the current revision after capture', async () => {
    const input = await sourceInput(); duringBrowser = () => database.careJob.update({ where: { id: jobId }, data: { planVersion: 2 } }).then(() => undefined);
    expect((await request('POST', `/jobs/${jobId}/browser-runs`, input)).statusCode).toBe(409); expect(await database.careArtifact.count({ where: { jobId, kind: 'BROWSER_RESULT' } })).toBe(0);
  });
  it('retains interrupted runs without replay and paginates scoped history', async () => {
    const input = await sourceInput(); const response = await request('POST', `/jobs/${jobId}/browser-runs`, input); const run = await database.careBrowserRun.findUniqueOrThrow({ where: { id: response.json().runId } });
    await database.careBrowserRun.update({ where: { id: run.id }, data: { state: 'RUNNING', expiresAt: new Date(0), resultArtifactId: null, completedAt: null } });
    expect((await request('POST', `/jobs/${jobId}/browser-runs`, input)).json()).toMatchObject({ state: 'INTERRUPTED', duplicate: true }); expect(adapter).toHaveBeenCalledTimes(1);
    await database.careBrowserRun.createMany({ data: Array.from({ length: 22 }, () => ({ tenantId, websiteId: siteId, jobId, actorId: userId, requestKey: randomUUID(), toolId: 'T25', inputDigest: run.inputDigest, sourceBinding: run.sourceBinding, state: 'FAILED', expiresAt: new Date(), errorCode: 'FIXTURE' })) });
    const page = (await request('GET', `/jobs/${jobId}/browser-options`)).json(); expect(page.history).toHaveLength(20);
    const older = (await request('GET', `/jobs/${jobId}/browser-options?before=${page.nextCursor}`)).json(); expect(older.history).toHaveLength(3); expect(older.nextCursor).toBeNull();
  });
  it('records adapter failures without successful evidence', async () => {
    const input = await sourceInput(); duringBrowser = async () => { throw new Error('synthetic runtime failure'); };
    expect((await request('POST', `/jobs/${jobId}/browser-runs`, input)).statusCode).toBe(502);
    const options = (await request('GET', `/jobs/${jobId}/browser-options`)).json(); expect(options.history[0]).toMatchObject({ state: 'FAILED', errorCode: 'BROWSER_FAILED' });
    expect(await database.careArtifact.count({ where: { jobId, kind: 'BROWSER_RESULT' } })).toBe(0);
  });
});
