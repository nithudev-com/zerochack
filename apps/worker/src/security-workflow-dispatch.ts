import { Queue, Worker, UnrecoverableError, type Job, type JobsOptions, type WorkerOptions } from 'bullmq';
import type Redis from 'ioredis';
import type { Prisma, PrismaClient, SecurityRepairOutbox, SecurityRepairRun } from '@prisma/client';
import { z } from 'zod';
import { manifestDigest, scopeSchema, uuid, type SecurityScope } from '@zerochack/security-orchestration';
import type { createSecurityRepairController } from '../../api/src/modules/security-repair/controller.js';

const payloadSchema = z.discriminatedUnion('mode', [scopeSchema.extend({ mode: z.literal('start') }).strict(), scopeSchema.extend({ mode: z.literal('resume'), decisionId: uuid }).strict()]);
export type SecurityWorkflowDispatchPayload = z.infer<typeof payloadSchema>;
type Controller = Pick<ReturnType<typeof createSecurityRepairController>, 'run' | 'drain' | 'running' | 'expectedCreateBinding'>;
type Envelope = { event: SecurityRepairOutbox; run: SecurityRepairRun };
type Published = { id: string; ownerId: string; version: number; payload: SecurityWorkflowDispatchPayload };
type QueuePort = { add(name: string, payload: SecurityWorkflowDispatchPayload, options: JobsOptions): Promise<unknown>; close(): Promise<void>; setGlobalConcurrency(concurrency: number): Promise<unknown> };
type WorkerPort = { pause(doNotWaitActive?: boolean): Promise<void>; close(force?: boolean): Promise<void>; run(): Promise<void>; waitUntilReady(): Promise<unknown> };
type Active = { controller: Controller | null; loaded: Promise<Controller>; work: Promise<unknown> | null };
export type SecurityWorkflowDispatchOptions = {
  database: PrismaClient;
  /** Already configured by the protected environment, including verified Redis
   * TLS. This module neither replaces trust settings nor disconnects its owner. */
  connection: Redis;
  dispatcherId: string;
  /** Trusted server composition only. Reload the current actor/session, policy,
   * scope/provenance and reviewed services from the database. Queue data grants
   * nothing. The returned real controller must enforce its journal authority. */
  controllerFactory(scope: Readonly<SecurityScope>): Promise<Controller>;
  queueName?: string; batchSize?: number; leaseMs?: number; publishTimeoutMs?: number; shutdownTimeoutMs?: number;
  onError?(code: string): void;
  /** Explicit test-only transport seams, never browser/model configuration. */
  queueFactory?(name: string, options: { connection: Redis }): QueuePort;
  workerFactory?(name: string, process: (job: Job<SecurityWorkflowDispatchPayload>) => Promise<unknown>, options: WorkerOptions): WorkerPort;
};
const dispatchEvents = ['run.created', 'decision.approved', 'decision.denied'];
const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'STALE', 'OUTCOME_UNKNOWN'];
const jobName = 'security.workflow.dispatch';
export const securityWorkflowJobOptions: Readonly<JobsOptions> = Object.freeze({ attempts: 1, removeOnComplete: Object.freeze({ age: 604800, count: 1000 }), removeOnFail: Object.freeze({ age: 2592000, count: 1000 }), keepLogs: 0, stackTraceLimit: 0, sizeLimit: 1024 });
export const securityWorkflowWorkerOptions = Object.freeze({ concurrency: 1, autorun: false, maxStalledCount: 0, maxStartedAttempts: 1, skipStalledCheck: false, skipLockRenewal: false, lockDuration: 30000 });
function fail(code: string): never { throw new UnrecoverableError(code); }
export function securityWorkflowDispatchPayload(value: unknown): SecurityWorkflowDispatchPayload { return payloadSchema.parse(value); }
export function securityWorkflowDispatchJobId(eventId: string): string { return `security-workflow-${uuid.parse(eventId)}`; }
function eventIdFromJobId(id: string | undefined): string { if (!id?.startsWith('security-workflow-')) fail('SECURITY_DISPATCH_JOB_INVALID'); return uuid.parse(id.slice('security-workflow-'.length)); }
function scopeOf(value: SecurityRepairRun): SecurityScope { return scopeSchema.parse({ tenantId: value.tenantId, websiteId: value.websiteId, environment: value.environment, runId: value.id }); }
async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([work.then(value => ({ done: true as const, value })), new Promise<{ done: false }>(resolve => { timer = setTimeout(() => resolve({ done: false }), milliseconds); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Dormant transport boundary: no imports from worker/index, schedules, flags or
 * routes enable it. BullMQ is at-least-once transport, never execution authority.
 * Retention bounds Redis memory; durable published rows and controller receipts,
 * not the lifetime of a Redis job id, remain the deduplication/safety boundary. */
export function createSecurityWorkflowDispatch(options: SecurityWorkflowDispatchOptions) {
  if (typeof options.controllerFactory !== 'function') fail('SECURITY_DISPATCH_FACTORY_REQUIRED');
  const database = options.database, factory = options.controllerFactory, ownerId = uuid.parse(options.dispatcherId);
  const queueName = z.string().regex(/^security-workflow(?:-[a-z0-9-]{1,80})?$/u).parse(options.queueName ?? 'security-workflow');
  const batchSize = z.number().int().min(1).max(10).parse(options.batchSize ?? 5), leaseMs = z.number().int().min(5000).max(60000).parse(options.leaseMs ?? 30000);
  const publishTimeoutMs = z.number().int().min(100).max(3000).parse(options.publishTimeoutMs ?? 1000), shutdownTimeoutMs = z.number().int().min(100).max(10000).parse(options.shutdownTimeoutMs ?? 5000);
  let closing = false, started = false, flushWork: Promise<{ claimed: number; published: number; unconfirmed: number }> | null = null, closeWork: Promise<{ drained: boolean; workerClosed: boolean; queueClosed: boolean; activeControllers: number; effectsUndone: false }> | null = null;
  const active = new Set<Active>(), publications = new Set<Promise<unknown>>();
  async function transaction<T>(work: (tx: Prisma.TransactionClient, now: Date) => Promise<T>): Promise<T> {
    return database.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`; await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
      const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
      if (!Number.isFinite(now.getTime())) fail('SECURITY_DISPATCH_CLOCK_INVALID');
      return work(tx, now);
    }, { maxWait: 2000, timeout: 5000 });
  }
  async function derive(tx: Prisma.TransactionClient, envelope: Envelope, now: Date): Promise<SecurityWorkflowDispatchPayload | null> {
    const { event, run } = envelope; const scope = scopeOf(run);
    if (event.tenantId !== scope.tenantId || event.websiteId !== scope.websiteId || event.environment !== scope.environment || event.runId !== scope.runId || !dispatchEvents.includes(event.eventType) || terminal.includes(run.phase) || run.expiresAt <= now) return null;
    const website = await tx.website.findFirst({ where: { id: scope.websiteId, tenantId: scope.tenantId, lifecycle: 'ACTIVE' }, select: { id: true } }); if (!website) return null;
    // A crash/stall is not an instruction to replay. Even an expired run lease
    // requires explicit reconciliation; this transport consumes only quiescent
    // newly admitted work or a saved first candidate decision.
    if (run.leaseOwnerId || run.leaseExpiresAt) return null;
    const where = { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, runId: scope.runId };
    if (event.eventType === 'run.created') return event.eventKey === 'run.created' && event.phase === 'PLANNING' && run.phase === 'PLANNING' && await tx.securityRepairAttempt.count({ where }) === 0 ? { ...scope, mode: 'start' } : null;
    if (run.phase !== 'AWAITING_APPROVAL' || event.phase !== 'AWAITING_APPROVAL' || await tx.securityRepairAttempt.count({ where: { ...where, OR: [{ stepKey: { not: 'plan' } }, { state: { not: 'SUCCEEDED' } }] } })) return null;
    const decision = await tx.securityRepairDecision.findFirst({ where: { ...where, kind: 'CANDIDATE', actorId: run.actorId, sessionId: run.sessionId, status: event.eventType === 'decision.approved' ? 'APPROVED' : 'DENIED', expiresAt: { gt: now, lte: run.expiresAt } } });
    if (!decision || event.eventKey !== `decision.${decision.id}.recorded`) return null;
    const plan = await tx.securityRepairAttempt.findFirst({ where: { ...where, stepKey: 'plan', state: 'SUCCEEDED', artifactId: decision.artifactId, artifactDigest: decision.digest } }); if (!plan) return null;
    const artifact = await tx.careArtifact.findFirst({ where: { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, id: decision.artifactId, digest: decision.digest, status: 'ACCEPTED', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, select: { id: true } });
    return artifact ? { ...scope, mode: 'resume', decisionId: decision.id } : null;
  }
  async function claim(): Promise<Published[]> {
    return transaction(async (tx, now) => {
      // Eligibility prevents stale/terminal or invalid old events from starving
      // newer events. Non-dispatch progress/history rows are never consumed.
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT o.id FROM security_repair_outbox o JOIN security_repair_runs r ON r.id=o.run_id AND r.tenant_id=o.tenant_id AND r.website_id=o.website_id AND r.environment=o.environment JOIN websites w ON w.id=r.website_id AND w.tenant_id=r.tenant_id WHERE o.published_at IS NULL AND o.dispatch_attempts<3 AND (o.dispatch_expires_at IS NULL OR o.dispatch_expires_at<=${now}) AND w.lifecycle='ACTIVE' AND r.expires_at>${now} AND r.lease_owner_id IS NULL AND r.lease_expires_at IS NULL AND ((o.event_type='run.created' AND o.event_key='run.created' AND o.phase='PLANNING' AND r.phase='PLANNING' AND NOT EXISTS (SELECT 1 FROM security_repair_attempts a WHERE a.run_id=r.id)) OR (o.event_type IN ('decision.approved','decision.denied') AND o.phase='AWAITING_APPROVAL' AND r.phase='AWAITING_APPROVAL' AND NOT EXISTS (SELECT 1 FROM security_repair_attempts a WHERE a.run_id=r.id AND (a.step_key<>'plan' OR a.state<>'SUCCEEDED')) AND EXISTS (SELECT 1 FROM security_repair_decisions d JOIN security_repair_attempts a ON a.run_id=r.id AND a.step_key='plan' AND a.state='SUCCEEDED' AND a.artifact_id=d.artifact_id AND a.artifact_digest=d.digest JOIN care_artifacts f ON f.id=d.artifact_id AND f.tenant_id=r.tenant_id AND f.website_id=r.website_id AND f.environment=r.environment AND f.status='ACCEPTED' AND f.digest=d.digest AND (f.expires_at IS NULL OR f.expires_at>${now}) WHERE d.run_id=r.id AND d.tenant_id=r.tenant_id AND d.website_id=r.website_id AND d.environment=r.environment AND d.kind='CANDIDATE' AND d.actor_id=r.actor_id AND d.session_id=r.session_id AND d.expires_at>${now} AND d.expires_at<=r.expires_at AND o.event_key='decision.'||d.id::text||'.recorded' AND ((o.event_type='decision.approved' AND d.status='APPROVED') OR (o.event_type='decision.denied' AND d.status='DENIED'))))) ORDER BY o.created_at,o.id LIMIT ${batchSize} FOR UPDATE OF o SKIP LOCKED`;
      const claimed: Published[] = [];
      for (const row of rows) {
        const event = await tx.securityRepairOutbox.findUniqueOrThrow({ where: { id: row.id }, include: { run: true } }); const payload = await derive(tx, { event, run: event.run }, now); if (!payload) continue;
        const updated = await tx.securityRepairOutbox.update({ where: { id: event.id }, data: { dispatchVersion: { increment: 1 }, dispatchOwnerId: ownerId, dispatchExpiresAt: new Date(now.getTime() + leaseMs), dispatchAttempts: { increment: 1 } } });
        claimed.push({ id: event.id, ownerId, version: updated.dispatchVersion, payload });
      }
      return claimed;
    });
  }
  async function acknowledge(value: Published): Promise<boolean> {
    return transaction(async (tx, now) => (await tx.securityRepairOutbox.updateMany({ where: { id: value.id, tenantId: value.payload.tenantId, websiteId: value.payload.websiteId, environment: value.payload.environment, runId: value.payload.runId, publishedAt: null, dispatchOwnerId: value.ownerId, dispatchVersion: value.version, dispatchExpiresAt: { gt: now } }, data: { publishedAt: now, dispatchOwnerId: null, dispatchExpiresAt: null } })).count === 1);
  }
  async function process(job: Job<SecurityWorkflowDispatchPayload>) {
    try {
      if (closing) fail('SECURITY_DISPATCH_DRAINING');
      const payload = securityWorkflowDispatchPayload(job.data), eventId = eventIdFromJobId(job.id);
      if (job.name !== jobName || job.opts.attempts !== 1 || job.attemptsMade !== 0 || job.attemptsStarted !== 1) fail('SECURITY_DISPATCH_REPLAY_DENIED');
      const accepted = await transaction(async (tx, now) => {
        const event = await tx.securityRepairOutbox.findFirst({ where: { id: eventId, tenantId: payload.tenantId, websiteId: payload.websiteId, environment: payload.environment, runId: payload.runId }, include: { run: true } });
        if (!event || event.dispatchAttempts < 1 || !event.publishedAt && (!event.dispatchOwnerId || !event.dispatchExpiresAt || event.dispatchExpiresAt <= now)) fail('SECURITY_DISPATCH_EVENT_INVALID');
        const derived = await derive(tx, { event, run: event.run }, now);
        if (derived && manifestDigest(derived) !== manifestDigest(payload)) fail('SECURITY_DISPATCH_BINDING_CHANGED');
        return derived ? { payload: derived, expectedBinding: { ...scopeOf(event.run), actorId: event.run.actorId, sessionId: event.run.sessionId, inputDigest: event.run.inputDigest, authorityDigest: event.run.authorityDigest, allowanceMicros: event.run.allowanceMicros } } : null;
      });
      if (!accepted || closing) return { disposition: 'SKIPPED', code: closing ? 'SECURITY_DISPATCH_DRAINING' : 'SECURITY_DISPATCH_EVENT_STALE' };
      const scope = Object.freeze(scopeSchema.parse({ tenantId: accepted.payload.tenantId, websiteId: accepted.payload.websiteId, environment: accepted.payload.environment, runId: accepted.payload.runId }));
      const entry: Active = { controller: null, loaded: Promise.resolve().then(() => factory(scope)), work: null }; active.add(entry);
      const work = (async () => {
        const controller = await entry.loaded; entry.controller = controller;
        if (manifestDigest(controller.expectedCreateBinding) !== manifestDigest(accepted.expectedBinding)) fail('SECURITY_DISPATCH_FACTORY_BINDING_CHANGED');
        if (closing) { await controller.drain(); return { disposition: 'SKIPPED', code: 'SECURITY_DISPATCH_DRAINING' }; }
        const result = await controller.run(accepted.payload.mode === 'start' ? { mode: 'start' } : { mode: 'resume', decisionId: accepted.payload.decisionId });
        // A bounded controller result may precede an abort-ignoring underlying
        // handler. Keep the processor slot occupied and the controller tracked;
        // closing the worker is bounded separately and never implies undo.
        while (controller.running) await new Promise(resolve => setTimeout(resolve, 100));
        return { disposition: 'CONTROLLER', result };
      })();
      entry.work = work;
      try { return await work; } finally { if (!entry.controller?.running) active.delete(entry); }
    } catch { fail('SECURITY_DISPATCH_JOB_FAILED'); }
  }
  const queue = options.queueFactory?.(queueName, { connection: options.connection }) ?? new Queue<SecurityWorkflowDispatchPayload>(queueName, { connection: options.connection });
  const worker = options.workerFactory?.(queueName, process, { ...securityWorkflowWorkerOptions, connection: options.connection }) ?? new Worker<SecurityWorkflowDispatchPayload>(queueName, process, { ...securityWorkflowWorkerOptions, connection: options.connection });
  if ('on' in queue && typeof queue.on === 'function') queue.on('error', () => options.onError?.('SECURITY_DISPATCH_QUEUE_FAILED'));
  if ('on' in worker && typeof worker.on === 'function') worker.on('error', () => options.onError?.('SECURITY_DISPATCH_WORKER_FAILED'));
  return {
    queueName,
    async start() {
      if (closing || started) fail('SECURITY_DISPATCH_START_DENIED');
      started = true;
      const ready = await bounded(Promise.all([queue.setGlobalConcurrency(1), worker.waitUntilReady()]), shutdownTimeoutMs); if (!ready.done || closing) fail('SECURITY_DISPATCH_NOT_READY');
      void worker.run().catch(() => options.onError?.('SECURITY_DISPATCH_WORKER_FAILED'));
    },
    flush() {
      if (closing) return Promise.reject(new UnrecoverableError('SECURITY_DISPATCH_DRAINING'));
      if (flushWork) return flushWork;
      const work = (async () => {
        const deadline = performance.now() + 10000;
        const claimed = await claim(); let published = 0, unconfirmed = 0;
        for (const value of claimed) {
          if (closing || performance.now() >= deadline) { unconfirmed++; continue; }
          const publication = queue.add(jobName, value.payload, { ...securityWorkflowJobOptions, jobId: securityWorkflowDispatchJobId(value.id) }); publications.add(publication);
          void publication.then(() => publications.delete(publication), () => publications.delete(publication));
          try { const result = await bounded(publication, publishTimeoutMs); if (result.done && await acknowledge(value)) published++; else unconfirmed++; }
          catch { unconfirmed++; options.onError?.('SECURITY_DISPATCH_PUBLICATION_UNCONFIRMED'); }
        }
        return { claimed: claimed.length, published, unconfirmed };
      })();
      flushWork = work; void work.then(() => { if (flushWork === work) flushWork = null; }, () => { if (flushWork === work) flushWork = null; }); return work;
    },
    close() {
      if (closeWork) return closeWork;
      closing = true;
      closeWork = (async () => {
        // Fence trusted controllers before closing transport. A factory/handler
        // ignoring abort remains tracked; no false undo or complete-drain claim.
        const draining = Promise.allSettled([worker.pause(true), ...[...active].map(async entry => { const controller = entry.controller ?? await entry.loaded; await controller.drain(); if (entry.work) await entry.work; if (!controller.running) active.delete(entry); }), ...publications, ...(flushWork ? [flushWork] : [])]);
        const settled = await bounded(draining, shutdownTimeoutMs); const drained = settled.done && settled.value.every(value => value.status === 'fulfilled');
        const workerClosed = (await bounded(worker.close(!drained), shutdownTimeoutMs).catch(() => ({ done: false }))).done;
        const queueClosed = (await bounded(queue.close(), shutdownTimeoutMs).catch(() => ({ done: false }))).done;
        return { drained: drained && active.size === 0, workerClosed, queueClosed, activeControllers: active.size, effectsUndone: false as const };
      })();
      return closeWork;
    }
  };
}
