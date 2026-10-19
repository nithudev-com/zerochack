import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, SecurityRepairRun } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { SecurityWorkflowError, type ArtifactReceipt, type EncryptedCheckpoint, type EncryptedWrite, type SecurityCheckpointStorage, type SecurityPhase, type SecurityScope, type SecurityWorkStep } from '@zerochack/security-orchestration';
import { createSecurityRepairController, securityControllerManifest, type SecurityControllerOptions, type SecurityControllerStep } from './controller.js';
import type { SecurityLeaseFence } from './journal.js';

/** Real LangGraph + encryption/checkpointer, but an in-memory journal/DB protocol
 * fixture. These tests are NOT PostgreSQL, provider, sandbox or live-repair proof. */
function fixture() {
  const scope: SecurityScope = { tenantId: randomUUID(), websiteId: randomUUID(), environment: 'STAGING', runId: randomUUID() };
  const actorId = randomUUID(), sessionId = randomUUID(); const events: string[] = [], executions: string[] = [], operations: string[] = [];
  const checkpoints = new Map<string, EncryptedCheckpoint>(), writes = new Map<string, EncryptedWrite>();
  const attempts = new Map<string, { id: string; stepKey: string; inputDigest: string; reserveMicros: number; state: 'STARTED' | 'SUCCEEDED'; artifact?: ArtifactReceipt; costMicros?: number }>();
  const decisions = new Map<string, { status: 'APPROVED' | 'DENIED'; expiresAt: number }>();
  let allowed = true, heartbeatFails = false, failCursorOnce = false;
  const row = { id: scope.runId, tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, actorId, sessionId, inputDigest: '', authorityDigest: 'b'.repeat(64), allowanceMicros: 100, phase: 'PLANNING', reservedMicros: 0, chargedMicros: 0, leaseOwnerId: null, leaseExpiresAt: null, leaseVersion: 0, expiresAt: new Date(Date.now() + 3600000) } as unknown as SecurityRepairRun;
  const tx = { $queryRaw: async () => [], securityRepairRun: { findFirst: async () => row } } as unknown as Prisma.TransactionClient;
  const steps: Partial<Record<SecurityWorkStep, SecurityControllerStep>> = {};
  for (const step of ['plan', 'snapshot', 'candidate', 'verify', 'proposal', 'apply', 'post_verify'] as const) steps[step] = {
    kind: step === 'plan' || step === 'candidate' ? 'MODEL' : step === 'apply' ? 'PRODUCTION_WRITE' : step === 'verify' ? 'SANDBOX' : 'READ',
    reserveMicros: step === 'plan' || step === 'candidate' ? 10 : 0, timeoutMs: 1000,
    implementationId: `unit-fixture.${step}`, implementationVersion: 'v1', implementationDigest: 'c'.repeat(64),
    async readiness() { return { ready: true }; },
    async execute() { executions.push(step); return { outcome: 'SUCCEEDED', artifact: { artifactId: randomUUID(), digest: 'a'.repeat(64) }, costMicros: step === 'plan' || step === 'candidate' ? 2 : 0 }; }
  };
  let journal: ReturnType<NonNullable<SecurityControllerOptions['journalFactory']>>;
  const options: SecurityControllerOptions = {
    database: {} as PrismaClient, scope, workerId: randomUUID(), artifactKey: Buffer.alloc(32, 19).toString('base64'),
    binding: { actorId, sessionId, requestDigest: 'd'.repeat(64), authorityDigest: row.authorityDigest, implementationDigest: 'e'.repeat(64), allowanceMicros: 100, policy: 'security-workflow-v1' }, steps, drainMs: 20, heartbeatMs: 250, runTimeoutMs: 3000,
    async authorize(_tx, actual, operation) { operations.push(operation); if (!allowed || actual.websiteId !== scope.websiteId) throw new SecurityWorkflowError('SECURITY_TEST_AUTHORITY_REVOKED'); },
    journalFactory(authorize) {
      const before = async (operation: Parameters<typeof authorize>[2]) => { operations.push(`journal:${operation}`); await authorize(tx, scope, operation); };
      const held = (fence: SecurityLeaseFence) => { if (row.leaseOwnerId !== fence.ownerId || row.leaseVersion !== fence.version || !row.leaseExpiresAt || row.leaseExpiresAt <= new Date()) throw new SecurityWorkflowError('SECURITY_LEASE_LOST'); };
      const unfinished = () => [...attempts.values()].filter(value => value.state !== 'SUCCEEDED').length;
      journal = {
        async claimRun(_scope: SecurityScope, ownerId: string) { await before('CLAIM'); if (['CANCELLED', 'COMPLETED', 'FAILED', 'OUTCOME_UNKNOWN'].includes(row.phase)) throw new SecurityWorkflowError('SECURITY_RUN_NOT_ACTIVE'); if (unfinished()) throw new SecurityWorkflowError('SECURITY_EFFECT_UNRESOLVED'); if (row.leaseExpiresAt && row.leaseExpiresAt > new Date()) throw new SecurityWorkflowError('SECURITY_LEASE_BUSY'); row.leaseOwnerId = ownerId; row.leaseVersion++; row.leaseExpiresAt = new Date(Date.now() + 30000); return { ownerId, version: row.leaseVersion, expiresAt: row.leaseExpiresAt }; },
        async heartbeat(_scope: SecurityScope, fence: SecurityLeaseFence) { await before('HEARTBEAT'); held(fence); if (heartbeatFails) throw new SecurityWorkflowError('SECURITY_TEST_HEARTBEAT_FAILED'); row.leaseExpiresAt = new Date(Date.now() + 30000); return { ...fence, expiresAt: row.leaseExpiresAt }; },
        async transition(_scope: SecurityScope, fence: SecurityLeaseFence, phase: SecurityPhase) { await before('TRANSITION'); held(fence); if (phase === 'APPLYING' || phase === 'POST_VERIFYING') throw new SecurityWorkflowError('UNREGISTERED_SECURITY_EXECUTOR'); if (unfinished() && phase !== 'OUTCOME_UNKNOWN') throw new SecurityWorkflowError('SECURITY_EFFECT_UNRESOLVED'); row.phase = phase; events.push(`transition:${phase}`); if (['CANCELLED', 'COMPLETED', 'FAILED', 'OUTCOME_UNKNOWN'].includes(phase)) { row.leaseOwnerId = null; row.leaseExpiresAt = null; row.leaseVersion++; } return row; },
        async beginStep(_scope: SecurityScope, fence: SecurityLeaseFence, input: { stepKey: string; kind: string; inputDigest: string; reserveMicros: number }) { await before('BEGIN_STEP'); held(fence); if (input.kind === 'PRODUCTION_WRITE' || input.kind === 'RECOVERY_WRITE') throw new SecurityWorkflowError('UNREGISTERED_SECURITY_EXECUTOR'); const previous = attempts.get(input.stepKey); if (previous) { if (previous.inputDigest !== input.inputDigest) throw new SecurityWorkflowError('SECURITY_STEP_BINDING_CHANGED'); if (previous.state !== 'SUCCEEDED') throw new SecurityWorkflowError('SECURITY_EFFECT_UNRESOLVED'); return { outcome: 'SUCCEEDED' as const, artifact: previous.artifact!, costMicros: previous.costMicros! }; } const attempt = { id: randomUUID(), stepKey: input.stepKey, inputDigest: input.inputDigest, reserveMicros: input.reserveMicros, state: 'STARTED' as const }; attempts.set(input.stepKey, attempt); row.reservedMicros += input.reserveMicros; events.push(`begin:${input.stepKey}`); return { outcome: 'STARTED' as const, attemptId: attempt.id }; },
        async completeStep(_scope: SecurityScope, fence: SecurityLeaseFence, id: string, receipt: ArtifactReceipt & { costMicros: number }) { await before('COMPLETE_STEP'); held(fence); const attempt = [...attempts.values()].find(value => value.id === id)!; attempt.state = 'SUCCEEDED'; attempt.artifact = { artifactId: receipt.artifactId, digest: receipt.digest }; attempt.costMicros = receipt.costMicros; row.reservedMicros -= attempt.reserveMicros; row.chargedMicros += receipt.costMicros; events.push(`complete:${attempt.stepKey}`); if (receipt.costMicros > attempt.reserveMicros) { row.phase = 'FAILED'; row.leaseOwnerId = null; row.leaseExpiresAt = null; row.leaseVersion++; throw new SecurityWorkflowError('SECURITY_BUDGET_EXCEEDED'); } return attempt; },
        async releaseLease(_scope: SecurityScope, fence: SecurityLeaseFence) { await before('RELEASE'); held(fence); if (unfinished()) throw new SecurityWorkflowError('SECURITY_EFFECT_UNRESOLVED'); row.leaseOwnerId = null; row.leaseExpiresAt = null; row.leaseVersion++; events.push('release'); return row; },
        async recoverExpired() { await before('OBSERVE'); return { phase: row.phase, expiredLease: !!row.leaseExpiresAt && row.leaseExpiresAt <= new Date(), authorityExpired: false, unfinishedAttempts: unfinished(), reservedMicros: row.reservedMicros, chargedMicros: row.chargedMicros, replayAllowed: false as const }; },
        async stopRun() { await before('STOP'); if (!['COMPLETED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN'].includes(row.phase)) row.phase = unfinished() ? 'OUTCOME_UNKNOWN' : 'CANCELLED'; row.leaseOwnerId = null; row.leaseExpiresAt = null; row.leaseVersion++; events.push('stop'); return row; },
        async resolveCandidateDecision(_scope: SecurityScope, fence: SecurityLeaseFence, id: string) { await before('DECIDE'); held(fence); const saved = decisions.get(id); if (!saved) throw new SecurityWorkflowError('SECURITY_DECISION_INVALID'); if (saved.expiresAt <= Date.now()) throw new SecurityWorkflowError('SECURITY_DECISION_EXPIRED'); return saved.status; }
      } as unknown as typeof journal;
      return journal;
    },
    checkpointStorageFactory(fence, authorize) {
      const check = async () => { await authorize(tx, row); if (row.leaseOwnerId !== fence.ownerId || row.leaseVersion !== fence.version || !row.leaseExpiresAt || row.leaseExpiresAt <= new Date()) throw new SecurityWorkflowError('SECURITY_LEASE_LOST'); };
      const storage: SecurityCheckpointStorage = {
        assertLease: check,
        async checkpoint(_actual, id) { await check(); return id ? checkpoints.get(id) : [...checkpoints.values()].sort((a, b) => b.checkpointId.localeCompare(a.checkpointId))[0]; },
        async checkpoints(_actual, limit, before) { await check(); return [...checkpoints.values()].filter(value => !before || value.checkpointId < before).sort((a, b) => b.checkpointId.localeCompare(a.checkpointId)).slice(0, limit); },
        async putCheckpoint(_actual, value) { await check(); checkpoints.set(value.checkpointId, value); events.push('checkpoint'); },
        async writes(_actual, id) { await check(); return [...writes.entries()].filter(([key]) => key.startsWith(`${id}:`)).map(([, value]) => value); },
        async putWrite(_actual, id, value) { await check(); if (failCursorOnce && [...attempts.values()].some(attempt => attempt.state === 'SUCCEEDED')) { failCursorOnce = false; throw new SecurityWorkflowError('SECURITY_TEST_CHECKPOINT_FAILED'); } writes.set(`${id}:${value.taskId}:${value.index}`, value); }
      };
      return storage;
    }
  };
  const build = (overrides: Partial<SecurityControllerOptions> = {}) => { const controller = createSecurityRepairController({ ...options, ...overrides }); if (!row.inputDigest) row.inputDigest = controller.inputDigest; return controller; };
  return { options, scope, row, attempts, events, executions, operations, steps, checkpoints, build, get journal() { return journal; }, decision(status: 'APPROVED' | 'DENIED') { const id = randomUUID(); decisions.set(id, { status, expiresAt: Date.now() + 60000 }); return id; }, expireDecision(id: string) { decisions.get(id)!.expiresAt = Date.now() - 1; }, revoke() { allowed = false; }, failHeartbeat() { heartbeatFails = true; }, failNextCursorAfterReceipt() { failCursorOnce = true; }, expireLease() { row.leaseExpiresAt = new Date(0); } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const result = () => ({ outcome: 'SUCCEEDED' as const, artifact: { artifactId: randomUUID(), digest: 'a'.repeat(64) }, costMicros: 2 });

describe('internal controller with real LangGraph and in-memory journal/DB protocol fixtures only', () => {
  it('binds scope, policy, allowance, implementation identity/version/hash and limits before admission', () => {
    const f = fixture(); const original = securityControllerManifest(f.options); expect(original.expectedCreateBinding.inputDigest).toBe(original.inputDigest);
    for (const changed of [{ binding: { ...f.options.binding, implementationDigest: 'f'.repeat(64) } }, { binding: { ...f.options.binding, allowanceMicros: 99 } }, { steps: { ...f.steps, plan: { ...f.steps.plan!, implementationVersion: 'v2' } } }, { steps: { ...f.steps, plan: { ...f.steps.plan!, timeoutMs: 2000 } } }]) expect(securityControllerManifest({ ...f.options, ...changed }).inputDigest === original.inputDigest).toBe(false);
    expect(() => createSecurityRepairController({ ...f.options, authorize: undefined } as unknown as SecurityControllerOptions)).toThrow('SECURITY_AUTHORITY_REQUIRED'); expect(() => f.build({ artifactKey: 'not-a-key' })).toThrow('SECURITY_CHECKPOINT_KEY_REQUIRED');
  });
  it('starts, checkpoints an actual interrupt, releases lease and resumes without repeating plan or spending twice', async () => {
    const f = fixture(), controller = f.build(); expect(await controller.run({ mode: 'start' })).toMatchObject({ disposition: 'WAITING', phase: 'AWAITING_APPROVAL', checkpointConfirmed: true, leaseReleased: true });
    expect(f.executions).toEqual(['plan']); expect(f.row.chargedMicros).toBe(2); expect(f.events.at(-1)).toBe('release'); expect(f.checkpoints.size).toBeGreaterThan(1);
    const resumed = f.build({ workerId: randomUUID() }); expect(await resumed.run({ mode: 'resume', decisionId: f.decision('APPROVED') })).toMatchObject({ disposition: 'WAITING', phase: 'AWAITING_APPROVAL', checkpointConfirmed: true, leaseReleased: true }); expect(f.executions).toEqual(['plan', 'snapshot', 'candidate', 'verify', 'proposal']); expect(f.executions.includes('apply')).toBe(false);
    const unsupported = await resumed.run({ mode: 'resume', decisionId: randomUUID() }); expect(unsupported).toMatchObject({ disposition: 'BLOCKED', phase: 'AWAITING_APPROVAL', code: 'UNREGISTERED_SECURITY_EXECUTOR', checkpointConfirmed: true, leaseReleased: true }); expect(f.executions.includes('apply')).toBe(false);
  });
  it('persists normal terminal denial intent before the business journal terminal fence', async () => {
    const f = fixture(), controller = f.build(); await controller.run({ mode: 'start' }); const denied = await controller.run({ mode: 'resume', decisionId: f.decision('DENIED') }); expect(denied).toMatchObject({ disposition: 'TERMINAL', phase: 'CANCELLED', checkpointConfirmed: true }); expect(f.executions).toEqual(['plan']); expect(f.events.lastIndexOf('checkpoint')).toBeLessThan(f.events.lastIndexOf('transition:CANCELLED'));
  });
  it('finalizes a saved denial after the business fence fails without replaying a graph node', async () => {
    const f = fixture(); let failTerminal = true;
    const controller = f.build({ journalFactory(authorize) {
      const journal = f.options.journalFactory!(authorize);
      return { ...journal, async transition(...args: Parameters<typeof journal.transition>) {
        if (args[2] === 'CANCELLED' && failTerminal) { failTerminal = false; throw new SecurityWorkflowError('SECURITY_TEST_TERMINAL_FENCE_FAILED'); }
        return journal.transition(...args);
      } };
    } });
    await controller.run({ mode: 'start' });
    expect(await controller.run({ mode: 'resume', decisionId: f.decision('DENIED') })).toMatchObject({ disposition: 'UNCONFIRMED', phase: 'AWAITING_APPROVAL', checkpointConfirmed: true });
    expect(f.row.phase).toBe('AWAITING_APPROVAL'); expect(f.executions).toEqual(['plan']); f.expireLease();
    const checkpoints = f.checkpoints.size;
    expect(await f.build({ workerId: randomUUID() }).run({ mode: 'continueAfterRestart' })).toMatchObject({ disposition: 'TERMINAL', phase: 'CANCELLED', checkpointConfirmed: true, leaseReleased: true });
    expect(f.row.phase).toBe('CANCELLED'); expect(f.executions).toEqual(['plan']); expect(f.checkpoints.size).toBe(checkpoints);
    expect(f.attempts.size).toBe(1); expect(f.row.reservedMicros).toBe(0); expect(f.row.chargedMicros).toBe(2);
    expect(f.events.filter(event => event === 'transition:CANCELLED')).toHaveLength(1);
  });
  it('checks readiness before any STARTED/reservation and blocks unavailable capabilities honestly', async () => {
    const f = fixture(); let ready = false; f.steps.plan!.readiness = async () => ready ? { ready: true } : { ready: false, code: 'SECURITY_PROVIDER_UNAVAILABLE' }; const controller = f.build(); expect(await controller.run({ mode: 'start' })).toMatchObject({ disposition: 'BLOCKED', phase: 'WAITING_FOR_INPUT', code: 'SECURITY_PROVIDER_UNAVAILABLE', checkpointConfirmed: true }); expect(f.attempts.size).toBe(0); expect(f.row.reservedMicros).toBe(0); expect(f.executions).toEqual([]); expect(f.operations.includes('READINESS')).toBe(true);
    expect(await controller.run({ mode: 'continueAfterRestart' })).toMatchObject({ disposition: 'BLOCKED', code: 'SECURITY_WORKFLOW_NOT_RESUMABLE' }); expect(f.executions).toEqual([]);
    ready = true; expect(await f.build({ workerId: randomUUID() }).run({ mode: 'recheckPrerequisites' })).toMatchObject({ disposition: 'WAITING', phase: 'AWAITING_APPROVAL', code: null, checkpointConfirmed: true, leaseReleased: true }); expect(f.executions).toEqual(['plan']);
  });
  it('rechecks only the saved blocked pre-production step without replaying plan or bypassing approval', async () => {
    const f = fixture(); let ready = false; f.steps.snapshot!.readiness = async () => ready ? { ready: true } : { ready: false, code: 'SECURITY_SNAPSHOT_UNAVAILABLE' }; const controller = f.build(); await controller.run({ mode: 'start' });
    expect(await controller.run({ mode: 'recheckPrerequisites' })).toMatchObject({ disposition: 'BLOCKED', phase: 'AWAITING_APPROVAL', code: 'SECURITY_READINESS_NOT_RESUMABLE' }); expect(f.executions).toEqual(['plan']);
    expect(await controller.run({ mode: 'resume', decisionId: f.decision('APPROVED') })).toMatchObject({ disposition: 'BLOCKED', phase: 'WAITING_FOR_INPUT', code: 'SECURITY_SNAPSHOT_UNAVAILABLE' }); expect(f.executions).toEqual(['plan']);
    ready = true; expect(await f.build({ workerId: randomUUID() }).run({ mode: 'recheckPrerequisites' })).toMatchObject({ disposition: 'WAITING', phase: 'AWAITING_APPROVAL', code: null }); expect(f.executions).toEqual(['plan', 'snapshot', 'candidate', 'verify', 'proposal']); expect(f.attempts.size).toBe(5); expect(f.row.chargedMicros).toBe(4);
  });
  it('persists unavailable proposal readiness and rechecks proposal only, not earlier settled work', async () => {
    const f = fixture(); let ready = false; f.steps.proposal!.readiness = async () => ready ? { ready: true } : { ready: false, code: 'SECURITY_PROPOSAL_UNAVAILABLE' }; const controller = f.build(); await controller.run({ mode: 'start' });
    expect(await controller.run({ mode: 'resume', decisionId: f.decision('APPROVED') })).toMatchObject({ disposition: 'BLOCKED', phase: 'WAITING_FOR_INPUT', code: 'SECURITY_PROPOSAL_UNAVAILABLE', checkpointConfirmed: true, leaseReleased: true }); expect(f.executions).toEqual(['plan', 'snapshot', 'candidate', 'verify']); expect(f.attempts.size).toBe(4);
    ready = true; expect(await f.build({ workerId: randomUUID() }).run({ mode: 'recheckPrerequisites' })).toMatchObject({ disposition: 'WAITING', phase: 'AWAITING_APPROVAL', code: null }); expect(f.executions).toEqual(['plan', 'snapshot', 'candidate', 'verify', 'proposal']); expect(f.attempts.size).toBe(5); expect(f.row.chargedMicros).toBe(4);
  });
  it('rechecks candidate decision expiry before a blocked prerequisite can resume an effect', async () => {
    const f = fixture(); let ready = false; f.steps.snapshot!.readiness = async () => ready ? { ready: true } : { ready: false, code: 'SECURITY_SNAPSHOT_UNAVAILABLE' }; const controller = f.build(); await controller.run({ mode: 'start' }); const decisionId = f.decision('APPROVED'); await controller.run({ mode: 'resume', decisionId });
    f.expireDecision(decisionId); ready = true; expect(await f.build({ workerId: randomUUID() }).run({ mode: 'recheckPrerequisites' })).toMatchObject({ disposition: 'BLOCKED', phase: 'WAITING_FOR_INPUT', code: 'SECURITY_DECISION_EXPIRED', checkpointConfirmed: true, leaseReleased: true }); expect(f.executions).toEqual(['plan']); expect(f.attempts.size).toBe(1); expect(f.row.chargedMicros).toBe(2); expect(f.events).not.toContain('transition:FAILED');
  });
  it('turns BLOCKED after STARTED into unknown retained cost, not a no-effect block or replay', async () => {
    const f = fixture(); f.steps.plan!.execute = async () => ({ outcome: 'BLOCKED', code: 'SECURITY_PROVIDER_UNAVAILABLE' }); const controller = f.build(); expect(await controller.run({ mode: 'start' })).toMatchObject({ disposition: 'UNCONFIRMED', phase: 'OUTCOME_UNKNOWN', code: 'SECURITY_EFFECT_UNRESOLVED' }); expect(f.row.reservedMicros).toBe(10); expect([...f.attempts.values()][0]!.state).toBe('STARTED'); expect((await f.build().run({ mode: 'continueAfterRestart' })).code).toBe('SECURITY_RUN_NOT_ACTIVE');
  });
  it('recovers after an acknowledged effect but failed cursor write using the journal receipt, not a second execution', async () => {
    const f = fixture(); f.failNextCursorAfterReceipt(); const controller = f.build(); expect((await controller.run({ mode: 'start' })).disposition).toBe('UNCONFIRMED'); expect(f.executions).toEqual(['plan']); f.expireLease(); const restarted = f.build({ workerId: randomUUID() }); expect(await restarted.run({ mode: 'continueAfterRestart' })).toMatchObject({ disposition: 'WAITING', phase: 'AWAITING_APPROVAL' }); expect(f.executions).toEqual(['plan']); expect(f.row.chargedMicros).toBe(2);
  });
  it('does not overwrite a durably settled overrun FAILED state with unknown or release the known cost', async () => {
    const f = fixture(); f.steps.plan!.execute = async () => ({ ...result(), costMicros: 20 }); const controller = f.build(); expect(await controller.run({ mode: 'start' })).toMatchObject({ phase: 'FAILED', code: 'SECURITY_BUDGET_EXCEEDED' }); expect(f.row.chargedMicros).toBe(20); expect(f.row.reservedMicros).toBe(0); expect(f.events.includes('transition:OUTCOME_UNKNOWN')).toBe(false);
  });
  it('stores a deterministic contract failure with no unfinished effect as FAILED, but leaves unknown infrastructure failure unconfirmed', async () => {
    const known = fixture(); known.steps.plan!.readiness = async () => { throw new SecurityWorkflowError('SECURITY_STEP_BINDING_CHANGED'); }; expect(await known.build().run({ mode: 'start' })).toMatchObject({ disposition: 'TERMINAL', phase: 'FAILED', code: 'SECURITY_STEP_BINDING_CHANGED', checkpointConfirmed: false }); expect(known.attempts.size).toBe(0); expect(known.events).toContain('transition:FAILED');
    const unknown = fixture(); unknown.steps.plan!.readiness = async () => { throw new Error('Synthetic private infrastructure detail'); }; const outcome = await unknown.build().run({ mode: 'start' }); expect(outcome).toMatchObject({ disposition: 'UNCONFIRMED', phase: 'PLANNING', code: 'SECURITY_CONTROLLER_FAILED' }); expect(JSON.stringify(outcome)).not.toContain('private infrastructure'); expect(unknown.events.includes('transition:FAILED')).toBe(false); expect(unknown.attempts.size).toBe(0);
  });
  it('guards current binding and authority on claim, checkpoints, readiness, effects and completion', async () => {
    const f = fixture(), controller = f.build(); await controller.run({ mode: 'start' }); f.row.inputDigest = 'f'.repeat(64); expect((await controller.run({ mode: 'resume', decisionId: f.decision('APPROVED') })).code).toBe('SECURITY_CONTROLLER_BINDING_CHANGED'); expect(f.executions).toEqual(['plan']); expect(f.operations).toEqual(expect.arrayContaining(['CLAIM', 'CHECKPOINT', 'READINESS', 'BEGIN_STEP', 'COMPLETE_STEP', 'TRANSITION', 'RELEASE']));
    const other = fixture(); const pending = deferred<ReturnType<typeof result>>(), started = deferred<void>(); other.steps.plan!.execute = async () => { started.resolve(); return pending.promise; }; const active = other.build(); const work = active.run({ mode: 'start' }); await started.promise; other.revoke(); pending.resolve(result()); expect((await work).disposition).toBe('UNCONFIRMED'); expect(other.row.reservedMicros).toBe(10); expect(other.row.chargedMicros).toBe(0);
  });
  it('fences cancellation immediately, bounds drain, tracks ignored abort and never claims undo or replays', async () => {
    const f = fixture(), pending = deferred<ReturnType<typeof result>>(), started = deferred<void>(); let signal: AbortSignal | undefined; f.steps.plan!.execute = async input => { signal = input.signal; started.resolve(); return pending.promise; }; const controller = f.build(); const work = controller.run({ mode: 'start' }); await started.promise;
    const stopped = await controller.stop(); expect(stopped).toMatchObject({ phase: 'OUTCOME_UNKNOWN', recorded: true, drained: false, effectsUndone: false }); expect(signal?.aborted).toBe(true); expect(controller.running).toBe(true); expect((await work).disposition).toBe('STOPPED'); await expect(controller.run({ mode: 'start' })).rejects.toThrow('SECURITY_CONTROLLER_BUSY'); expect(f.row.reservedMicros).toBe(10);
    expect(await controller.stop()).toEqual(stopped); expect(f.events.filter(event => event === 'stop')).toHaveLength(1); pending.resolve(result()); await expect.poll(() => controller.running).toBe(false); expect(f.row.chargedMicros).toBe(0); expect(f.attempts.size).toBe(1);
  });
  it('fences a heartbeat failure and preserves the in-flight attempt rather than starting another owner', async () => {
    const f = fixture(), pending = deferred<ReturnType<typeof result>>(), started = deferred<void>(); f.steps.plan!.execute = async () => { started.resolve(); return pending.promise; }; const controller = f.build(); const work = controller.run({ mode: 'start' }); await started.promise; f.failHeartbeat(); expect(await work).toMatchObject({ disposition: 'STOPPED', phase: 'OUTCOME_UNKNOWN' }); expect(f.row.reservedMicros).toBe(10); pending.resolve(result()); await expect.poll(() => controller.running).toBe(false);
  });
  it('bounds step timeout and shutdown while leaving ignored work tracked and future dispatch closed', async () => {
    const f = fixture(), pending = deferred<ReturnType<typeof result>>(), started = deferred<void>(); f.steps.plan!.timeoutMs = 100; f.steps.plan!.execute = async () => { started.resolve(); return pending.promise; }; const controller = f.build(); const work = controller.run({ mode: 'start' }); await started.promise; expect(await work).toMatchObject({ disposition: 'STOPPED', phase: 'OUTCOME_UNKNOWN' }); await controller.drain(); await expect(controller.run({ mode: 'start' })).rejects.toThrow('SECURITY_CONTROLLER_DRAINING'); pending.resolve(result()); await expect.poll(() => controller.running).toBe(false);
  });
  it('does not convert an internal repeated start or missing saved decision into an automatic retry', async () => {
    const f = fixture(), controller = f.build(); await controller.run({ mode: 'start' }); const repeated = await controller.run({ mode: 'start' }); expect(repeated).toMatchObject({ disposition: 'BLOCKED', phase: 'AWAITING_APPROVAL', code: 'SECURITY_WORKFLOW_ALREADY_STARTED' }); expect(f.executions).toEqual(['plan']);
    expect((await controller.run({ mode: 'resume', decisionId: randomUUID() })).code).toBe('SECURITY_DECISION_INVALID'); expect(f.executions).toEqual(['plan']);
  });
});
