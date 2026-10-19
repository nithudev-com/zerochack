import { randomUUID } from 'node:crypto';
import type { PrismaClient, SecurityRepairOutbox, SecurityRepairRun } from '@prisma/client';
import type Redis from 'ioredis';
import type { Job, JobsOptions, WorkerOptions } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { createSecurityWorkflowDispatch, securityWorkflowDispatchJobId, securityWorkflowDispatchPayload, securityWorkflowJobOptions, securityWorkflowWorkerOptions, type SecurityWorkflowDispatchOptions, type SecurityWorkflowDispatchPayload } from './security-workflow-dispatch.js';

/** Actual module/BullMQ imports, but database and queue transport protocol fakes.
 * These cases do not prove PostgreSQL locks, Redis TLS, provider or repair work. */
function fixture() {
  let now = Date.now(), websiteActive = true;
  const scope = { tenantId: randomUUID(), websiteId: randomUUID(), environment: 'STAGING' as const, runId: randomUUID() };
  const run = { id: scope.runId, tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, actorId: randomUUID(), sessionId: randomUUID(), inputDigest: 'a'.repeat(64), authorityDigest: 'b'.repeat(64), allowanceMicros: 100, phase: 'PLANNING', expiresAt: new Date(now + 60000), leaseOwnerId: null, leaseExpiresAt: null } as SecurityRepairRun;
  const created = { id: randomUUID(), ...scope, eventKey: 'run.created', eventType: 'run.created', phase: 'PLANNING', dispatchVersion: 0, dispatchOwnerId: null, dispatchExpiresAt: null, dispatchAttempts: 0, publishedAt: null, createdAt: new Date(now) } as SecurityRepairOutbox;
  const events = [created], attempts: Array<{ stepKey: string; state: string; artifactId: string; artifactDigest: string }> = [];
  let decision: { id: string; kind: 'CANDIDATE' | 'PRODUCTION'; actorId: string; sessionId: string; status: 'APPROVED' | 'DENIED'; artifactId: string; digest: string; expiresAt: Date } | null = null;
  function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
    return Object.entries(where).every(([key, value]) => {
      if (key === 'OR') return (value as Array<Record<string, unknown>>).some(clause => matches(row, clause));
      const actual = row[key];
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        const rule = value as { not?: unknown; in?: unknown[]; gt?: Date; lte?: Date };
        if ('not' in rule && actual === rule.not || rule.in && !rule.in.includes(actual)) return false;
        if (rule.gt && (!(actual instanceof Date) || actual <= rule.gt) || rule.lte && (!(actual instanceof Date) || actual > rule.lte)) return false;
        return true;
      }
      return actual === value;
    });
  }
  const jobs = new Map<string, Job<SecurityWorkflowDispatchPayload>>(), order: string[] = [];
  const binding = () => ({ ...scope, actorId: run.actorId, sessionId: run.sessionId, inputDigest: run.inputDigest, authorityDigest: run.authorityDigest, allowanceMicros: run.allowanceMicros });
  let controllerRunning = false;
  const controller = { expectedCreateBinding: binding(), get running() { return controllerRunning; }, run: vi.fn(async () => ({ disposition: 'WAITING' as const, phase: 'AWAITING_APPROVAL' as const, code: null, checkpointConfirmed: true, leaseReleased: true, effectsUndone: false as const })), drain: vi.fn(async () => { order.push('controller.drain'); return { reason: 'SHUTDOWN' as const, phase: 'CANCELLED' as const, recorded: true, drained: !controllerRunning, effectsUndone: false as const, code: null }; }) };
  const controllerFactory = vi.fn(async () => controller);
  const tx = {
    $executeRaw: vi.fn(async () => 0),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => strings.join('').includes('clock_timestamp') ? [{ now: new Date(now) }] : events.filter(event => !event.publishedAt && event.dispatchAttempts < 3 && (!event.dispatchExpiresAt || event.dispatchExpiresAt.getTime() <= now)).map(event => ({ id: event.id }))),
    website: { findFirst: vi.fn(async () => websiteActive ? { id: scope.websiteId } : null) },
    securityRepairOutbox: {
      findUniqueOrThrow: vi.fn(async ({ where }: { where: { id: string } }) => ({ ...events.find(event => event.id === where.id)!, run })),
      findFirst: vi.fn(async ({ where }: { where: { id: string; tenantId: string; websiteId: string; environment: string; runId: string } }) => { const event = events.find(event => Object.entries(where).every(([key, value]) => (event as unknown as Record<string, unknown>)[key] === value)); return event ? { ...event, run } : null; }),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: { dispatchVersion: { increment: number }; dispatchOwnerId: string; dispatchExpiresAt: Date; dispatchAttempts: { increment: number } } }) => { const event = events.find(event => event.id === where.id)!; event.dispatchVersion += data.dispatchVersion.increment; event.dispatchAttempts += data.dispatchAttempts.increment; event.dispatchOwnerId = data.dispatchOwnerId; event.dispatchExpiresAt = data.dispatchExpiresAt; return event; }),
      updateMany: vi.fn(async ({ where, data }: { where: { id: string; dispatchOwnerId: string; dispatchVersion: number }; data: { publishedAt: Date; dispatchOwnerId: null; dispatchExpiresAt: null } }) => { const event = events.find(event => event.id === where.id)!; if (event.dispatchOwnerId !== where.dispatchOwnerId || event.dispatchVersion !== where.dispatchVersion || !event.dispatchExpiresAt || event.dispatchExpiresAt.getTime() <= now) return { count: 0 }; Object.assign(event, data); return { count: 1 }; })
    },
    securityRepairAttempt: {
      count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => attempts.filter(attempt => matches({ ...scope, ...attempt }, where)).length),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => attempts.find(attempt => matches({ ...scope, ...attempt }, where)) ?? null)
    },
    securityRepairDecision: { findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => decision && matches({ ...scope, ...decision }, where) ? decision : null) },
    careArtifact: { findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => decision && matches({ tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, id: decision.artifactId, digest: decision.digest, status: 'ACCEPTED', expiresAt: null }, where) ? { id: decision.artifactId } : null) }
  };
  const database = { $transaction: async <T>(work: (value: typeof tx) => Promise<T>) => work(tx) } as unknown as PrismaClient;
  const queue = { add: vi.fn(async (name: string, data: SecurityWorkflowDispatchPayload, opts: JobsOptions) => { const id = opts.jobId!; if (!jobs.has(id)) jobs.set(id, { id, name, data, opts, attemptsMade: 0, attemptsStarted: 1 } as Job<SecurityWorkflowDispatchPayload>); return jobs.get(id)!; }), setGlobalConcurrency: vi.fn(async (_value: number) => undefined), close: vi.fn(async () => { order.push('queue.close'); }) };
  const worker = { waitUntilReady: vi.fn(async () => undefined), run: vi.fn(async () => undefined), pause: vi.fn(async () => { order.push('worker.pause'); }), close: vi.fn(async (force?: boolean) => { order.push(`worker.close:${force}`); }) };
  let process!: (job: Job<SecurityWorkflowDispatchPayload>) => Promise<unknown>, workerOptions!: WorkerOptions;
  const connection = {} as Redis;
  const options: SecurityWorkflowDispatchOptions = { database, connection, dispatcherId: randomUUID(), controllerFactory, publishTimeoutMs: 100, shutdownTimeoutMs: 100, queueFactory: (_name, input) => { expect(input.connection).toBe(connection); return queue; }, workerFactory: (_name, processor, input) => { process = processor; workerOptions = input; return worker; } };
  const dispatch = createSecurityWorkflowDispatch(options);
  return { scope, run, created, events, attempts, jobs, tx, queue, worker, controller, controllerFactory, options, dispatch, order, process: (job: Job<SecurityWorkflowDispatchPayload>) => process(job), get workerOptions() { return workerOptions; }, bindController: () => { controller.expectedCreateBinding = binding(); }, setControllerRunning(value: boolean) { controllerRunning = value; }, advance(ms: number) { now += ms; }, disableWebsite() { websiteActive = false; }, decide(status: 'APPROVED' | 'DENIED', kind: 'CANDIDATE' | 'PRODUCTION' = 'CANDIDATE') {
    run.phase = 'AWAITING_APPROVAL'; const artifactId = randomUUID();
    if (kind === 'PRODUCTION') { run.executionProfile = 'MANAGED_STATIC_PERMISSION_V1'; run.admissionArtifactId = randomUUID(); run.admissionDigest = 'e'.repeat(64); for (const stepKey of ['plan', 'snapshot', 'candidate', 'verify']) attempts.push({ stepKey, state: 'SUCCEEDED', artifactId: randomUUID(), artifactDigest: 'd'.repeat(64) }); }
    attempts.push({ stepKey: kind === 'CANDIDATE' ? 'plan' : 'proposal', state: 'SUCCEEDED', artifactId, artifactDigest: 'c'.repeat(64) }); decision = { id: randomUUID(), kind, actorId: run.actorId, sessionId: run.sessionId, artifactId, digest: 'c'.repeat(64), expiresAt: new Date(now + 50000), status }; const event = { ...created, id: randomUUID(), eventKey: `decision.${decision.id}.recorded`, eventType: status === 'APPROVED' ? 'decision.approved' : 'decision.denied', phase: 'AWAITING_APPROVAL' } as SecurityRepairOutbox; events.push(event); return { decision, event };
  } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

describe('dormant workflow dispatch protocol fixtures (not real PostgreSQL/Redis evidence)', () => {
  it('accepts only scope plus mode/saved decision and uses deterministic non-colon UUID job IDs', () => {
    const f = fixture(), payload = { ...f.scope, mode: 'start' as const }; expect(securityWorkflowDispatchPayload(payload)).toEqual(payload); expect(securityWorkflowDispatchPayload({ ...f.scope, mode: 'resume', decisionId: randomUUID() }).mode).toBe('resume');
    for (const extra of [{ password: 'never-queue-this' }, { command: 'remote execution' }, { executor: 'model-chosen' }, { actorId: randomUUID() }, { decisionId: randomUUID() }]) expect(() => securityWorkflowDispatchPayload({ ...payload, ...extra })).toThrow();
    expect(() => securityWorkflowDispatchPayload({ ...f.scope, mode: 'continueAfterRestart' })).toThrow(); expect(() => securityWorkflowDispatchPayload({ ...f.scope, mode: 'resume' })).toThrow(); expect(securityWorkflowDispatchJobId(f.created.id)).toBe(securityWorkflowDispatchJobId(f.created.id)); expect(securityWorkflowDispatchJobId(f.created.id)).not.toContain(':');
  });
  it('is dormant until explicitly started and configures one attempt, one processor and no stalled replay', async () => {
    const f = fixture(); expect(f.worker.run).not.toHaveBeenCalled(); expect(f.workerOptions).toMatchObject({ ...securityWorkflowWorkerOptions, connection: f.options.connection }); expect(securityWorkflowJobOptions).toMatchObject({ attempts: 1, keepLogs: 0, stackTraceLimit: 0 }); expect(securityWorkflowJobOptions).not.toHaveProperty('backoff'); await f.dispatch.start(); expect(f.queue.setGlobalConcurrency).toHaveBeenCalledWith(1); expect(f.worker.run).toHaveBeenCalledTimes(1); await expect(f.dispatch.start()).rejects.toThrow('SECURITY_DISPATCH_START_DENIED'); await f.dispatch.close();
  });
  it('leases and publishes only recorded dispatch events, marks only its owned version and preserves progress history', async () => {
    const f = fixture(); const progress = { ...f.created, id: randomUUID(), eventKey: 'phase.1', eventType: 'run.transitioned' } as SecurityRepairOutbox; f.events.push(progress); expect(await f.dispatch.flush()).toEqual({ claimed: 1, published: 1, unconfirmed: 0 }); expect(f.created.publishedAt).toBeInstanceOf(Date); expect(progress.publishedAt).toBeNull(); expect(f.queue.add).toHaveBeenCalledWith('security.workflow.dispatch', { ...f.scope, mode: 'start' }, { ...securityWorkflowJobOptions, jobId: securityWorkflowDispatchJobId(f.created.id) }); expect(await f.dispatch.flush()).toEqual({ claimed: 0, published: 0, unconfirmed: 0 }); await f.dispatch.close();
  });
  it('coalesces concurrent flushes and retains ambiguous publication for bounded same-ID transport retry', async () => {
    const f = fixture(), pending = deferred<Job<SecurityWorkflowDispatchPayload>>(); f.queue.add.mockImplementationOnce(() => pending.promise); const first = f.dispatch.flush(); expect(f.dispatch.flush()).toBe(first); expect(await first).toEqual({ claimed: 1, published: 0, unconfirmed: 1 }); expect(f.created.publishedAt).toBeNull(); const id = securityWorkflowDispatchJobId(f.created.id); pending.resolve({ id } as Job<SecurityWorkflowDispatchPayload>); f.advance(30001); expect(await f.dispatch.flush()).toEqual({ claimed: 1, published: 1, unconfirmed: 0 }); expect(f.created.dispatchVersion).toBe(2); expect(f.queue.add.mock.calls.map(call => call[2].jobId)).toEqual([id, id]); await f.dispatch.close();
  });
  it('cannot acknowledge a dispatch version owned by another publisher', async () => {
    const f = fixture(); f.queue.add.mockImplementationOnce(async (name, data, opts) => { f.created.dispatchVersion++; f.created.dispatchOwnerId = randomUUID(); return { id: opts.jobId, name, data, opts } as Job<SecurityWorkflowDispatchPayload>; }); expect(await f.dispatch.flush()).toEqual({ claimed: 1, published: 0, unconfirmed: 1 }); expect(f.created.publishedAt).toBeNull(); await f.dispatch.close();
  });
  it('re-derives the scope/event and rejects forged payloads or repeated transport attempts before a controller exists', async () => {
    const f = fixture(); await f.dispatch.flush(); const job = [...f.jobs.values()][0]!;
    for (const changed of [{ data: { ...job.data, tenantId: randomUUID() } }, { data: { ...job.data, rawCommand: 'not-authority' } }, { attemptsStarted: 2 }, { attemptsMade: 1 }, { opts: { ...job.opts, attempts: 2 } }, { id: securityWorkflowDispatchJobId(randomUUID()) }]) await expect(f.process({ ...job, ...changed } as Job<SecurityWorkflowDispatchPayload>)).rejects.toThrow('SECURITY_DISPATCH_JOB_FAILED');
    expect(f.controllerFactory).not.toHaveBeenCalled(); await f.dispatch.close();
  });
  it('does not start cancelled, completed, unknown, expired or disabled-site work delivered late', async () => {
    for (const phase of ['CANCELLED', 'COMPLETED', 'OUTCOME_UNKNOWN', 'STALE', 'FAILED']) { const f = fixture(); await f.dispatch.flush(); f.run.phase = phase; expect(await f.process([...f.jobs.values()][0]!)).toMatchObject({ disposition: 'SKIPPED', code: 'SECURITY_DISPATCH_EVENT_STALE' }); expect(f.controllerFactory).not.toHaveBeenCalled(); await f.dispatch.close(); }
    const expired = fixture(); await expired.dispatch.flush(); expired.advance(60001); expect(await expired.process([...expired.jobs.values()][0]!)).toMatchObject({ disposition: 'SKIPPED' }); await expired.dispatch.close(); const disabled = fixture(); await disabled.dispatch.flush(); disabled.disableWebsite(); expect(await disabled.process([...disabled.jobs.values()][0]!)).toMatchObject({ disposition: 'SKIPPED' }); await disabled.dispatch.close();
  });
  it.each(['APPROVED', 'DENIED'] as const)('derives exact saved %s candidate decisions, not arbitrary resume identifiers', async status => {
    const f = fixture(), saved = f.decide(status); expect(await f.dispatch.flush()).toEqual({ claimed: 1, published: 1, unconfirmed: 0 }); const job = f.jobs.get(securityWorkflowDispatchJobId(saved.event.id))!; expect(job.data).toEqual({ ...f.scope, mode: 'resume', decisionId: saved.decision.id }); expect(await f.process(job)).toMatchObject({ disposition: 'CONTROLLER' }); expect(f.controllerFactory).toHaveBeenCalledWith(f.scope); expect(f.controller.run).toHaveBeenCalledWith({ mode: 'resume', decisionId: saved.decision.id }); await f.dispatch.close();
  });
  it.each(['APPROVED', 'DENIED'] as const)('dispatches an exact saved %s change decision only for an admitted STAGING proposal', async status => {
    const f = fixture(), saved = f.decide(status, 'PRODUCTION');
    expect(await f.dispatch.flush()).toEqual({ claimed: 1, published: 1, unconfirmed: 0 });
    const job = f.jobs.get(securityWorkflowDispatchJobId(saved.event.id))!;
    expect(job.data).toEqual({ ...f.scope, mode: 'resume', decisionId: saved.decision.id });
    expect(await f.process(job)).toMatchObject({ disposition: 'CONTROLLER' });
    expect(f.controller.run).toHaveBeenCalledWith({ mode: 'resume', decisionId: saved.decision.id }); await f.dispatch.close();
  });
  it('refuses a change event with a missing admission, wrong profile, changed receipt, session or expired exact decision', async () => {
    for (const alter of [
      (f: ReturnType<typeof fixture>) => { f.run.admissionArtifactId = null; },
      (f: ReturnType<typeof fixture>) => { f.run.admissionDigest = null; },
      (f: ReturnType<typeof fixture>) => { f.run.executionProfile = null; },
      (f: ReturnType<typeof fixture>) => { f.run.executionProfile = 'UNREVIEWED'; },
      (f: ReturnType<typeof fixture>) => { f.attempts.find(row => row.stepKey === 'proposal')!.artifactDigest = 'f'.repeat(64); },
      (f: ReturnType<typeof fixture>) => { f.run.sessionId = randomUUID(); },
      (f: ReturnType<typeof fixture>) => { f.advance(50001); }
    ]) {
      const f = fixture(); f.decide('APPROVED', 'PRODUCTION'); alter(f);
      expect(await f.dispatch.flush()).toEqual({ claimed: 0, published: 0, unconfirmed: 0 }); expect(f.controllerFactory).not.toHaveBeenCalled(); await f.dispatch.close();
    }
  });
  it('does not dispatch a change approval if any apply attempt exists or any earlier effect is unfinished/unknown', async () => {
    for (const [stepKey, state] of [['apply', 'SUCCEEDED'], ['apply', 'STARTED'], ['snapshot', 'OUTCOME_UNKNOWN'], ['candidate', 'STARTED']] as const) {
      const f = fixture(); f.decide('APPROVED', 'PRODUCTION'); f.attempts.push({ stepKey, state, artifactId: randomUUID(), artifactDigest: 'f'.repeat(64) });
      expect(await f.dispatch.flush()).toEqual({ claimed: 0, published: 0, unconfirmed: 0 }); expect(f.controllerFactory).not.toHaveBeenCalled(); await f.dispatch.close();
    }
  });
  it('does not reuse an old candidate event at production approval or automatically restart an unfinished lease', async () => {
    const f = fixture(); f.decide('APPROVED'); f.attempts.push({ stepKey: 'snapshot', state: 'SUCCEEDED', artifactId: randomUUID(), artifactDigest: 'd'.repeat(64) }); expect(await f.dispatch.flush()).toEqual({ claimed: 0, published: 0, unconfirmed: 0 }); await f.dispatch.close(); const leased = fixture(); leased.run.leaseOwnerId = randomUUID(); leased.run.leaseExpiresAt = new Date(0); expect(await leased.dispatch.flush()).toEqual({ claimed: 0, published: 0, unconfirmed: 0 }); await leased.dispatch.close();
  });
  it('compares trusted factory binding to current saved actor/session/provenance instead of granting queue authority', async () => {
    const f = fixture(); await f.dispatch.flush(); f.controller.expectedCreateBinding.actorId = randomUUID(); await expect(f.process([...f.jobs.values()][0]!)).rejects.toThrow('SECURITY_DISPATCH_JOB_FAILED'); expect(f.controllerFactory).toHaveBeenCalledWith(f.scope); expect(f.controller.run).not.toHaveBeenCalled(); await f.dispatch.close();
  });
  it('drains tracked controllers before closing transport, bounds ignored work and never reports undo', async () => {
    const f = fixture(); await f.dispatch.flush(); f.setControllerRunning(true); const work = f.process([...f.jobs.values()][0]!); await expect.poll(() => f.controller.run.mock.calls.length).toBe(1); const closed = await f.dispatch.close(); expect(closed).toMatchObject({ drained: false, workerClosed: true, queueClosed: true, activeControllers: 1, effectsUndone: false }); expect(f.order.indexOf('controller.drain')).toBeLessThan(f.order.indexOf('worker.close:true')); await expect(f.dispatch.flush()).rejects.toThrow('SECURITY_DISPATCH_DRAINING'); f.setControllerRunning(false); expect(await work).toMatchObject({ disposition: 'CONTROLLER' });
  });
  it('tracks a pending trusted factory through shutdown and never calls run after closing', async () => {
    const f = fixture(), pending = deferred<Awaited<ReturnType<typeof f.controllerFactory>>>(); f.controllerFactory.mockImplementationOnce(() => pending.promise); await f.dispatch.flush(); const work = f.process([...f.jobs.values()][0]!); await expect.poll(() => f.controllerFactory.mock.calls.length).toBe(1); expect(await f.dispatch.close()).toMatchObject({ drained: false, activeControllers: 1 }); pending.resolve(f.controller); expect(await work).toMatchObject({ disposition: 'SKIPPED', code: 'SECURITY_DISPATCH_DRAINING' }); expect(f.controller.run).not.toHaveBeenCalled(); expect(f.controller.drain).toHaveBeenCalled();
  });
});
