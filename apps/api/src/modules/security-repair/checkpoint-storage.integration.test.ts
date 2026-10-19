import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient, type Prisma, type SecurityRepairRun } from '@prisma/client';
import { database } from '@zerochack/database';
import { loadEnvironment } from '@zerochack/config';
import { createSecurityWorkflow, manifestDigest, SecurityCheckpointer, securityThread, SecurityWorkflowError, type ArtifactReceipt, type SecurityScope, type SecurityWorkflowServices } from '@zerochack/security-orchestration';
import { readArtifact, writeArtifact } from '../care/repair-service.js';
import { createSecurityRepairJournal, type SecurityLeaseFence } from './journal.js';
import { securityCheckpointStorage } from './checkpoint-storage.js';
import { assertSecurityWorkplaceTestDatabase } from './fixture-guard.test-helper.js';

const fixtures: Array<{ tenantId: string; userId: string }> = [];
const key = Buffer.alloc(32, 39).toString('base64');
const env = loadEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: 'redis://127.0.0.1:6380', SESSION_SECRET: 'checkpoint-test-session-key-at-least-32-characters', CORS_ORIGINS: 'http://localhost:3000', CARE_ARTIFACT_KEY: key });
beforeAll(assertSecurityWorkplaceTestDatabase);
afterAll(async () => {
  for (const f of fixtures) {
    const where = { tenantId: f.tenantId };
    await database.securityGraphWrite.deleteMany({ where });
    await database.securityGraphCheckpoint.deleteMany({ where });
    await database.securityRepairDecision.deleteMany({ where });
    await database.securityRepairOutbox.deleteMany({ where });
    await database.securityRepairCostEntry.deleteMany({ where });
    await database.securityRepairAttempt.deleteMany({ where });
    await database.securityRepairRun.deleteMany({ where });
    await database.tenant.delete({ where: { id: f.tenantId } });
    await database.user.delete({ where: { id: f.userId } });
  }
  await database.$disconnect();
});
async function fixture() {
  const tenant = await database.tenant.create({ data: { name: 'Checkpoint protocol fixture', slug: `checkpoint-${randomUUID()}` } });
  const user = await database.user.create({ data: { email: `${randomUUID()}@example.test`, status: 'APPROVED', emailVerifiedAt: new Date() } });
  fixtures.push({ tenantId: tenant.id, userId: user.id });
  await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: 'ACTIVE' } });
  const role = await database.role.findFirstOrThrow({ where: { tenantId: null, name: 'Customer' } });
  await database.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
  const session = await database.session.create({ data: { tenantId: tenant.id, userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) } });
  const site = await database.website.create({ data: { tenantId: tenant.id, name: 'Synthetic selected site', url: 'https://example.test/', normalizedHost: 'example.test' } });
  const scope: SecurityScope = { tenantId: tenant.id, websiteId: site.id, environment: 'STAGING', runId: randomUUID() };
  async function authority(tx: Prisma.TransactionClient, requested: SecurityScope) {
    if (securityThread(requested) !== securityThread(scope)) throw new SecurityWorkflowError('TEST_AUTHORITY_DENIED');
    await tx.$queryRaw`SELECT id FROM sessions WHERE id=${session.id}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM users WHERE id=${user.id}::uuid FOR SHARE`;
    const current = await tx.session.findFirst({ where: { id: session.id, tenantId: tenant.id, userId: user.id, revokedAt: null, expiresAt: { gt: new Date() } } });
    const actor = await tx.user.findFirst({ where: { id: user.id, status: 'APPROVED', memberships: { some: { tenantId: tenant.id, status: 'ACTIVE' } } } });
    if (!current || !actor) throw new SecurityWorkflowError('TEST_AUTHORITY_DENIED');
  }
  const journal = createSecurityRepairJournal({ database, assertAuthority: authority });
  await journal.createRun({ ...scope, actorId: user.id, sessionId: session.id, requestKey: randomUUID(), inputDigest: manifestDigest({ fixture: true }), authorityDigest: manifestDigest({ sessionId: session.id }), allowanceMicros: 100, expiresAt: new Date(Date.now() + 600_000) });
  let calls = 0;
  const graph = (fence: SecurityLeaseFence, client = database) => {
    const currentJournal = createSecurityRepairJournal({ database: client, assertAuthority: authority });
    const storage = securityCheckpointStorage(client, scope, fence, async (tx, _run: SecurityRepairRun) => authority(tx, scope));
    const services: SecurityWorkflowServices = {
      async assertLeaseAndAuthority() { await storage.assertLease(); },
      async transition(phase, code) { await currentJournal.transition(scope, fence, phase, code); },
      async decision(kind, id, receipt) {
        if (kind !== 'CANDIDATE') throw new SecurityWorkflowError('UNREGISTERED_SECURITY_EXECUTOR');
        return currentJournal.resolveCandidateDecision(scope, fence, id, receipt);
      },
      async step(step, input) {
        // Fixed trusted synthetic operation; no provider/customer/runtime code.
        if (step !== 'plan') return { outcome: 'BLOCKED', code: 'FIXTURE_RUNTIME_UNAVAILABLE' };
        const attempt = await currentJournal.beginStep(scope, fence, { stepKey: 'plan', kind: 'MODEL', reserveMicros: 50, inputDigest: manifestDigest({ step, previous: input.previous ?? null }) });
        if (attempt.outcome === 'SUCCEEDED') return attempt;
        calls++;
        const artifact = await client.$transaction(tx => writeArtifact(tx, { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, jobId: null, createdBy: user.id }, Buffer.from(JSON.stringify({ fixture: true, policy: 'synthetic-plan-only', inspected: false, mutation: false })), 'REPORT', 'synthetic-security-plan.json', 'application/json', env));
        expect(JSON.parse(readArtifact(artifact, env).toString())).toMatchObject({ fixture: true, mutation: false });
        await currentJournal.completeStep(scope, fence, attempt.attemptId, { artifactId: artifact.id, digest: artifact.digest, costMicros: 7 });
        return { outcome: 'SUCCEEDED', artifact: { artifactId: artifact.id, digest: artifact.digest }, costMicros: 7 };
      }
    };
    return createSecurityWorkflow(scope, new SecurityCheckpointer(scope, storage, key), services);
  };
  return { scope, journal, user, session, graph, calls: () => calls };
}

