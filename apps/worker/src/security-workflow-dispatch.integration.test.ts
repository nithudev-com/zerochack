import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import type { Prisma } from '@prisma/client';
import { database } from '@zerochack/database';
import { manifestDigest, SecurityWorkflowError, type SecurityScope } from '@zerochack/security-orchestration';
import { createSecurityRepairController, type SecurityControllerOptions } from '../../api/src/modules/security-repair/controller.js';
import { createSecurityRepairJournal } from '../../api/src/modules/security-repair/journal.js';
import { assertSecurityWorkplaceTestDatabase, assertSecurityWorkplaceTestRedisUrl } from '../../api/src/modules/security-repair/fixture-guard.test-helper.js';
import { createSecurityWorkflowDispatch, securityWorkflowDispatchJobId, securityWorkflowJobOptions } from './security-workflow-dispatch.js';

type Fixture = Awaited<ReturnType<typeof buildFixture>>;
const owned: Fixture[] = [];
beforeAll(async () => {
  await assertSecurityWorkplaceTestDatabase();
  assertSecurityWorkplaceTestRedisUrl(process.env.REDIS_URL);
});
afterAll(async () => {
  for (const f of owned) {
    for (const dispatcher of f.dispatchers) await dispatcher.close();
    // Only this fixture's fresh, random, validated queue. Never FLUSHDB/FLUSHALL,
    // and never delete application queues or a queue with a running processor.
    if (!/^security-workflow-test-[a-f0-9]{8}-[a-f0-9]{8}$/u.test(f.queueName)) throw new Error('Disposable queue ownership guard failed.');
    await f.queue.obliterate({ force: false }); await f.queue.close(); f.connection.disconnect();
    const where = { tenantId: f.scope.tenantId };
    await database.securityRepairDecision.deleteMany({ where }); await database.securityGraphWrite.deleteMany({ where }); await database.securityGraphCheckpoint.deleteMany({ where }); await database.securityRepairOutbox.deleteMany({ where }); await database.securityRepairCostEntry.deleteMany({ where }); await database.securityRepairAttempt.deleteMany({ where }); await database.securityRepairRun.deleteMany({ where }); await database.careArtifact.deleteMany({ where }); await database.tenant.delete({ where: { id: f.scope.tenantId } }); await database.user.delete({ where: { id: f.actorId } });
  }
  await database.$disconnect();
});
async function buildFixture() {
  const now = new Date(); const tenant = await database.tenant.create({ data: { name: 'Disposable Security dispatch fixture', slug: `security-dispatch-${randomUUID()}` } });
  const actor = await database.user.create({ data: { email: `${randomUUID()}@example.test`, status: 'APPROVED', emailVerifiedAt: now, mfaEnabledAt: now } });
  await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: actor.id, status: 'ACTIVE' } });
  const session = await database.session.create({ data: { tenantId: tenant.id, userId: actor.id, tokenHash: randomUUID(), expiresAt: new Date(now.getTime() + 3600000), mfaVerifiedAt: now } });
  const website = await database.website.create({ data: { tenantId: tenant.id, name: 'Selected disposable site', url: 'https://dispatch.example.test/', normalizedHost: 'dispatch.example.test' } });
  const scope: SecurityScope = { tenantId: tenant.id, websiteId: website.id, environment: 'STAGING', runId: randomUUID() }; let executions = 0;
  const options: SecurityControllerOptions = {
    database, scope, workerId: randomUUID(), artifactKey: Buffer.alloc(32, 47).toString('base64'), heartbeatMs: 500, drainMs: 100, runTimeoutMs: 20000,
    binding: { actorId: actor.id, sessionId: session.id, requestDigest: 'a'.repeat(64), authorityDigest: manifestDigest({ actorId: actor.id, sessionId: session.id }), implementationDigest: 'b'.repeat(64), allowanceMicros: 0, policy: 'security-workflow-v1' },
    steps: {
      plan: { kind: 'READ', reserveMicros: 0, timeoutMs: 10000, implementationId: 'dispatch-fixture.plan', implementationVersion: 'v1', implementationDigest: 'c'.repeat(64), async readiness() { return { ready: true }; }, async execute() {
        // Actual DB receipt only. No model, sandbox, customer SSH or repair runs.
        executions++; const digest = createHash('sha256').update(`dispatch-synthetic-plan:${scope.runId}`).digest('hex');
        const artifact = await database.careArtifact.create({ data: { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, kind: 'REPORT', filename: 'synthetic-dispatch-plan.json', contentType: 'application/json', status: 'ACCEPTED', digest, sizeBytes: 2, encryptedBody: 'synthetic-receipt-not-recovery-proof', createdBy: actor.id } });
        return { outcome: 'SUCCEEDED', artifact: { artifactId: artifact.id, digest }, costMicros: 0 };
      } },
      snapshot: { kind: 'READ', reserveMicros: 0, timeoutMs: 10000, implementationId: 'dispatch-fixture.snapshot', implementationVersion: 'v1', implementationDigest: 'd'.repeat(64), async readiness() { return { ready: false, code: 'SECURITY_FIXTURE_RUNTIME_UNAVAILABLE' }; }, async execute() { throw new Error('Unavailable fixture must not execute.'); } }
    },
    async authorize(tx: Prisma.TransactionClient, requested, _operation, run) {
      if (manifestDigest(requested) !== manifestDigest(scope) || run && (run.actorId !== actor.id || run.sessionId !== session.id)) throw new SecurityWorkflowError('SECURITY_FIXTURE_AUTHORITY_DENIED');
      await tx.$queryRaw`SELECT id FROM users WHERE id=${actor.id}::uuid FOR SHARE`; await tx.$queryRaw`SELECT id FROM sessions WHERE id=${session.id}::uuid FOR SHARE`;
      const [currentActor, currentSession, membership] = await Promise.all([tx.user.findUniqueOrThrow({ where: { id: actor.id } }), tx.session.findUniqueOrThrow({ where: { id: session.id } }), tx.tenantMembership.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: tenant.id, userId: actor.id } } })]);
      if (currentActor.status !== 'APPROVED' || !currentActor.mfaEnabledAt || membership.status !== 'ACTIVE' || currentSession.revokedAt || currentSession.expiresAt <= new Date() || !currentSession.mfaVerifiedAt || currentSession.mfaVerifiedAt.getTime() < Date.now() - 300000) throw new SecurityWorkflowError('SECURITY_FIXTURE_AUTHORITY_DENIED');
    }
  };
  const admission = createSecurityRepairController(options), journal = createSecurityRepairJournal({ database, assertAuthority: admission.authorizeJournal });
  await journal.createRun({ ...admission.expectedCreateBinding, requestKey: randomUUID(), expiresAt: new Date(Date.now() + 60000) });
  const controllerFactory = vi.fn(async (requested: Readonly<SecurityScope>) => {
    const run = await database.securityRepairRun.findFirstOrThrow({ where: { id: requested.runId, tenantId: requested.tenantId, websiteId: requested.websiteId, environment: requested.environment } });
    const controller = createSecurityRepairController({ ...options, scope: requested, workerId: randomUUID(), binding: { ...options.binding, actorId: run.actorId, sessionId: run.sessionId, authorityDigest: run.authorityDigest, allowanceMicros: run.allowanceMicros } });
    if (controller.inputDigest !== run.inputDigest) throw new SecurityWorkflowError('SECURITY_FIXTURE_BINDING_CHANGED'); return controller;
  });
  const connection = new Redis(process.env.REDIS_URL!, { maxRetriesPerRequest: null }); connection.on('error', () => undefined);
  const queueName = `security-workflow-test-${process.env.SECURITY_WORKPLACE_TEST_ATTEMPT}-${randomUUID().slice(0, 8)}`;
  const dispatchOptions = { database, connection, dispatcherId: randomUUID(), controllerFactory, queueName, shutdownTimeoutMs: 1000, publishTimeoutMs: 1000 };
  // This test-only inspector can represent adversarial raw Redis job data. The
  // production publisher and processor still use the strict dispatch payload.
  const dispatch = createSecurityWorkflowDispatch(dispatchOptions), queue = new Queue<unknown>(queueName, { connection });
  const dispatchers = [dispatch]; const value = { scope, actorId: actor.id, sessionId: session.id, journal, connection, queueName, queue, dispatch, dispatchOptions, dispatchers, controllerFactory, executions: () => executions };
  return value;
}
async function fixture() { const value = await buildFixture(); owned.push(value); return value; }
async function event(f: Fixture, type: 'run.created' | 'decision.approved' | 'decision.denied') { return database.securityRepairOutbox.findFirstOrThrow({ where: { runId: f.scope.runId, eventType: type } }); }
async function completed(f: Fixture, eventId: string, status: 'completed' | 'failed' = 'completed') { const id = securityWorkflowDispatchJobId(eventId); await expect.poll(async () => (await f.queue.getJob(id))?.getState(), { timeout: 10000 }).toBe(status); return (await f.queue.getJob(id))!; }
async function savedDecision(f: Fixture, status: 'APPROVED' | 'DENIED') {
  const plan = await database.securityRepairAttempt.findFirstOrThrow({ where: { runId: f.scope.runId, stepKey: 'plan', state: 'SUCCEEDED' } });
  return f.journal.recordCandidateDecision(f.scope, { actorId: f.actorId, sessionId: f.sessionId, requestKey: randomUUID(), artifactId: plan.artifactId!, digest: plan.artifactDigest!, status });
}

