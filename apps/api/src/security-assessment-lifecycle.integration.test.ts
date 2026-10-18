import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from 'ssh2';
import { PrismaClient } from '@prisma/client';
import { database } from '@zerochack/database';
import { encryptSecret, hashOpaqueToken } from '@zerochack/auth';
import { loadEnvironment } from '@zerochack/config';
import type { ScanRunResult } from '@zerochack/scanner';
import type { ServerInspection } from './modules/customer/ssh-toolkit.js';
import { buildApp } from './app.js';

// Real auth/RBAC and disposable PostgreSQL persistence; all external runners are synthetic.
// These tests never contact a customer host, model provider, SMTP service or public website.
const environment = loadEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380', SESSION_SECRET: 'synthetic-assessment-lifecycle-session-32chars', CORS_ORIGINS: 'http://localhost:3000', LOG_LEVEL: 'silent' });
const pin = `SHA256:${Buffer.alloc(32, 21).toString('base64')}`;
const targetUrl = 'https://example.com/';
const future = () => new Date(Date.now() + 3_600_000);
const accounts: Array<{ tenantId: string; userId: string; sessionId: string; cookie: string; websiteId: string }> = [];
let app: Awaited<ReturnType<typeof buildApp>>;
let inspection: ServerInspection;
let pausedInspection: { entered: () => void; release: () => void; released: Promise<void> } | undefined;
const end = vi.fn();
const destroy = vi.fn();
const connect = vi.fn(async () => ({ client: { end, destroy } as unknown as Client, fingerprint: pin }));
const inspect = vi.fn(async () => { if (pausedInspection) { const gate = pausedInspection; gate.entered(); await gate.released; } return inspection; });
const syntheticWeb = async (url: string): Promise<ScanRunResult> => ({ targetUrl: url, response: { url, status: 200, resolvedAddress: '93.184.216.34', redirects: [] }, findings: [], engineCount: 1 });
const web = vi.fn(syntheticWeb);
const current = () => { const account = accounts[0]; if (!account) throw new Error('Assessment fixture not initialized'); return account; };
const other = () => { const account = accounts[1]; if (!account) throw new Error('Assessment isolation fixture not initialized'); return account; };
function request(method: 'GET' | 'POST', suffix = '', cookie = current().cookie, websiteId = current().websiteId) { return app.inject({ method, url: `/v1/websites/${websiteId}/assessment${suffix}`, headers: { cookie } }); }
function boundedInspection(): ServerInspection { return { platform: 'Linux synthetic', roots: ['/srv/www/fixture'], scannedFiles: 3, scanLimitReached: false, malwareScanner: 'CLAMAV', malwareScannerStatus: 'COMPLETED', coverageState: 'BOUNDED', coverageLimitations: ['Only the bounded synthetic fixture was inspected.'], observations: [] }; }
function delayInspection(respondAsync = false) {
  let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; }); const released = new Promise<void>((resolve) => { release = resolve; });
  pausedInspection = { entered, release, released };
  const pending = (respondAsync ? app.inject({ method: 'POST', url: `/v1/websites/${current().websiteId}/assessment`, headers: { cookie: current().cookie, prefer: 'respond-async' } }) : request('POST')).then((response) => response);
  return { started, release, pending };
}
async function runningScan() { return database.scan.findFirstOrThrow({ where: { tenantId: current().tenantId, websiteId: current().websiteId, status: 'RUNNING' } }); }
async function noAcceptedResults(scanId: string) {
  expect(await database.securityFinding.count({ where: { scanId } })).toBe(0);
  expect(await database.findingEvidence.count({ where: { scanId } })).toBe(0);
  expect(await database.auditLog.count({ where: { tenantId: current().tenantId, resourceType: 'scan', resourceId: scanId, action: 'website.ai_assessment_completed' } })).toBe(0);
  expect((await database.website.findUniqueOrThrow({ where: { id: current().websiteId } })).lastScanAt).toBeNull();
}

