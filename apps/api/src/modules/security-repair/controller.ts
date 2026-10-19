import { z } from 'zod';
import type { Prisma, PrismaClient, SecurityRepairRun } from '@prisma/client';
import { createSecurityWorkflow, effectKinds, manifestDigest, scopeSchema, SECURITY_WORKFLOW_POLICY, SecurityCheckpointer, SecurityWorkflowError, sha256, stepResultSchema, uuid, workSteps, type ArtifactReceipt, type SecurityCheckpointStorage, type SecurityDecisionKind, type SecurityEffectKind, type SecurityPhase, type SecurityScope, type SecurityStepResult, type SecurityWorkStep } from '@zerochack/security-orchestration';
import { securityCheckpointStorage, type CheckpointAuthority } from './checkpoint-storage.js';
import { createSecurityRepairJournal, type SecurityJournalOperation, type SecurityJournalOptions, type SecurityLeaseFence } from './journal.js';

export type SecurityControllerAuthority = (tx: Prisma.TransactionClient, scope: SecurityScope, operation: SecurityJournalOperation | 'CHECKPOINT' | 'READINESS', run: SecurityRepairRun | null) => Promise<void>;
export type SecurityControllerBinding = { actorId: string; sessionId: string; requestDigest: string; authorityDigest: string; implementationDigest: string; allowanceMicros: number; policy: typeof SECURITY_WORKFLOW_POLICY };
type Readiness = { ready: true } | { ready: false; code: string };
export type SecurityStepContext = { scope: Readonly<SecurityScope>; fence: Readonly<SecurityLeaseFence>; attemptId: string; signal: AbortSignal; previous?: ArtifactReceipt; assertCurrent(): Promise<void> };
export type SecurityControllerStep = {
  kind: SecurityEffectKind; reserveMicros: number; timeoutMs: number;
  implementationId: string; implementationVersion: string; implementationDigest: string;
  /** DB-only prerequisite inspection. No model/network/SSH/sandbox work here. */
  readiness(input: { tx: Prisma.TransactionClient; run: SecurityRepairRun; scope: Readonly<SecurityScope>; previous?: ArtifactReceipt }): Promise<Readiness>;
  /** Exactly one bounded journaled effect. An ignored abort remains tracked, not retried. */
  execute(input: SecurityStepContext): Promise<SecurityStepResult>;
};
type Journal = ReturnType<typeof createSecurityRepairJournal>;
export type SecurityControllerOptions = {
  database: PrismaClient; scope: SecurityScope; workerId: string; artifactKey: string; binding: SecurityControllerBinding;
  authorize: SecurityControllerAuthority;
  steps: Partial<Record<SecurityWorkStep, SecurityControllerStep>>;
  heartbeatMs?: number; drainMs?: number; runTimeoutMs?: number;
  /** Trusted injection seams for tests/internal composition only, never API/model input. */
  journalFactory?: (authorize: Parameters<typeof createSecurityRepairJournal>[0]['assertAuthority']) => Journal;
  checkpointStorageFactory?: (fence: SecurityLeaseFence, authorize: CheckpointAuthority) => SecurityCheckpointStorage;
  decision?: (input: { scope: Readonly<SecurityScope>; fence: Readonly<SecurityLeaseFence>; kind: SecurityDecisionKind; decisionId: string; artifact: ArtifactReceipt; signal: AbortSignal; assertCurrent(): Promise<void> }) => Promise<'APPROVED' | 'DENIED'>;
  stagingMutation?: SecurityJournalOptions['stagingMutation'];
};
export type SecurityControllerResult = { disposition: 'WAITING' | 'BLOCKED' | 'TERMINAL' | 'UNCONFIRMED' | 'STOPPED'; phase: SecurityPhase | null; code: string | null; checkpointConfirmed: boolean; leaseReleased: boolean; effectsUndone: false };
type StopReason = 'CANCELLED' | 'SHUTDOWN' | 'DEADLINE' | 'HEARTBEAT_FAILED' | 'STEP_TIMEOUT';
type ControllerMode = 'start' | 'resume' | 'continueAfterRestart' | 'recheckPrerequisites';
export type SecurityControllerStop = { reason: StopReason; phase: SecurityPhase | null; recorded: boolean; drained: boolean; effectsUndone: false; code: string | null };
const code = z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/u);
const bindingSchema = z.object({ actorId: uuid, sessionId: uuid, requestDigest: sha256, authorityDigest: sha256, implementationDigest: sha256, allowanceMicros: z.number().int().min(0).max(100_000_000), policy: z.literal(SECURITY_WORKFLOW_POLICY) }).strict();
const stepDefinition = z.object({ kind: z.enum(effectKinds), reserveMicros: z.number().int().min(0).max(100_000_000), timeoutMs: z.number().int().min(100).max(120_000), implementationId: z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/u), implementationVersion: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,39}$/u), implementationDigest: sha256 }).strict();
const allowedKinds: Record<SecurityWorkStep, readonly SecurityEffectKind[]> = { plan: ['READ', 'MODEL'], snapshot: ['READ'], candidate: ['READ', 'MODEL', 'SANDBOX'], verify: ['READ', 'SANDBOX'], proposal: ['READ'], apply: ['PRODUCTION_WRITE', 'STAGING_WRITE', 'STAGING_RECOVERY'], post_verify: ['READ', 'SANDBOX'] };
const normalTerminal = ['COMPLETED', 'CANCELLED'] as const;
const authoritativeTerminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'OUTCOME_UNKNOWN', 'STALE'];
const invocationErrors = ['SECURITY_WORKFLOW_ALREADY_STARTED', 'SECURITY_WORKFLOW_NOT_WAITING', 'SECURITY_WORKFLOW_NOT_RESUMABLE', 'SECURITY_READINESS_NOT_RESUMABLE'];
const waitingErrors = [...invocationErrors, 'SECURITY_DECISION_INVALID', 'SECURITY_DECISION_BINDING_CHANGED', 'SECURITY_DECISION_EXPIRED', 'SECURITY_DECISION_RECEIPT_CHANGED', 'SECURITY_DECISION_NOT_WAITING', 'UNREGISTERED_SECURITY_EXECUTOR'];
const deterministicFailures = ['SECURITY_STEP_BINDING_CHANGED', 'SECURITY_RECEIPT_BINDING_CHANGED', 'SECURITY_TRANSITION_INVALID', 'SECURITY_JOURNAL_LIMIT', 'SECURITY_BUDGET_EXCEEDED', 'SECURITY_BUDGET_REQUIRED', 'SECURITY_ARTIFACT_UNAVAILABLE', 'SECURITY_CHECKPOINT_INVALID', 'SECURITY_CHECKPOINT_CONFLICT', 'SECURITY_CHECKPOINT_SCOPE_DENIED', 'SECURITY_MANIFEST_INVALID', 'SECURITY_MANIFEST_LIMIT'];
function fail(value: string): never { throw new SecurityWorkflowError(value); }
function safeCode(error: unknown): string { return error instanceof SecurityWorkflowError && /^(?:SECURITY_[A-Z0-9_]+|UNREGISTERED_SECURITY_EXECUTOR)$/u.test(error.code) && error.code.length <= 80 ? error.code : 'SECURITY_CONTROLLER_FAILED'; }
async function safeNode<T>(work: () => Promise<T>): Promise<T> { try { return await work(); } catch (error) { throw new SecurityWorkflowError(safeCode(error)); } }
function copyFence(fence: SecurityLeaseFence): SecurityLeaseFence { return { ownerId: fence.ownerId, version: fence.version, expiresAt: new Date(fence.expiresAt) }; }

