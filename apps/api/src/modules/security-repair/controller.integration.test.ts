import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { database } from '@zerochack/database';
import { SecurityWorkflowError, type SecurityScope, type SecurityWorkStep } from '@zerochack/security-orchestration';
import { createSecurityRepairController, type SecurityControllerOptions, type SecurityControllerStep } from './controller.js';
import { createSecurityRepairJournal } from './journal.js';
import { assertSecurityWorkplaceTestDatabase } from './fixture-guard.test-helper.js';

const owned: Array<{ tenantId: string; actorId: string }> = [];
beforeAll(assertSecurityWorkplaceTestDatabase);
afterAll(async () => {
  // Unique fixtures only. Child-first cleanup respects retained history FKs and
  // must never be pointed at an application/production database.
  for (const { tenantId, actorId } of owned) {
    const where = { tenantId };
    await database.securityRepairDecision.deleteMany({ where });
    await database.securityGraphWrite.deleteMany({ where });
    await database.securityGraphCheckpoint.deleteMany({ where });
    await database.securityRepairOutbox.deleteMany({ where });
    await database.securityRepairCostEntry.deleteMany({ where });
    await database.securityRepairAttempt.deleteMany({ where });
    await database.securityRepairRun.deleteMany({ where });
    await database.careArtifact.deleteMany({ where });
    await database.tenant.delete({ where: { id: tenantId } });
    await database.user.delete({ where: { id: actorId } });
  }
  await database.$disconnect();
});
async function fixture() {
  const now = new Date(); const tenant = await database.tenant.create({ data: { name: 'Controller PostgreSQL fixture', slug: `security-controller-${randomUUID()}` } });
  const actor = await database.user.create({ data: { email: `${randomUUID()}@example.test`, status: 'APPROVED', emailVerifiedAt: now, mfaEnabledAt: now } }); owned.push({ tenantId: tenant.id, actorId: actor.id });
  await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: actor.id, status: 'ACTIVE' } });
  const session = await database.session.create({ data: { tenantId: tenant.id, userId: actor.id, tokenHash: randomUUID(), expiresAt: new Date(now.getTime() + 3600000), mfaVerifiedAt: now } });
  const website = await database.website.create({ data: { tenantId: tenant.id, name: 'Disposable selected site', url: 'https://controller.example.test/', normalizedHost: 'controller.example.test' } });
  const scope: SecurityScope = { tenantId: tenant.id, websiteId: website.id, environment: 'STAGING', runId: randomUUID() };
  const steps: Partial<Record<SecurityWorkStep, SecurityControllerStep>> = {}; const calls: string[] = [], operations: string[] = [];
  for (const step of ['plan', 'snapshot', 'candidate', 'verify', 'proposal', 'apply', 'post_verify'] as const) steps[step] = {
    kind: step === 'plan' || step === 'candidate' ? 'MODEL' : step === 'apply' ? 'PRODUCTION_WRITE' : step === 'verify' ? 'SANDBOX' : 'READ', reserveMicros: step === 'plan' || step === 'candidate' ? 10 : 0, timeoutMs: 10000,
    implementationId: `pg-fixture.${step}`, implementationVersion: 'v1', implementationDigest: createHash('sha256').update(`synthetic-node-fixture:${step}`).digest('hex'),
    async readiness() { return { ready: true }; },
    async execute() {
      // Trusted synthetic node fixture only: this inserts a metadata receipt. It
      // does NOT invoke a model/sandbox, repair a website or prove artifact bytes.
      calls.push(step); const digest = createHash('sha256').update(`synthetic-receipt:${scope.runId}:${step}`).digest('hex');
      const artifact = await database.careArtifact.create({ data: { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, kind: 'REPORT', filename: `${step}-fixture.json`, contentType: 'application/json', status: 'ACCEPTED', digest, sizeBytes: 2, encryptedBody: 'synthetic-node-fixture-not-recovery-proof', createdBy: actor.id } });
      return { outcome: 'SUCCEEDED', artifact: { artifactId: artifact.id, digest }, costMicros: step === 'plan' || step === 'candidate' ? 2 : 0 };
    }
  };
  const options: SecurityControllerOptions = {
    database, scope, workerId: randomUUID(), artifactKey: Buffer.alloc(32, 23).toString('base64'), steps, heartbeatMs: 500, drainMs: 1500, runTimeoutMs: 20000,
    binding: { actorId: actor.id, sessionId: session.id, requestDigest: 'a'.repeat(64), authorityDigest: 'b'.repeat(64), implementationDigest: 'c'.repeat(64), allowanceMicros: 100, policy: 'security-workflow-v1' },
    async authorize(tx, requested, operation, run) {
      operations.push(operation);
      if (requested.tenantId !== tenant.id || requested.websiteId !== website.id || run && (run.actorId !== actor.id || run.sessionId !== session.id)) throw new SecurityWorkflowError('SECURITY_TEST_AUTHORITY_DENIED');
      await tx.$queryRaw`SELECT id FROM users WHERE id=${actor.id}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM sessions WHERE id=${session.id}::uuid FOR SHARE`;
      const [user, current, membership] = await Promise.all([tx.user.findUniqueOrThrow({ where: { id: actor.id } }), tx.session.findUniqueOrThrow({ where: { id: session.id } }), tx.tenantMembership.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: tenant.id, userId: actor.id } } })]);
      if (user.status !== 'APPROVED' || !user.mfaEnabledAt || membership.status !== 'ACTIVE' || current.revokedAt || current.expiresAt <= new Date() || !current.mfaVerifiedAt || current.mfaVerifiedAt.getTime() < Date.now() - 300000) throw new SecurityWorkflowError('SECURITY_TEST_AUTHORITY_DENIED');
    }
  };
  const controller = createSecurityRepairController(options);
  // Separate trusted admission, sharing the controller's bound authority. No API
  // route or flag activates this test fixture or bypasses production policy.
  const journal = createSecurityRepairJournal({ database, assertAuthority: controller.authorizeJournal });
  await journal.createRun({ ...controller.expectedCreateBinding, requestKey: randomUUID(), expiresAt: new Date(Date.now() + 60000) });
  async function decision(status: 'APPROVED' | 'DENIED') {
    const plan = await database.securityRepairAttempt.findFirstOrThrow({ where: { tenantId: scope.tenantId, websiteId: scope.websiteId, runId: scope.runId, stepKey: 'plan', state: 'SUCCEEDED' } });
    return journal.recordCandidateDecision(scope, { actorId: actor.id, sessionId: session.id, requestKey: randomUUID(), artifactId: plan.artifactId!, digest: plan.artifactDigest!, status });
  }
  return { scope, actorId: actor.id, sessionId: session.id, options, controller, journal, decision, steps, calls, operations };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe.sequential('dormant controller: real PostgreSQL journal/checkpoints, synthetic trusted node effects only', () => {
  it('persists encrypted interruption, releases immediately and resumes a fresh controller from a real saved candidate decision', async () => {
    const f = await fixture(); expect(await f.controller.run({ mode: 'start' })).toMatchObject({ disposition: 'WAITING', phase: 'AWAITING_APPROVAL', checkpointConfirmed: true, leaseReleased: true });
    expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ phase: 'AWAITING_APPROVAL', leaseOwnerId: null, reservedMicros: 0, chargedMicros: 2 });
    const saved = await database.securityGraphCheckpoint.findMany({ where: { tenantId: f.scope.tenantId, runId: f.scope.runId } }); expect(saved.length).toBeGreaterThan(1); expect(JSON.stringify(saved.map(row => row.encryptedEnvelope))).not.toContain('AWAITING_APPROVAL');
    const decisionId = await f.decision('APPROVED'); const restarted = createSecurityRepairController({ ...f.options, workerId: randomUUID() }); expect(await restarted.run({ mode: 'resume', decisionId })).toMatchObject({ disposition: 'WAITING', phase: 'AWAITING_APPROVAL', checkpointConfirmed: true, leaseReleased: true });
    expect(f.calls).toEqual(['plan', 'snapshot', 'candidate', 'verify', 'proposal']); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId, stepKey: 'plan' } })).toBe(1); expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'SETTLE' } })).toBe(5);
    expect((await restarted.run({ mode: 'resume', decisionId: randomUUID() })).code).toBe('UNREGISTERED_SECURITY_EXECUTOR'); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId, kind: { in: ['PRODUCTION_WRITE', 'RECOVERY_WRITE'] } } })).toBe(0);
  });
  it('checkpoints candidate denial before final business fencing and never starts snapshot/repair effects', async () => {
    const f = await fixture(); await f.controller.run({ mode: 'start' }); expect(await f.controller.run({ mode: 'resume', decisionId: await f.decision('DENIED') })).toMatchObject({ disposition: 'TERMINAL', phase: 'CANCELLED', checkpointConfirmed: true }); expect(f.calls).toEqual(['plan']);
    const [lastCheckpoint, terminal] = await Promise.all([database.securityGraphCheckpoint.findFirstOrThrow({ where: { runId: f.scope.runId }, orderBy: { createdAt: 'desc' } }), database.securityRepairOutbox.findFirstOrThrow({ where: { runId: f.scope.runId, phase: 'CANCELLED', eventType: 'run.transitioned' } })]); expect(lastCheckpoint.createdAt.getTime()).toBeLessThanOrEqual(terminal.createdAt.getTime());
  });
  it('finalizes an authenticated terminal cursor after a failed business fence using a fresh owner without replay', async () => {
    const f = await fixture(); let failTerminal = true;
    const controller = createSecurityRepairController({ ...f.options, journalFactory(authorize) {
      const journal = createSecurityRepairJournal({ database, assertAuthority: authorize });
      return { ...journal, async transition(...args: Parameters<typeof journal.transition>) {
        if (args[2] === 'CANCELLED' && failTerminal) { failTerminal = false; throw new SecurityWorkflowError('SECURITY_TEST_TERMINAL_FENCE_FAILED'); }
        return journal.transition(...args);
      } };
    } });
    await controller.run({ mode: 'start' });
    expect(await controller.run({ mode: 'resume', decisionId: await f.decision('DENIED') })).toMatchObject({ disposition: 'UNCONFIRMED', phase: 'AWAITING_APPROVAL', checkpointConfirmed: true });
    const before = await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } });
    expect(before).toMatchObject({ phase: 'AWAITING_APPROVAL', reservedMicros: 0, chargedMicros: 2 });
    const checkpoints = await database.securityGraphCheckpoint.count({ where: { runId: f.scope.runId } });
    // Disposable fixture-only lease expiry models the dead owner's crash window.
    await database.securityRepairRun.update({ where: { id: f.scope.runId }, data: { leaseExpiresAt: new Date(0) } });
    expect(await createSecurityRepairController({ ...f.options, workerId: randomUUID() }).run({ mode: 'continueAfterRestart' })).toMatchObject({ disposition: 'TERMINAL', phase: 'CANCELLED', checkpointConfirmed: true, leaseReleased: true });
    expect(f.calls).toEqual(['plan']);
    expect(await database.securityGraphCheckpoint.count({ where: { runId: f.scope.runId } })).toBe(checkpoints);
    expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(1);
    expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'SETTLE' } })).toBe(1);
    expect(await database.securityRepairOutbox.count({ where: { runId: f.scope.runId, phase: 'CANCELLED', eventType: 'run.transitioned' } })).toBe(1);
    expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ phase: 'CANCELLED', reservedMicros: 0, chargedMicros: 2, leaseOwnerId: null });
  });
  it('does not create a STARTED attempt/reservation when the real transaction readiness check says unavailable', async () => {
    const f = await fixture(); let ready = false; f.steps.plan!.readiness = async () => ready ? { ready: true } : { ready: false, code: 'SECURITY_TEST_RUNTIME_UNAVAILABLE' }; const controller = createSecurityRepairController(f.options); expect(await controller.run({ mode: 'start' })).toMatchObject({ disposition: 'BLOCKED', phase: 'WAITING_FOR_INPUT', code: 'SECURITY_TEST_RUNTIME_UNAVAILABLE' }); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(0); expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId } })).toBe(0); expect(f.calls).toEqual([]);
    ready = true; expect(await createSecurityRepairController({ ...f.options, workerId: randomUUID() }).run({ mode: 'recheckPrerequisites' })).toMatchObject({ disposition: 'WAITING', phase: 'AWAITING_APPROVAL', code: null, checkpointConfirmed: true, leaseReleased: true }); expect(f.calls).toEqual(['plan']); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(1);
  });
  it('rechecks only the persisted blocked snapshot after approval, without repeating the settled plan', async () => {
    const f = await fixture(); let ready = false; f.steps.snapshot!.readiness = async () => ready ? { ready: true } : { ready: false, code: 'SECURITY_TEST_SNAPSHOT_UNAVAILABLE' }; const controller = createSecurityRepairController(f.options); await controller.run({ mode: 'start' });
    expect(await controller.run({ mode: 'recheckPrerequisites' })).toMatchObject({ disposition: 'BLOCKED', phase: 'AWAITING_APPROVAL', code: 'SECURITY_READINESS_NOT_RESUMABLE' });
    expect(await controller.run({ mode: 'resume', decisionId: await f.decision('APPROVED') })).toMatchObject({ disposition: 'BLOCKED', phase: 'WAITING_FOR_INPUT', code: 'SECURITY_TEST_SNAPSHOT_UNAVAILABLE' }); expect(f.calls).toEqual(['plan']);
    ready = true; expect(await createSecurityRepairController({ ...f.options, workerId: randomUUID() }).run({ mode: 'recheckPrerequisites' })).toMatchObject({ disposition: 'WAITING', phase: 'AWAITING_APPROVAL', code: null }); expect(f.calls).toEqual(['plan', 'snapshot', 'candidate', 'verify', 'proposal']); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId, stepKey: 'plan' } })).toBe(1); expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'SETTLE' } })).toBe(5);
  });
  it('persists proposal readiness as waiting and explicitly resumes only that proposal after it becomes ready', async () => {
    const f = await fixture(); let ready = false; f.steps.proposal!.readiness = async () => ready ? { ready: true } : { ready: false, code: 'SECURITY_TEST_PROPOSAL_UNAVAILABLE' }; const controller = createSecurityRepairController(f.options); await controller.run({ mode: 'start' });
    expect(await controller.run({ mode: 'resume', decisionId: await f.decision('APPROVED') })).toMatchObject({ disposition: 'BLOCKED', phase: 'WAITING_FOR_INPUT', code: 'SECURITY_TEST_PROPOSAL_UNAVAILABLE', checkpointConfirmed: true, leaseReleased: true }); expect(f.calls).toEqual(['plan', 'snapshot', 'candidate', 'verify']); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(4);
    ready = true; expect(await createSecurityRepairController({ ...f.options, workerId: randomUUID() }).run({ mode: 'recheckPrerequisites' })).toMatchObject({ disposition: 'WAITING', phase: 'AWAITING_APPROVAL', code: null }); expect(f.calls).toEqual(['plan', 'snapshot', 'candidate', 'verify', 'proposal']); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(5); expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'SETTLE' } })).toBe(5);
  });
  it('rejects an expired saved candidate approval on readiness recheck before reserving or executing another effect', async () => {
    const f = await fixture(); let ready = false; f.steps.snapshot!.readiness = async () => ready ? { ready: true } : { ready: false, code: 'SECURITY_TEST_SNAPSHOT_UNAVAILABLE' }; const controller = createSecurityRepairController(f.options); await controller.run({ mode: 'start' }); const decisionId = await f.decision('APPROVED'); expect(await controller.run({ mode: 'resume', decisionId })).toMatchObject({ disposition: 'BLOCKED', phase: 'WAITING_FOR_INPUT' });
    // Disposable fixture-only clock travel. Keep the database expiry constraint
    // intact; no production approval or historical record is changed.
    const now = Date.now(); await database.securityRepairDecision.update({ where: { id: decisionId }, data: { createdAt: new Date(now - 2000), expiresAt: new Date(now - 1000) } }); ready = true;
    const restarted = createSecurityRepairController({ ...f.options, workerId: randomUUID() }); expect(await restarted.run({ mode: 'recheckPrerequisites' })).toMatchObject({ disposition: 'BLOCKED', phase: 'WAITING_FOR_INPUT', code: 'SECURITY_DECISION_EXPIRED', checkpointConfirmed: true, leaseReleased: true }); expect(f.calls).toEqual(['plan']); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(1); expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'SETTLE' } })).toBe(1); expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ phase: 'WAITING_FOR_INPUT', reservedMicros: 0, chargedMicros: 2, leaseOwnerId: null }); expect(await database.securityRepairDecision.findUniqueOrThrow({ where: { id: decisionId } })).toMatchObject({ status: 'APPROVED' });
    expect(await restarted.stop()).toMatchObject({ recorded: true, phase: 'CANCELLED', effectsUndone: false }); expect(f.calls).toEqual(['plan']);
  });
  it('rechecks persisted candidate expiry at journal admission if it expires after graph preflight and readiness starts', async () => {
    const f = await fixture(); let decisionId: string; f.steps.snapshot!.readiness = async ({ tx }) => {
      // Isolated fixture-only clock travel between preflight and admission. No
      // model/runtime work is performed in this short database transaction.
      const now = Date.now(); await tx.securityRepairDecision.update({ where: { id: decisionId }, data: { createdAt: new Date(now - 2000), expiresAt: new Date(now - 1000) } }); return { ready: true };
    };
    const controller = createSecurityRepairController(f.options); await controller.run({ mode: 'start' }); decisionId = await f.decision('APPROVED'); expect(await controller.run({ mode: 'resume', decisionId })).toMatchObject({ disposition: 'BLOCKED', phase: 'SNAPSHOTTING', code: 'SECURITY_DECISION_EXPIRED', checkpointConfirmed: true, leaseReleased: true }); expect(f.calls).toEqual(['plan']); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(1); expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'RESERVE' } })).toBe(1); expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ phase: 'SNAPSHOTTING', reservedMicros: 0, chargedMicros: 2, leaseOwnerId: null });
  });
  it('independently rejects every named pre-production effect without a current persisted candidate approval', async () => {
    const f = await fixture(); await f.controller.run({ mode: 'start' }); let fence = await f.journal.claimRun(f.scope, randomUUID());
    for (const step of ['snapshot', 'candidate', 'verify', 'proposal'] as const) await expect(f.journal.beginStep(f.scope, fence, { stepKey: step, kind: f.steps[step]!.kind, reserveMicros: f.steps[step]!.reserveMicros, inputDigest: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'SECURITY_DECISION_BINDING_CHANGED' });
    await f.journal.releaseLease(f.scope, fence); const decisionId = await f.decision('APPROVED'); fence = await f.journal.claimRun(f.scope, randomUUID());
    const now = Date.now(); await database.securityRepairDecision.update({ where: { id: decisionId }, data: { createdAt: new Date(now - 2000), expiresAt: new Date(now - 1000) } });
    for (const step of ['snapshot', 'candidate', 'verify', 'proposal'] as const) await expect(f.journal.beginStep(f.scope, fence, { stepKey: step, kind: f.steps[step]!.kind, reserveMicros: f.steps[step]!.reserveMicros, inputDigest: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'SECURITY_DECISION_EXPIRED' });
    expect(f.calls).toEqual(['plan']); expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(1); expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'RESERVE' } })).toBe(1); await f.journal.releaseLease(f.scope, fence);
  });
  it('preserves a real STARTED row/reservation as unknown when a synthetic node throws, and blocks another controller owner', async () => {
    const f = await fixture(); f.steps.plan!.execute = async () => { f.calls.push('plan'); throw new Error('Synthetic private source must not be exposed'); }; const controller = createSecurityRepairController(f.options); const outcome = await controller.run({ mode: 'start' }); expect(outcome).toMatchObject({ disposition: 'UNCONFIRMED', phase: 'OUTCOME_UNKNOWN', code: 'SECURITY_EFFECT_UNRESOLVED' }); expect(JSON.stringify(outcome)).not.toContain('Synthetic private');
    expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ phase: 'OUTCOME_UNKNOWN', reservedMicros: 10, chargedMicros: 0, leaseOwnerId: null }); expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'UNKNOWN' } })).toBe(1); expect((await createSecurityRepairController({ ...f.options, workerId: randomUUID() }).run({ mode: 'continueAfterRestart' })).code).toBe('SECURITY_RUN_NOT_ACTIVE'); expect(f.calls).toEqual(['plan']);
  });
  it('keeps durably known overrun cost and FAILED fence rather than overwriting with an unknown outcome', async () => {
    const f = await fixture(); const original = f.steps.plan!.execute; f.steps.plan!.execute = async input => { const receipt = await original(input); return receipt.outcome === 'SUCCEEDED' ? { ...receipt, costMicros: 20 } : receipt; }; const outcome = await createSecurityRepairController(f.options).run({ mode: 'start' }); expect(outcome).toMatchObject({ phase: 'FAILED', code: 'SECURITY_BUDGET_EXCEEDED' }); expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ phase: 'FAILED', reservedMicros: 0, chargedMicros: 20, leaseOwnerId: null }); expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'UNKNOWN' } })).toBe(0);
  });
  it('fences an in-flight node immediately on stop, bounds drain and retains unknown work without replay or undo claims', async () => {
    const f = await fixture(); const started = deferred<void>(), pending = deferred<Awaited<ReturnType<SecurityControllerStep['execute']>>>(); let signal: AbortSignal | undefined;
    f.steps.plan!.execute = async input => { signal = input.signal; started.resolve(); return pending.promise; }; const controller = createSecurityRepairController(f.options); const work = controller.run({ mode: 'start' }); await started.promise; const stopped = await controller.stop(); expect(stopped).toMatchObject({ phase: 'OUTCOME_UNKNOWN', recorded: true, drained: false, effectsUndone: false }); expect(signal?.aborted).toBe(true); expect(controller.running).toBe(true); expect((await work).disposition).toBe('STOPPED');
    // Release the ignored synthetic handler without calling the original effect.
    pending.resolve({ outcome: 'BLOCKED', code: 'SECURITY_TEST_CANCELLED_NODE' }); await expect.poll(() => controller.running).toBe(false); expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ phase: 'OUTCOME_UNKNOWN', reservedMicros: 10, chargedMicros: 0 }); expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'SETTLE' } })).toBe(0);
  });
  it('rechecks current actor/session and provenance before resume instead of trusting a checkpoint or saved decision ID', async () => {
    const f = await fixture(); await f.controller.run({ mode: 'start' }); const decisionId = await f.decision('APPROVED'); await database.session.update({ where: { id: f.sessionId }, data: { revokedAt: new Date() } }); expect((await createSecurityRepairController(f.options).run({ mode: 'resume', decisionId })).code).toBe('SECURITY_TEST_AUTHORITY_DENIED'); expect(f.calls).toEqual(['plan']);
    const other = await fixture(); await other.controller.run({ mode: 'start' }); const drifted = createSecurityRepairController({ ...other.options, binding: { ...other.options.binding, implementationDigest: 'f'.repeat(64) } }); expect((await drifted.run({ mode: 'resume', decisionId: await other.decision('APPROVED') })).code).toBe('SECURITY_CONTROLLER_BINDING_CHANGED'); expect(other.calls).toEqual(['plan']);
  });
});