beforeAll(async () => {
  if (!new URL(environment.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Disposable *_test database required');
  const role = await database.role.findFirstOrThrow({ where: { name: 'Customer', tenantId: null } });
  for (let index = 0; index < 2; index++) {
    const tenant = await database.tenant.create({ data: { name: 'Assessment lifecycle fixture', slug: `assessment-lifecycle-${crypto.randomUUID()}` } });
    const user = await database.user.create({ data: { email: `assessment-${crypto.randomUUID()}@example.test`, passwordHash: 'synthetic-not-a-login-hash', status: 'APPROVED', emailVerifiedAt: new Date() } });
    await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: 'ACTIVE' } });
    await database.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
    const token = crypto.randomUUID(); const session = await database.session.create({ data: { tenantId: tenant.id, userId: user.id, tokenHash: hashOpaqueToken(token, environment.SESSION_SECRET), expiresAt: future() } });
    const website = await database.website.create({ data: { tenantId: tenant.id, name: 'Assessment fixture website', url: targetUrl, normalizedHost: 'example.com', lifecycle: 'ACTIVE', connectionStatus: 'VERIFIED' } });
    accounts.push({ tenantId: tenant.id, userId: user.id, sessionId: session.id, cookie: `zerochack_session=${token}`, websiteId: website.id });
  }
  app = await buildApp(environment, { assessmentRunners: { connect, inspect, web } });
});

beforeEach(async () => {
  pausedInspection = undefined; inspection = boundedInspection(); vi.clearAllMocks(); web.mockReset(); web.mockImplementation(syntheticWeb);
  for (const account of accounts) {
    const scope = { tenantId: account.tenantId, websiteId: account.websiteId };
    await database.findingEvidence.deleteMany({ where: scope }); await database.securityFinding.deleteMany({ where: scope }); await database.chatMessage.deleteMany({ where: scope });
    await database.scan.deleteMany({ where: scope }); await database.auditLog.deleteMany({ where: { tenantId: account.tenantId } });
    await database.session.update({ where: { id: account.sessionId }, data: { revokedAt: null, revokedReason: null, expiresAt: future() } });
    await database.website.update({ where: { id: account.websiteId }, data: { url: targetUrl, normalizedHost: 'example.com', lifecycle: 'ACTIVE', connectionStatus: 'VERIFIED', securityStatus: 'UNKNOWN', lastScanAt: null } });
    const data = { host: 'ssh.example.com', port: 22, username: 'fixture-reader', authMethod: 'PASSWORD', encryptedSecret: encryptSecret('synthetic-assessment-password', environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY), hostKeyFingerprint: pin, status: 'READY_FOR_SECURE_SESSION', lastCheckedAt: new Date() };
    await database.websiteAccessCredential.upsert({ where: { websiteId: account.websiteId }, create: { ...scope, ...data }, update: data });
  }
});

afterAll(async () => {
  pausedInspection?.release(); pausedInspection = undefined;
  if (app) await app.close();
  for (const account of accounts) {
    const scope = { tenantId: account.tenantId, websiteId: account.websiteId };
    await database.findingEvidence.deleteMany({ where: scope }); await database.securityFinding.deleteMany({ where: scope }); await database.chatMessage.deleteMany({ where: scope }); await database.scan.deleteMany({ where: scope });
    await database.websiteAccessCredential.deleteMany({ where: scope }); await database.website.deleteMany({ where: { id: account.websiteId, tenantId: account.tenantId } });
    await database.auditLog.deleteMany({ where: { tenantId: account.tenantId } }); await database.session.deleteMany({ where: { tenantId: account.tenantId } }); await database.userRole.deleteMany({ where: { tenantId: account.tenantId } }); await database.tenantMembership.deleteMany({ where: { tenantId: account.tenantId } }); await database.user.delete({ where: { id: account.userId } }); await database.tenant.delete({ where: { id: account.tenantId } });
  }
  await database.$disconnect();
});