/** Canonical provenance/budget binding for a separately authorized server admission.
 * Changing a reviewed handler, runtime, limit or allowance needs a new run/approval.
 */
export function securityControllerManifest(input: Pick<SecurityControllerOptions, 'scope' | 'binding' | 'steps'>) {
  const scope = Object.freeze(scopeSchema.parse(input.scope)); const binding = Object.freeze(bindingSchema.parse(input.binding));
  if (Object.keys(input.steps).some(step => !(workSteps as readonly string[]).includes(step))) fail('SECURITY_STEP_BINDING_INVALID');
  const definitions = workSteps.map(step => {
    const definition = input.steps[step]; if (!definition) return { step, available: false };
    const { execute, readiness, ...metadata } = definition; const parsed = stepDefinition.parse(metadata);
    if (typeof execute !== 'function' || typeof readiness !== 'function' || !allowedKinds[step].includes(parsed.kind) || parsed.kind === 'MODEL' && parsed.reserveMicros === 0) fail('SECURITY_STEP_BINDING_INVALID');
    return { step, available: true, ...parsed };
  });
  const budgetHash = manifestDigest({ allowanceMicros: binding.allowanceMicros, implementationDigest: binding.implementationDigest, definitions });
  const inputDigest = manifestDigest({ scope, policy: binding.policy, requestDigest: binding.requestDigest, authorityDigest: binding.authorityDigest, implementationDigest: binding.implementationDigest, budgetHash, definitions });
  return { scope, binding, definitions, budgetHash, inputDigest, expectedCreateBinding: Object.freeze({ ...scope, actorId: binding.actorId, sessionId: binding.sessionId, inputDigest, authorityDigest: binding.authorityDigest, allowanceMicros: binding.allowanceMicros }) };
}