describe.sequential('real PostgreSQL + BullMQ/Redis isolated dispatch; synthetic read-only node receipts only', () => {
  it('publishes once from a fenced outbox, runs a real controller once and leaves progress events undispatched', async () => {
    const f = await fixture(), created = await event(f, 'run.created'); expect(await f.dispatch.flush()).toEqual({ claimed: 1, published: 1, unconfirmed: 0 }); expect(await f.dispatch.flush()).toEqual({ claimed: 0, published: 0, unconfirmed: 0 }); await f.dispatch.start();
    const job = await completed(f, created.id); expect(job.opts).toMatchObject({ attempts: 1, keepLogs: 0 }); expect(job.attemptsStarted).toBe(1); expect(await f.queue.getGlobalConcurrency()).toBe(1); expect(f.executions()).toBe(1); expect(f.controllerFactory).toHaveBeenCalledWith(f.scope);
    expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ phase: 'AWAITING_APPROVAL', leaseOwnerId: null }); expect(await database.securityRepairOutbox.findUniqueOrThrow({ where: { id: created.id } })).toMatchObject({ dispatchAttempts: 1, dispatchVersion: 1, dispatchOwnerId: null }); expect((await database.securityRepairOutbox.findUniqueOrThrow({ where: { id: created.id } })).publishedAt).toBeInstanceOf(Date); expect(await database.securityRepairOutbox.count({ where: { runId: f.scope.runId, eventType: { notIn: ['run.created', 'decision.approved', 'decision.denied'] }, publishedAt: { not: null } } })).toBe(0);
  });
  it.each(['APPROVED', 'DENIED'] as const)('dispatches a real saved %s candidate decision without replaying plan or enabling a runtime', async status => {
    const f = await fixture(); await f.dispatch.flush(); await f.dispatch.start(); await completed(f, (await event(f, 'run.created')).id); const decisionId = await savedDecision(f, status); expect(await f.dispatch.flush()).toEqual({ claimed: 1, published: 1, unconfirmed: 0 }); const decisionEvent = await event(f, status === 'APPROVED' ? 'decision.approved' : 'decision.denied'), job = await completed(f, decisionEvent.id); expect(job.data).toEqual({ ...f.scope, mode: 'resume', decisionId }); expect(f.executions()).toBe(1); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(1); expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ phase: status === 'APPROVED' ? 'WAITING_FOR_INPUT' : 'CANCELLED', reservedMicros: 0, chargedMicros: 0, leaseOwnerId: null });
  });
  it.each(['CANCELLED', 'OUTCOME_UNKNOWN'] as const)('skips a queued job after authoritative %s without constructing a controller or replaying unknown work', async expected => {
    const f = await fixture(); await f.dispatch.flush(); if (expected === 'OUTCOME_UNKNOWN') { const fence = await f.journal.claimRun(f.scope, randomUUID()); await f.journal.beginStep(f.scope, fence, { stepKey: 'plan', kind: 'READ', reserveMicros: 0, inputDigest: 'f'.repeat(64) }); }
    await f.journal.stopRun(f.scope, { actorId: f.actorId, sessionId: f.sessionId }); await f.dispatch.start(); const job = await completed(f, (await event(f, 'run.created')).id); expect(job.returnvalue).toMatchObject({ disposition: 'SKIPPED', code: 'SECURITY_DISPATCH_EVENT_STALE' }); expect(f.controllerFactory).not.toHaveBeenCalled(); expect(f.executions()).toBe(0); expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ phase: expected }); expect(await f.dispatch.flush()).toEqual({ claimed: 0, published: 0, unconfirmed: 0 });
  });
  it('fails a tampered job once before authority construction and never treats arbitrary queue data as a command', async () => {
    const f = await fixture(); await f.dispatch.flush(); const created = await event(f, 'run.created'), job = (await f.queue.getJob(securityWorkflowDispatchJobId(created.id)))!; await job.updateData({ ...f.scope, mode: 'start', command: 'synthetic-untrusted-command' }); await f.dispatch.start(); const failed = await completed(f, created.id, 'failed'); expect(failed.attemptsMade).toBe(1); expect(failed.attemptsStarted).toBe(1); expect(failed.failedReason).toBe('SECURITY_DISPATCH_JOB_FAILED'); expect(f.controllerFactory).not.toHaveBeenCalled(); expect(f.executions()).toBe(0); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(0);
  });
  it('rechecks real session authority inside the controller after queue admission and refuses a revoked actor without an effect', async () => {
    const f = await fixture(); await f.dispatch.flush(); await database.session.update({ where: { id: f.sessionId }, data: { revokedAt: new Date() } }); await f.dispatch.start(); const job = await completed(f, (await event(f, 'run.created')).id); expect(job.returnvalue).toMatchObject({ disposition: 'CONTROLLER', result: { disposition: 'UNCONFIRMED', code: 'SECURITY_FIXTURE_AUTHORITY_DENIED', effectsUndone: false } }); expect(f.executions()).toBe(0); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(0); expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ phase: 'PLANNING', leaseOwnerId: null });
  });
  it('uses PostgreSQL lease locking and deterministic BullMQ IDs across two concurrent publishers', async () => {
    const f = await fixture(), other = createSecurityWorkflowDispatch({ ...f.dispatchOptions, dispatcherId: randomUUID() }); f.dispatchers.push(other); const results = await Promise.all([f.dispatch.flush(), other.flush()]); expect(results.reduce((sum, value) => sum + value.claimed, 0)).toBe(1); expect(results.reduce((sum, value) => sum + value.published, 0)).toBe(1); await f.dispatch.start(); await other.start(); await completed(f, (await event(f, 'run.created')).id); expect(f.executions()).toBe(1); expect(await f.queue.getGlobalConcurrency()).toBe(1); expect((await f.queue.getJob(securityWorkflowDispatchJobId((await event(f, 'run.created')).id)))!.opts).toMatchObject(securityWorkflowJobOptions);
  });
});
