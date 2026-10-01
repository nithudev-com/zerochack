import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { database } from '@zerochack/database';
import { hashOpaqueToken } from '@zerochack/auth';
import { loadEnvironment } from '@zerochack/config';
import { REVIEW_POLICY_VERSION } from '@zerochack/care';
import { buildApp } from '../../app.js';
import { writeArtifact } from './repair-service.js';
import { queryAdvisories, summarizeHeaders, type ObservationAdapters } from './external-observations.js';

const env = loadEnvironment({ NODE_ENV: 'test', CARE_ENABLED: 'true', CARE_REVIEW_ENABLED: 'true', CARE_OBSERVATIONS_ENABLED: 'true', CARE_ADVISORIES_ENABLED: 'true', DATABASE_URL: process.env.DATABASE_URL, LOG_LEVEL: 'silent', REDIS_URL: 'redis://127.0.0.1:6380', CORS_ORIGINS: 'http://localhost:3000', SESSION_SECRET: 'observation-test-session-key-at-least-32-characters', CARE_VAULT_KEY: Buffer.alloc(32, 43).toString('base64'), CARE_ARTIFACT_KEY: Buffer.alloc(32, 44).toString('base64') });
let app: Awaited<ReturnType<typeof buildApp>>; let tenantId: string; let userId: string; let siteId: string; let jobId: string; let target: string; let cookie: string; let foreignCookie: string; let address = 1;
let duringObservation: (() => Promise<void>) | undefined;
const http = vi.fn(async () => { if (duringObservation) await duringObservation(); return summarizeHeaders(200, { 'x-content-type-options': 'nosniff' }, true); });
const tls: ObservationAdapters['tls'] = async () => ({ authorized: true, protocol: 'TLSv1.3', fingerprint256: 'synthetic-fingerprint', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2027-01-01T00:00:00.000Z', limitation: 'Fixture transport, not a live TLS result.' });
const advisories = vi.fn(async (packages: Parameters<typeof queryAdvisories>[0]) => queryAdvisories(packages, vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ results: packages.map(() => ({})) })))));
function request(method: 'GET' | 'POST', path: string, payload?: unknown, session = cookie) { return app.inject({ method, url: `/v1${path}`, remoteAddress: `127.5.0.${address}`, headers: { cookie: session, 'x-csrf-protection': '1', ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) }); }
async function identity() {
  const tenant = await database.tenant.create({ data: { name: 'Observation fixture', slug: `observation-${randomUUID()}` } });
  const user = await database.user.create({ data: { email: `observation-${randomUUID()}@example.test`, passwordHash: 'unused', status: 'APPROVED', emailVerifiedAt: new Date() } });
  const role = await database.role.findFirstOrThrow({ where: { name: 'Customer', tenantId: null } });
  await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: 'ACTIVE' } });
  await database.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
  const token = randomUUID(); await database.session.create({ data: { tenantId: tenant.id, userId: user.id, tokenHash: hashOpaqueToken(token, env.SESSION_SECRET), expiresAt: new Date(Date.now() + 3600000) } });
  return { tenantId: tenant.id, userId: user.id, cookie: `zerochack_session=${token}` };
}
beforeAll(async () => {
  if (!new URL(env.DATABASE_URL).pathname.includes('test')) throw new Error('Use a disposable test database.');
  app = await buildApp(env, { careObservations: { http, tls, advisories } });
  const actor = await identity(); tenantId = actor.tenantId; userId = actor.userId; cookie = actor.cookie;
  foreignCookie = (await identity()).cookie;
});
beforeEach(async () => {
  address++; http.mockClear(); advisories.mockClear(); duringObservation = undefined;
  const host = `${randomUUID()}.example.org`; target = `https://${host}/`;
  siteId = (await database.website.create({ data: { tenantId, name: 'Observation fixture', url: target, normalizedHost: host, connectionStatus: 'VERIFIED', connectedAt: new Date() } })).id;
  jobId = (await database.careJob.create({ data: { tenantId, websiteId: siteId, userId, requestKey: randomUUID(), environment: 'PRODUCTION', kind: 'REPAIR', state: 'COMPLETED', summary: 'Fixture observation context' } })).id;
});
afterAll(async () => { await app?.close(); await database.$disconnect(); });
const networkInput = () => ({ requestKey: randomUUID(), toolId: 'T23', confirmTarget: target, authorizeReadOnlyObservation: true });
async function sourceInput() {
  await database.careJob.update({ where: { id: jobId }, data: { kind: 'REVIEW', environment: 'STAGING' } });
  const bytes = Buffer.from(JSON.stringify({ files: [{ path: 'package-lock.json', content: '{"lockfileVersion":3,"packages":{"node_modules/sample":{"version":"1.2.3"}}}' }] }));
  const source = await database.$transaction((tx) => writeArtifact(tx, { tenantId, websiteId: siteId, jobId, environment: 'STAGING', createdBy: userId }, bytes, 'SOURCE_BUNDLE', 'source.json', 'application/json', env));
  const revision = await database.careRevision.create({ data: { tenantId, websiteId: siteId, jobId, version: 1, sourceId: source.id, sourceDigest: source.digest, state: 'COMPLETED', plan: { policy: REVIEW_POLICY_VERSION }, budgetMicros: 100000, budgetState: 'SETTLED', approvedBy: userId, approvalExpiresAt: new Date(Date.now() + 3600000) } });
  return { requestKey: randomUUID(), toolId: 'T20', revisionId: revision.id, sourceDigest: source.digest, packages: [{ ecosystem: 'npm', name: 'sample', version: '1.2.3' }], consentToSharePackageVersions: true };
}
describe.sequential('consented observations with real authentication/database and fixture external services', () => {
  it('requires explicit consent and rejects caller-supplied target expansion', async () => {
    expect((await request('POST', `/jobs/${jobId}/observations`, { ...networkInput(), authorizeReadOnlyObservation: false })).statusCode).toBe(400);
    expect((await request('POST', `/jobs/${jobId}/observations`, { ...networkInput(), url: 'https://other.org' })).statusCode).toBe(400);
    expect((await request('POST', `/jobs/${jobId}/observations`, { ...networkInput(), confirmTarget: 'https://other.org/' })).statusCode).toBe(409);
    expect(http).not.toHaveBeenCalled();
  });
  it('requires the verified production binding before any outbound request', async () => {
    await database.website.update({ where: { id: siteId }, data: { connectionStatus: 'PENDING' } });
    expect((await request('POST', `/jobs/${jobId}/observations`, networkInput())).statusCode).toBe(403);
    await database.website.update({ where: { id: siteId }, data: { connectionStatus: 'VERIFIED' } });
    await database.careJob.update({ where: { id: jobId }, data: { environment: 'STAGING' } });
    expect((await request('POST', `/jobs/${jobId}/observations`, networkInput())).statusCode).toBe(403); expect(http).not.toHaveBeenCalled();
  });
  it('persists encrypted results, audits consent and completion, and returns them after reload', async () => {
    const response = await request('POST', `/jobs/${jobId}/observations`, networkInput()); expect(response.statusCode, response.body).toBe(201);
    const runId = response.json().runId;
    const saved = await request('GET', `/jobs/${jobId}/observations/${runId}`); expect(saved.json()).toMatchObject({ state: 'COMPLETED', result: { nosniff: true } });
    const artifact = await database.careArtifact.findFirstOrThrow({ where: { jobId, kind: 'OBSERVATION_RESULT' } }); expect(artifact.encryptedBody).not.toContain('nosniff');
    expect(await database.auditLog.count({ where: { tenantId, resourceId: runId, action: { in: ['care.observation_authorized', 'care.observation_completed'] } } })).toBe(2);
    expect((await request('GET', `/jobs/${jobId}/observation-options`)).json().history[0].id).toBe(runId);
  });
  it('returns the existing operation on retry without repeating the external action', async () => {
    const input = networkInput(); const a = await request('POST', `/jobs/${jobId}/observations`, input); const b = await request('POST', `/jobs/${jobId}/observations`, input);
    expect(a.statusCode, a.body).toBe(201); expect(b.statusCode, b.body).toBe(200); expect(a.json().runId).toBe(b.json().runId); expect(http).toHaveBeenCalledTimes(1);
    expect((await request('POST', `/jobs/${jobId}/observations`, { ...input, toolId: 'T24' })).statusCode).toBe(409);
  });
  it('denies cross-tenant job, result, options and history cursor access', async () => {
    const response = await request('POST', `/jobs/${jobId}/observations`, networkInput()); const runId = response.json().runId;
    expect((await request('POST', `/jobs/${jobId}/observations`, networkInput(), foreignCookie)).statusCode).toBe(404);
    expect((await request('GET', `/jobs/${jobId}/observations/${runId}`, undefined, foreignCookie)).statusCode).toBe(404);
    expect((await request('GET', `/jobs/${jobId}/observation-options`, undefined, foreignCookie)).statusCode).toBe(404);
    expect((await request('GET', `/jobs/${jobId}/observation-options?before=${randomUUID()}`)).statusCode).toBe(404);
  });
  it('rejects scope changes during a request instead of saving a successful result', async () => {
    duringObservation = () => database.website.update({ where: { id: siteId }, data: { connectionStatus: 'PENDING' } }).then(() => undefined);
    const response = await request('POST', `/jobs/${jobId}/observations`, networkInput()); expect(response.statusCode).toBe(403);
    expect(await database.careArtifact.count({ where: { jobId, kind: 'OBSERVATION_RESULT' } })).toBe(0);
    expect((await database.careToolObservation.findFirstOrThrow({ where: { jobId } })).state).toBe('FAILED');
  });
  it('rechecks cancellation after the observation', async () => {
    duringObservation = () => database.careJob.update({ where: { id: jobId }, data: { state: 'CANCELLED' } }).then(() => undefined);
    expect((await request('POST', `/jobs/${jobId}/observations`, networkInput())).statusCode).toBe(409);
    expect(await database.careArtifact.count({ where: { jobId, kind: 'OBSERVATION_RESULT' } })).toBe(0);
  });
  it('matches only selected coordinates from the exact approved source', async () => {
    const input = await sourceInput();
    const options = (await request('GET', `/jobs/${jobId}/observation-options`)).json(); expect(options.advisoriesAvailable).toBe(true); expect(options.inventory.entries[0]).toMatchObject({ name: 'sample', version: '1.2.3' });
    expect((await request('POST', `/jobs/${jobId}/observations`, { ...input, packages: [{ ecosystem: 'npm', name: 'other', version: '9.9.9' }] })).statusCode).toBe(400);
    const response = await request('POST', `/jobs/${jobId}/observations`, input); expect(response.statusCode, response.body).toBe(201); expect(advisories).toHaveBeenCalledTimes(1);
    expect((await request('GET', `/jobs/${jobId}/observations/${response.json().runId}`)).json().result.state).toBe('NO_MATCHES_REPORTED');
  });
  it('denies expired source approval and package disclosure without consent', async () => {
    const input = await sourceInput();
    expect((await request('POST', `/jobs/${jobId}/observations`, { ...input, consentToSharePackageVersions: false })).statusCode).toBe(400);
    await database.careRevision.update({ where: { id: input.revisionId }, data: { approvalExpiresAt: new Date(0) } });
    expect((await request('POST', `/jobs/${jobId}/observations`, input)).statusCode).toBe(403); expect(advisories).not.toHaveBeenCalled();
  });
  it('does not retry an interrupted operation using the same idempotency key', async () => {
    const input = networkInput(); const response = await request('POST', `/jobs/${jobId}/observations`, input);
    await database.careToolObservation.update({ where: { id: response.json().runId }, data: { state: 'RUNNING', expiresAt: new Date(0), resultArtifactId: null, completedAt: null } });
    expect((await request('POST', `/jobs/${jobId}/observations`, input)).json()).toMatchObject({ state: 'INTERRUPTED', duplicate: true }); expect(http).toHaveBeenCalledTimes(1);
  });
  it('rejects a session revoked while an external observation is in flight', async () => {
    duringObservation = () => database.session.updateMany({ where: { tenantId, userId }, data: { revokedAt: new Date() } }).then(() => undefined);
    try {
      expect((await request('POST', `/jobs/${jobId}/observations`, networkInput())).statusCode).toBe(401);
      expect(await database.careArtifact.count({ where: { jobId, kind: 'OBSERVATION_RESULT' } })).toBe(0);
    } finally { await database.session.updateMany({ where: { tenantId, userId }, data: { revokedAt: null } }); }
  });
  it('keeps production and staging credential metadata separate in the Care snapshot', async () => {
    for (const environment of ['PRODUCTION', 'STAGING']) await database.careCredential.create({ data: { tenantId, websiteId: siteId, environment, kind: 'CMS', host: 'cms.example.org', username: 'fixture', authMethod: 'PASSWORD', encryptedEnvelope: 'synthetic-not-used', authorizedBy: userId, authorizationExpiresAt: new Date(Date.now() + 3600000) } });
    const response = await request('GET', `/websites/${siteId}/care?environment=STAGING`); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().credentials).toHaveLength(1); expect(response.json().credentials[0].environment).toBe('STAGING');
  });
});