/** Internal, dormant controller. No route, queue dispatcher, flag activation,
 * provider setup or executable customer-code adapter is registered here.
 */
export function createSecurityRepairController(options: SecurityControllerOptions) {
  if (typeof options.authorize !== 'function') fail('SECURITY_AUTHORITY_REQUIRED');
  const authorize = options.authorize, decide = options.decision, artifactKey = options.artifactKey, database = options.database, journalFactory = options.journalFactory, checkpointStorageFactory = options.checkpointStorageFactory;
  const manifest = securityControllerManifest(options); const { scope, binding } = manifest; const workerId = uuid.parse(options.workerId);
  const key = Buffer.from(options.artifactKey, 'base64'); if (key.length !== 32 || key.toString('base64') !== options.artifactKey) fail('SECURITY_CHECKPOINT_KEY_REQUIRED');
  const heartbeatMs = z.number().int().min(250).max(10_000).parse(options.heartbeatMs ?? 5000);
  const drainMs = z.number().int().min(1).max(10_000).parse(options.drainMs ?? 2000);
  const runTimeoutMs = z.number().int().min(1000).max(300_000).parse(options.runTimeoutMs ?? 120_000);
  // Capture functions and metadata, not a caller-mutable step registry.
  const steps = Object.fromEntries(workSteps.flatMap(step => options.steps[step] ? [[step, Object.freeze({ ...options.steps[step]! })]] : [])) as Partial<Record<SecurityWorkStep, Readonly<SecurityControllerStep>>>;
  function assertBinding(run: SecurityRepairRun) {
    if (run.id !== scope.runId || run.tenantId !== scope.tenantId || run.websiteId !== scope.websiteId || run.environment !== scope.environment || run.actorId !== binding.actorId || run.sessionId !== binding.sessionId || run.inputDigest !== manifest.inputDigest || run.authorityDigest !== binding.authorityDigest || run.allowanceMicros !== binding.allowanceMicros) fail('SECURITY_CONTROLLER_BINDING_CHANGED');
  }
  const authorizeJournal: Parameters<typeof createSecurityRepairJournal>[0]['assertAuthority'] = async (tx, actual, operation) => {
    if (manifestDigest(actual) !== manifestDigest(scope)) fail('SECURITY_CONTROLLER_BINDING_CHANGED');
    await tx.$queryRaw`SELECT id FROM security_repair_runs WHERE tenant_id=${scope.tenantId}::uuid AND website_id=${scope.websiteId}::uuid AND environment=${scope.environment} AND id=${scope.runId}::uuid FOR UPDATE`;
    const run = await tx.securityRepairRun.findFirst({ where: { id: scope.runId, tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment } });
    if (run) assertBinding(run); else if (operation !== 'CREATE') fail('SECURITY_RUN_NOT_FOUND');
    await authorize(tx, scope, operation, run);
  };
  const stagingMutationPolicy = options.stagingMutation ? Object.freeze({ ...options.stagingMutation }) : undefined;
  const journal = journalFactory?.(authorizeJournal) ?? createSecurityRepairJournal({ database, assertAuthority: authorizeJournal, ...(stagingMutationPolicy ? { stagingMutation: stagingMutationPolicy } : {}) });
  const storageFor = (fence: SecurityLeaseFence, authorize: CheckpointAuthority) => checkpointStorageFactory?.(copyFence(fence), authorize) ?? securityCheckpointStorage(database, scope, fence, authorize);
  const boundAuthorize = (operation: 'CHECKPOINT' | 'READINESS'): CheckpointAuthority => async (tx, run) => { assertBinding(run); await authorize(tx, scope, operation, run); };
  type Active = { abort: AbortController; fence: SecurityLeaseFence | null; task: Promise<SecurityControllerResult> | null; heartbeat: ReturnType<typeof setTimeout> | null; heartbeatWork: Promise<void> | null; deadline: ReturnType<typeof setTimeout> | null; stopped: Promise<SecurityControllerResult>; stopResult(value: SecurityControllerResult): void; stopping: boolean };
  let active: Active | null = null; let closing = false; let stopWork: Promise<SecurityControllerStop> | null = null;
  const answer = (disposition: SecurityControllerResult['disposition'], phase: SecurityPhase | null, errorCode: string | null = null, checkpointConfirmed = false, leaseReleased = false): SecurityControllerResult => ({ disposition, phase, code: errorCode, checkpointConfirmed, leaseReleased, effectsUndone: false });
  function haltHeartbeat(state: Active) { if (state.heartbeat) clearTimeout(state.heartbeat); state.heartbeat = null; }
  async function observed() { try { return await journal.recoverExpired(scope); } catch { return null; } }
  async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<{ done: true; value: T } | { done: false }> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work.then(value => ({ done: true as const, value })), new Promise<{ done: false }>(resolve => { timer = setTimeout(() => resolve({ done: false }), milliseconds); })]); } finally { if (timer) clearTimeout(timer); }
  }
  async function stop(reason: StopReason = 'CANCELLED'): Promise<SecurityControllerStop> {
    if (reason === 'SHUTDOWN') closing = true;
    if (stopWork) return stopWork;
    const state = active; if (state) { state.stopping = true; state.abort.abort(); haltHeartbeat(state); }
    // Start the authoritative business fence immediately. A stale graph cursor is
    // not permission; do not delay cancellation to save another graph checkpoint.
    let recorded: { phase: SecurityPhase } | null = null; let stopCode: string | null = null;
    const recording = journal.stopRun(scope, { actorId: binding.actorId, sessionId: binding.sessionId }).then(run => { recorded = { phase: run.phase as SecurityPhase }; }, error => { stopCode = safeCode(error); });
    const draining = Promise.all([recording, state?.task?.then(() => undefined, () => undefined) ?? Promise.resolve()]);
    const pending = (async (): Promise<SecurityControllerStop> => {
      const settled = await bounded(draining, drainMs); const receipt = recorded as { phase: SecurityPhase } | null;
      const result = { reason, phase: receipt?.phase ?? null, recorded: receipt !== null, drained: settled.done, effectsUndone: false as const, code: stopCode ?? (receipt ? null : 'SECURITY_STOP_UNCONFIRMED') };
      state?.stopResult(answer('STOPPED', result.phase, result.code, false, result.recorded));
      return result;
    })();
    stopWork = pending;
    // Keep new runs fenced locally while the actual recording is unresolved,
    // even if bounded drain returns to the shutdown caller first.
    void Promise.all([pending, recording, state?.task?.then(() => undefined, () => undefined) ?? Promise.resolve()]).then(() => { if (stopWork === pending) stopWork = null; });
    return pending;
  }
  function heartbeat(state: Active, assertCurrent: () => Promise<void>) {
    state.heartbeat = setTimeout(() => {
      state.heartbeat = null;
      if (state.stopping || state.abort.signal.aborted || !state.fence) return;
      const work = (async () => { await assertCurrent(); state.fence = await journal.heartbeat(scope, state.fence!); })();
      state.heartbeatWork = work;
      void work.then(() => { state.heartbeatWork = null; if (!state.stopping && !state.abort.signal.aborted) heartbeat(state, assertCurrent); }, () => { state.heartbeatWork = null; void stop('HEARTBEAT_FAILED'); });
    }, heartbeatMs);
  }
  async function perform(state: Active, command: { mode: ControllerMode; decisionId?: string }): Promise<SecurityControllerResult> {
    let checkpointConfirmed = false;
    let workflow: ReturnType<typeof createSecurityWorkflow> | null = null;
    try {
      state.fence = await journal.claimRun(scope, workerId);
      const storage = storageFor(state.fence, boundAuthorize('CHECKPOINT'));
      const assertCurrent = async () => { if (state.abort.signal.aborted || state.stopping) fail('SECURITY_CONTROLLER_STOPPED'); await storage.assertLease(); };
      await assertCurrent(); heartbeat(state, assertCurrent);
      workflow = createSecurityWorkflow(scope, new SecurityCheckpointer(scope, storage, artifactKey), {
        assertLeaseAndAuthority: () => safeNode(assertCurrent),
        async transition(phase, errorCode) { await safeNode(async () => { await assertCurrent(); await journal.transition(scope, state.fence!, phase, errorCode); }); },
        async decision(kind, decisionId, artifact) { return safeNode(async () => {
          await assertCurrent();
          const result = decide ? await decide({ scope, fence: copyFence(state.fence!), kind, decisionId, artifact, signal: state.abort.signal, assertCurrent }) : kind === 'CANDIDATE' ? await journal.resolveCandidateDecision(scope, state.fence!, decisionId, artifact) : stagingMutationPolicy ? await journal.resolveChangeDecision(scope, state.fence!, decisionId, artifact) : fail('UNREGISTERED_SECURITY_EXECUTOR');
          await assertCurrent(); if (result !== 'APPROVED' && result !== 'DENIED') fail('SECURITY_DECISION_INVALID'); return result;
        }); },
        async step(step, input) { return safeNode<SecurityStepResult>(async () => {
          await assertCurrent(); const definition = steps[step]; if (!definition) return { outcome: 'BLOCKED', code: 'SECURITY_STEP_UNAVAILABLE' };
          let readiness: Readiness | undefined;
          const checking = storageFor(state.fence!, async (tx, run) => { await boundAuthorize('READINESS')(tx, run); readiness = await definition.readiness({ tx, run, scope, ...input }); });
          await checking.assertLease();
          const ready = z.discriminatedUnion('ready', [z.object({ ready: z.literal(true) }).strict(), z.object({ ready: z.literal(false), code }).strict()]).parse(readiness);
          if (!ready.ready) return { outcome: 'BLOCKED', code: ready.code };
          await assertCurrent();
          const begun = await journal.beginStep(scope, state.fence!, { stepKey: step, kind: definition.kind, inputDigest: manifestDigest({ inputDigest: manifest.inputDigest, budgetHash: manifest.budgetHash, step, implementationDigest: definition.implementationDigest, previous: input.previous ?? null }), reserveMicros: definition.reserveMicros });
          if (begun.outcome === 'SUCCEEDED') return { outcome: 'SUCCEEDED', artifact: begun.artifact, costMicros: begun.costMicros };
          await assertCurrent();
          const timer = setTimeout(() => { void stop('STEP_TIMEOUT'); }, definition.timeoutMs);
          try {
            const result = stepResultSchema.parse(await definition.execute({ scope, fence: copyFence(state.fence!), attemptId: begun.attemptId, signal: state.abort.signal, assertCurrent, ...input }));
            // BLOCKED after STARTED is not evidence of no remote/paid effect. Keep
            // its reservation and reconcile; never silently replay this handler.
            if (result.outcome !== 'SUCCEEDED') fail('SECURITY_EFFECT_UNRESOLVED');
            await assertCurrent(); await journal.completeStep(scope, state.fence!, begun.attemptId, { ...result.artifact, costMicros: result.costMicros });
            return result;
          } finally { clearTimeout(timer); }
        }); }
      });
      if (command.mode === 'start') await workflow.start();
      else if (command.mode === 'resume') await workflow.resume({ decisionId: command.decisionId });
      else if (command.mode === 'recheckPrerequisites') await workflow.recheckPrerequisites();
      else await workflow.continueAfterRestart();
      const saved = await workflow.status(); checkpointConfirmed = true;
      haltHeartbeat(state);
      if (state.heartbeatWork && !(await bounded(state.heartbeatWork.then(() => undefined), drainMs)).done) fail('SECURITY_HEARTBEAT_UNCONFIRMED');
      await assertCurrent();
      if ((normalTerminal as readonly string[]).includes(saved.phase)) {
        // Normal terminal intent is already in a synchronous durable checkpoint.
        await journal.transition(scope, state.fence!, saved.phase);
        return answer('TERMINAL', saved.phase, null, true, true);
      }
      await journal.releaseLease(scope, state.fence!);
      return answer(saved.phase === 'WAITING_FOR_INPUT' ? 'BLOCKED' : 'WAITING', saved.phase, saved.blockCode, true, true);
    } catch (error) {
      haltHeartbeat(state); const errorCode = safeCode(error);
      if (!state.fence) { state.abort.abort(); return answer('UNCONFIRMED', null, errorCode); }
      const truth = await observed();
      if (!truth) { state.abort.abort(); return answer('UNCONFIRMED', null, 'SECURITY_OUTCOME_UNCONFIRMED', checkpointConfirmed); }
      if (authoritativeTerminal.includes(truth.phase)) { state.abort.abort(); return answer('TERMINAL', truth.phase as SecurityPhase, errorCode, checkpointConfirmed, true); }
      if (truth.unfinishedAttempts > 0) {
        state.abort.abort();
        try { await journal.transition(scope, state.fence, 'OUTCOME_UNKNOWN', 'SECURITY_EFFECT_UNRESOLVED'); return answer('UNCONFIRMED', 'OUTCOME_UNKNOWN', 'SECURITY_EFFECT_UNRESOLVED', checkpointConfirmed, true); }
        catch { return answer('UNCONFIRMED', truth.phase as SecurityPhase, 'SECURITY_EFFECT_UNRESOLVED', checkpointConfirmed); }
      }
      if (waitingErrors.includes(errorCode) && (errorCode !== 'UNREGISTERED_SECURITY_EXECUTOR' || truth.phase === 'AWAITING_APPROVAL')) {
        // A bad decision/request or unavailable production executor is not a
        // completed repair and must not destroy a saved waiting run. Confirm its
        // existing cursor before releasing; never start/retry a node here.
        try {
          if (!workflow) fail('SECURITY_CHECKPOINT_INVALID');
          await workflow.status(); checkpointConfirmed = true;
          state.abort.abort(); await journal.releaseLease(scope, state.fence);
          return answer('BLOCKED', truth.phase as SecurityPhase, errorCode, true, true);
        } catch { /* A failed cursor read/release remains unconfirmed, not fatal. */ }
      }
      state.abort.abort();
      if (deterministicFailures.includes(errorCode)) {
        // Only explicit deterministic policy/contract failure, with no unfinished
        // attempt, may finalize FAILED. Unknown infrastructure/commit-ack errors
        // keep the last checkpoint and completed journal receipts recoverable.
        try { await journal.transition(scope, state.fence, 'FAILED', errorCode); return answer('TERMINAL', 'FAILED', errorCode, checkpointConfirmed, true); } catch { /* Revocation/lease loss wins over this attempted finalization. */ }
      }
      // A failed/ambiguous cursor write is not permission to replay nor proof the
      // last successful journal receipt was lost. Preserve the cursor and run;
      // let its lease expire. A later explicit restart must reconsult the journal.
      return answer('UNCONFIRMED', truth.phase as SecurityPhase, errorCode, checkpointConfirmed);
    }
  }
  return {
    expectedCreateBinding: manifest.expectedCreateBinding, inputDigest: manifest.inputDigest, budgetHash: manifest.budgetHash,
    /** Shared bound callback for the separate trusted CREATE flow. */
    authorizeJournal,
    stagingMutationPolicy,
    recordCandidateDecision: (input: Parameters<typeof journal.recordCandidateDecision>[1]) => journal.recordCandidateDecision(scope, input),
    recordChangeDecision: (input: Parameters<typeof journal.recordChangeDecision>[1]) => journal.recordChangeDecision(scope, input),
    get running() { return active !== null; },
    async run(input: { mode: ControllerMode; decisionId?: string }): Promise<SecurityControllerResult> {
      const command = z.discriminatedUnion('mode', [z.object({ mode: z.literal('start') }).strict(), z.object({ mode: z.literal('resume'), decisionId: uuid }).strict(), z.object({ mode: z.literal('continueAfterRestart') }).strict(), z.object({ mode: z.literal('recheckPrerequisites') }).strict()]).parse(input);
      if (closing) fail('SECURITY_CONTROLLER_DRAINING'); if (active || stopWork) fail('SECURITY_CONTROLLER_BUSY');
      let resolveStop!: (value: SecurityControllerResult) => void;
      const state: Active = { abort: new AbortController(), fence: null, task: null, heartbeat: null, heartbeatWork: null, deadline: null, stopped: new Promise(resolve => { resolveStop = resolve; }), stopResult: value => resolveStop(value), stopping: false };
      active = state; const task = perform(state, command); state.task = task;
      state.deadline = setTimeout(() => { void stop('DEADLINE'); }, runTimeoutMs);
      const cleanup = () => { haltHeartbeat(state); if (state.deadline) clearTimeout(state.deadline); state.deadline = null; if (active === state) active = null; };
      void task.then(cleanup, cleanup);
      return Promise.race([task, state.stopped]);
    },
    stop: () => stop('CANCELLED'),
    drain: () => stop('SHUTDOWN')
  };
}