describe.sequential('actual PostgreSQL encrypted security checkpoints; synthetic effects only', () => {
  it('pauses, releases the lease, rebuilds with a new database client and resumes a persisted exact decision without replay', async () => {
    const f = await fixture(), fence = await f.journal.claimRun(f.scope, randomUUID());
    const first = await f.graph(fence).start();
    expect(first).toHaveProperty('__interrupt__.length', 1); expect(f.calls()).toBe(1);
    const receipt = first.artifact as ArtifactReceipt;
    const rows = await database.securityGraphCheckpoint.findMany({ where: { runId: f.scope.runId } });
    expect(rows.length).toBeGreaterThan(1);
    expect(JSON.stringify(rows)).not.toContain('synthetic-plan-only');
    expect(JSON.stringify(rows)).not.toContain('AWAITING_APPROVAL');
    await f.journal.releaseLease(f.scope, fence);
    const decisionId = await f.journal.recordCandidateDecision(f.scope, { actorId: f.user.id, sessionId: f.session.id, requestKey: randomUUID(), artifactId: receipt.artifactId, digest: receipt.digest, status: 'APPROVED' });
    const next = await f.journal.claimRun(f.scope, randomUUID()), reopened = new PrismaClient();
    try {
      const result = await f.graph(next, reopened).resume({ decisionId });
      expect(result.phase).toBe('WAITING_FOR_INPUT'); expect(f.calls()).toBe(1);
      expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(1);
      expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'SETTLE' } })).toBe(1);
      expect(await database.securityRepairRun.findUnique({ where: { id: f.scope.runId } })).toMatchObject({ chargedMicros: 7, reservedMicros: 0, phase: 'WAITING_FOR_INPUT' });
    } finally { await reopened.$disconnect(); }
  });
  it('rejects revoked sessions before reading a checkpoint or invoking a synthetic effect', async () => {
    const f = await fixture(), fence = await f.journal.claimRun(f.scope, randomUUID());
    await f.graph(fence).start();
    await database.session.update({ where: { id: f.session.id }, data: { revokedAt: new Date() } });
    await expect(f.graph(fence).status()).rejects.toThrow('TEST_AUTHORITY_DENIED');
    expect(f.calls()).toBe(1);
  });
  it('fences old owners and refuses raw checkpoint access across site or environment', async () => {
    const f = await fixture(), fence = await f.journal.claimRun(f.scope, randomUUID());
    await f.graph(fence).start(); await f.journal.releaseLease(f.scope, fence);
    await expect(f.graph(fence).status()).rejects.toThrow('SECURITY_LEASE_LOST');
    const next = await f.journal.claimRun(f.scope, randomUUID());
    const storage = securityCheckpointStorage(database, f.scope, next, async () => {});
    await expect(storage.checkpoint({ ...f.scope, environment: 'PRODUCTION' })).rejects.toThrow('SECURITY_CHECKPOINT_SCOPE_DENIED');
    await expect(storage.checkpoint({ ...f.scope, websiteId: randomUUID() })).rejects.toThrow('SECURITY_CHECKPOINT_SCOPE_DENIED');
  });
});