describe.sequential('authoritative security assessment lifecycle', () => {
  it('accepts a background browser inspection before the blocked runner completes and persists its later result', async () => {
    const gate = delayInspection(true);
    try {
      const accepted = await gate.pending;
      expect(accepted.statusCode, accepted.body).toBe(202);
      expect(accepted.headers['preference-applied']).toBe('respond-async');
      expect(accepted.json()).toMatchObject({ status: 'RUNNING', repairApplied: false });
      await gate.started;
      expect((await request('GET')).json().scan).toMatchObject({ id: accepted.json().scanId, status: 'RUNNING', stage: 'INSPECTING_SSH' });
      expect((await request('POST')).statusCode).toBe(409);
      gate.release(); pausedInspection = undefined;
      await vi.waitFor(async () => expect((await request('GET')).json().scan).toMatchObject({ id: accepted.json().scanId, status: 'SUCCEEDED', repairApplied: false }));
      expect(web).toHaveBeenCalledTimes(1);
    } finally { gate.release(); pausedInspection = undefined; }
  });

  it('does not acknowledge an expired authorization as an accepted background inspection', async () => {
    await database.session.update({ where: { id: current().sessionId }, data: { revokedAt: new Date() } });
    const response = await app.inject({ method: 'POST', url: `/v1/websites/${current().websiteId}/assessment`, headers: { cookie: current().cookie, prefer: 'respond-async' } });
    expect(response.statusCode).toBe(401);
    expect(connect).not.toHaveBeenCalled();
    expect(await database.scan.count({ where: { tenantId: current().tenantId } })).toBe(0);
  });

  it('returns no invented scan before execution and requires authentication', async () => {
    const empty = await request('GET'); expect(empty.statusCode, empty.body).toBe(200); expect(empty.json().scan).toBeNull(); expect(empty.headers['cache-control']).toContain('no-store');
    expect((await app.inject({ method: 'GET', url: `/v1/websites/${current().websiteId}/assessment` })).statusCode).toBe(401);
    expect(connect).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled(); expect(web).not.toHaveBeenCalled();
  });

  it('persists completed bounded results, truthful capability flags and the reloadable stage audit', async () => {
    inspection.observations = [{ kind: 'WORLD_WRITABLE', path: '/srv/www/fixture/index.html', detail: 'Synthetic permission indicator' }];
    const response = await request('POST'); expect(response.statusCode, response.body).toBe(201);
    const scan = await database.scan.findFirstOrThrow({ where: { tenantId: current().tenantId, websiteId: current().websiteId } });
    expect(scan).toMatchObject({ status: 'SUCCEEDED', progress: 100, errorCode: null }); expect(scan.completedAt).not.toBeNull();
    const dto = (await request('GET')).json().scan;
    expect(dto).toMatchObject({ id: scan.id, status: 'SUCCEEDED', stage: 'COMPLETED', errorCode: null, repairApplied: false, coverageState: 'BOUNDED', coverageLimitations: inspection.coverageLimitations });
    expect(Number.isNaN(Date.parse(dto.updatedAt))).toBe(false);
    const findings = await database.securityFinding.findMany({ where: { scanId: scan.id } }); expect(findings).toHaveLength(1); expect(findings.every((finding) => finding.remediationSupported === false)).toBe(true);
    expect(await database.findingEvidence.count({ where: { scanId: scan.id } })).toBe(1);
    const audits = await database.auditLog.findMany({ where: { tenantId: current().tenantId, resourceType: 'scan', resourceId: scan.id } });
    expect(audits.some((audit) => { const metadata = audit.metadata as Record<string, unknown> | null; return metadata?.websiteId === current().websiteId && metadata.stage === 'COMPLETED'; })).toBe(true);
    expect(JSON.stringify(audits)).not.toContain('synthetic-assessment-password'); expect(end).toHaveBeenCalledTimes(1);
    const cancel = await request('POST', `/${scan.id}/cancel`); expect(cancel.statusCode).toBe(409); expect(cancel.json().error.code).toBe('ASSESSMENT_NOT_ACTIVE');
    expect((await request('GET')).json().scan).toMatchObject({ status: 'SUCCEEDED', stage: 'COMPLETED' });
  });

  it('retains incomplete coverage without turning an unobserved clean result into HEALTHY', async () => {
    inspection = { ...boundedInspection(), coverageState: 'INCOMPLETE', scanLimitReached: true, malwareScanner: 'CLAMAV', malwareScannerStatus: 'TIMED_OUT', coverageLimitations: ['Synthetic antivirus timed out; clean coverage cannot be claimed.'] };
    const response = await request('POST'); expect(response.statusCode, response.body).toBe(201);
    expect((await request('GET')).json().scan).toMatchObject({ status: 'SUCCEEDED', stage: 'COMPLETED', repairApplied: false, coverageState: 'INCOMPLETE', coverageLimitations: inspection.coverageLimitations });
    expect(await database.website.findUniqueOrThrow({ where: { id: current().websiteId } })).toMatchObject({ securityStatus: 'UNKNOWN' });
  });

  it('persists public-runner failure without exposing sensitive raw errors or accepting partial evidence', async () => {
    inspection.observations = [{ kind: 'WORLD_WRITABLE', path: '/srv/www/fixture/index.html' }];
    const sensitiveError = 'password=synthetic-should-not-appear token=synthetic-should-not-appear'; web.mockRejectedValueOnce(new Error(sensitiveError));
    const response = await request('POST'); expect(response.statusCode, response.body).toBe(409); expect(response.body).not.toContain(sensitiveError); expect(response.body).not.toContain('synthetic-should-not-appear');
    const scan = await database.scan.findFirstOrThrow({ where: { tenantId: current().tenantId, websiteId: current().websiteId } }); expect(scan).toMatchObject({ status: 'FAILED', errorCode: response.json().error.code }); expect(scan.errorCode).toMatch(/^[A-Z_]+$/); expect(scan.completedAt).not.toBeNull();
    const dto = (await request('GET')).json().scan; expect(dto).toMatchObject({ id: scan.id, status: 'FAILED', stage: 'FAILED', repairApplied: false });
    const [messages, audits] = await Promise.all([database.chatMessage.findMany({ where: { tenantId: current().tenantId, websiteId: current().websiteId } }), database.auditLog.findMany({ where: { tenantId: current().tenantId, resourceId: scan.id } })]);
    expect(JSON.stringify({ messages, audits, dto })).not.toContain('synthetic-should-not-appear'); await noAcceptedResults(scan.id);
  });

  it('refuses a duplicate active assessment instead of starting another external runner', async () => {
    const gate = delayInspection(); await gate.started; const scan = await runningScan();
    try {
      const duplicate = await request('POST'); expect(duplicate.statusCode, duplicate.body).toBe(409); expect(duplicate.json().error.code).toBe('SCAN_ALREADY_ACTIVE');
      expect(await database.scan.count({ where: { tenantId: current().tenantId, websiteId: current().websiteId } })).toBe(1); expect(connect).toHaveBeenCalledTimes(1); expect(inspect).toHaveBeenCalledTimes(1);
      expect((await request('GET')).json().scan).toMatchObject({ id: scan.id, status: 'RUNNING', stage: 'INSPECTING_SSH' });
    } finally { gate.release(); pausedInspection = undefined; }
    expect((await gate.pending).statusCode).toBe(201);
  });

  it('bounds global assessment admission at two recent synthetic active website runs', async () => {
    for (const account of accounts) {
      const scan = await database.scan.create({ data: { tenantId: account.tenantId, websiteId: account.websiteId, status: 'RUNNING', startedAt: new Date() } });
      await database.auditLog.create({ data: { tenantId: account.tenantId, actorUserId: account.userId, requestId: crypto.randomUUID(), action: 'website.ai_assessment_started', resourceType: 'scan', resourceId: scan.id, metadata: { websiteId: account.websiteId, stage: 'CONNECTING' } } });
    }
    const response = await request('POST'); expect(response.statusCode, response.body).toBe(429); expect(response.json().error.code).toBe('ASSESSMENT_CAPACITY');
    expect(connect).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled(); expect(web).not.toHaveBeenCalled();
    expect(await database.scan.count({ where: { tenantId: { in: accounts.map((account) => account.tenantId) } } })).toBe(2);
  });

  it('projects stale running evidence as interrupted without fabricating completion or new checks', async () => {
    const stale = new Date(Date.now() - 181_000); const account = current();
    const scan = await database.scan.create({ data: { tenantId: account.tenantId, websiteId: account.websiteId, status: 'RUNNING', startedAt: stale } });
    await database.auditLog.create({ data: { tenantId: account.tenantId, actorUserId: account.userId, requestId: crypto.randomUUID(), action: 'website.ai_assessment_started', resourceType: 'scan', resourceId: scan.id, createdAt: stale, metadata: { websiteId: account.websiteId, stage: 'INSPECTING_SSH' } } });
    const response = await request('GET'); expect(response.statusCode, response.body).toBe(200); expect(response.json().scan).toMatchObject({ id: scan.id, status: 'RUNNING', stage: 'INTERRUPTED', repairApplied: false, errorCode: null });
    expect(await database.scan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({ status: 'RUNNING', completedAt: null }); await noAcceptedResults(scan.id);
    expect(connect).not.toHaveBeenCalled(); expect(inspect).not.toHaveBeenCalled(); expect(web).not.toHaveBeenCalled();
  });

  it('fails closed on a competing session update before final evidence commit', async () => {
    inspection.observations = [{ kind: 'WORLD_WRITABLE', path: '/srv/www/fixture/index.html' }];
    const connection = new PrismaClient(); let release!: () => void; let locked!: () => void;
    const releaseLock = new Promise<void>((resolve) => { release = resolve; }); const acquired = new Promise<void>((resolve) => { locked = resolve; });
    let holding: Promise<void> | undefined;
    // This query is after the final SAVING_EVIDENCE progress transaction but before
    // evidence commit. Its test-only hook acquires a real independent database lock.
    const prices = vi.spyOn(database.securityFixPrice, 'findMany').mockImplementationOnce(() => {
      holding = connection.$transaction(async (tx) => {
        await tx.session.update({ where: { id: current().sessionId }, data: { revokedReason: 'synthetic-session-lock-contention' } }); locked(); await releaseLock;
      }, { timeout: 15_000 });
      return Promise.race([acquired.then(() => []), holding.then(() => { throw new Error('Synthetic authority lock ended before acquisition'); })]) as ReturnType<typeof database.securityFixPrice.findMany>;
    });
    try {
      const response = await request('POST'); expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe('ASSESSMENT_AUTHORITY_BUSY');
      const scan = await database.scan.findFirstOrThrow({ where: { tenantId: current().tenantId, websiteId: current().websiteId } }); expect(scan).toMatchObject({ status: 'FAILED', errorCode: 'ASSESSMENT_AUTHORITY_BUSY' }); await noAcceptedResults(scan.id);
      expect(await database.auditLog.count({ where: { tenantId: current().tenantId, resourceId: scan.id, action: 'website.ai_assessment_progress', metadata: { path: ['stage'], equals: 'SAVING_EVIDENCE' } } })).toBe(1);
    } finally { release(); try { await holding; } finally { prices.mockRestore(); await connection.$disconnect(); } }
  });

  it('cancels a delayed assessment without accepting later findings or overwriting CANCELLED', async () => {
    inspection.observations = [{ kind: 'WORLD_WRITABLE', path: '/srv/www/fixture/index.html' }]; const gate = delayInspection(); await gate.started; const scan = await runningScan();
    try {
      expect((await request('GET')).json().scan).toMatchObject({ id: scan.id, status: 'RUNNING', stage: 'INSPECTING_SSH', repairApplied: false });
      const response = await request('POST', `/${scan.id}/cancel`); expect(response.statusCode, response.body).toBe(200); expect((await request('GET')).json().scan).toMatchObject({ id: scan.id, status: 'FAILED', stage: 'CANCELLED', errorCode: 'ASSESSMENT_CANCELLED', repairApplied: false });
      expect((await request('POST', `/${scan.id}/cancel`)).statusCode).toBe(200);
      expect(await database.auditLog.count({ where: { tenantId: current().tenantId, resourceType: 'scan', resourceId: scan.id, action: 'website.ai_assessment_cancelled' } })).toBe(1);
    }
    finally { gate.release(); pausedInspection = undefined; }
    const response = await gate.pending; expect(response.statusCode, response.body).toBe(409); expect(response.json().error.code).toBe('ASSESSMENT_CANCELLED');
    expect(await database.scan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({ status: 'FAILED', errorCode: 'ASSESSMENT_CANCELLED' }); await noAcceptedResults(scan.id); expect(web).not.toHaveBeenCalled();
  });

  for (const condition of ['target', 'access', 'session'] as const) it(`rejects ${condition} drift during the runner before accepting results`, async () => {
    inspection.observations = [{ kind: 'WORLD_WRITABLE', path: '/srv/www/fixture/index.html' }]; const gate = delayInspection(); await gate.started; const scan = await runningScan();
    try {
      if (condition === 'target') await database.website.update({ where: { id: current().websiteId }, data: { url: 'https://changed.example.com/', normalizedHost: 'changed.example.com' } });
      if (condition === 'access') await database.websiteAccessCredential.update({ where: { websiteId: current().websiteId }, data: { username: 'different-account', encryptedSecret: encryptSecret('synthetic-rotated-password', environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY) } });
      if (condition === 'session') await database.session.update({ where: { id: current().sessionId }, data: { revokedAt: new Date(), revokedReason: 'synthetic-drift-test' } });
    } finally { gate.release(); pausedInspection = undefined; }
    const response = await gate.pending; expect(response.statusCode, response.body).toBe(condition === 'session' ? 403 : 409); expect(response.json().error.code).toBe(condition === 'session' ? 'AUTHORIZATION_REQUIRED' : 'ASSESSMENT_BINDING_CHANGED');
    const saved = await database.scan.findUniqueOrThrow({ where: { id: scan.id } }); expect(saved.status).toBe('FAILED'); expect(saved.errorCode).toBe(response.json().error.code); await noAcceptedResults(scan.id); expect(web).not.toHaveBeenCalled();
  });

  it('denies another tenant read or cancellation without changing the running assessment', async () => {
    const gate = delayInspection(); await gate.started; const scan = await runningScan();
    try {
      expect((await request('GET', '', other().cookie)).statusCode).toBe(404);
      expect((await request('POST', `/${scan.id}/cancel`, other().cookie)).statusCode).toBe(404);
      expect(await database.scan.findUniqueOrThrow({ where: { id: scan.id } })).toMatchObject({ status: 'RUNNING' });
    } finally { gate.release(); pausedInspection = undefined; }
    const response = await gate.pending; expect(response.statusCode, response.body).toBe(201); expect((await request('GET')).json().scan).toMatchObject({ status: 'SUCCEEDED', stage: 'COMPLETED' });
  });
});
