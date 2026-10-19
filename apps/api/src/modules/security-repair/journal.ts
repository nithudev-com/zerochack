import { z } from 'zod';
import type { Prisma, PrismaClient, SecurityRepairAttempt, SecurityRepairRun } from '@prisma/client';
import { artifactReceiptSchema, effectKinds, phases, scopeSchema, sha256, uuid, SecurityWorkflowError, type ArtifactReceipt, type SecurityPhase, type SecurityScope } from '@zerochack/security-orchestration';

export type SecurityLeaseFence = { ownerId: string; version: number; expiresAt: Date };
export type SecurityJournalOperation = 'CREATE' | 'CLAIM' | 'HEARTBEAT' | 'RELEASE' | 'DECIDE' | 'TRANSITION' | 'BEGIN_STEP' | 'COMPLETE_STEP' | 'STOP' | 'OBSERVE';
export type SecurityJournalOptions = {
  database: PrismaClient;
  /** Short database-only check, using the same transaction. Re-read and lock current
   * session/MFA/grant/binding rows as needed. It must reject stale authority. Never
   * put provider/SSH calls here. Bind it to the trusted actor/session/authority
   * digest used to create the run; browser-supplied historical ids are not proof.
   * This callback is trusted server code, not a flag. */
  assertAuthority(tx: Prisma.TransactionClient, scope: SecurityScope, operation: SecurityJournalOperation): Promise<void>;
  /** Trusted test clock only. Production defaults to the database clock. */
  now?: () => Date;
  leaseMs?: number;
  /** Code-owned managed STAGING adapter only. A run field or request flag alone
   * cannot authorize a write. Production/recovery effects remain unavailable. */
  stagingMutation?: {
    profile: 'MANAGED_STATIC_PERMISSION_V1';
    assertReady(tx: Prisma.TransactionClient, scope: SecurityScope, run: SecurityRepairRun, action: 'DECIDE' | 'APPLY' | 'POST_VERIFY' | 'SETTLE', receipt?: ArtifactReceipt): Promise<void>;
  };
};
const terminal = ['COMPLETED', 'FAILED', 'CANCELLED'];
const codeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/u);
const money = z.number().int().min(0).max(100_000_000);
const fenceSchema = z.object({ ownerId: uuid, version: z.number().int().positive(), expiresAt: z.date() }).strict();
const createSchema = scopeSchema.extend({ actorId: uuid, sessionId: uuid, requestKey: uuid, inputDigest: sha256, authorityDigest: sha256, allowanceMicros: money, expiresAt: z.date(), admissionArtifactId: uuid.optional(), admissionDigest: sha256.optional(), executionProfile: z.literal('MANAGED_STATIC_PERMISSION_V1').optional() }).strict().superRefine((value, context) => {
  const fields = [value.admissionArtifactId, value.admissionDigest, value.executionProfile];
  if (fields.some(Boolean) && (value.environment !== 'STAGING' || fields.some(field => !field))) context.addIssue({ code: 'custom', message: 'Complete managed staging admission is required' });
});
const stepSchema = z.object({ stepKey: z.string().regex(/^[a-z][a-z0-9_.:-]{0,95}$/u), kind: z.enum(effectKinds), inputDigest: sha256, reserveMicros: money }).strict();
const receiptSchema = z.object({ artifactId: uuid, digest: sha256, costMicros: money }).strict();
const decisionSchema = artifactReceiptSchema.extend({ actorId: uuid, sessionId: uuid, requestKey: uuid, status: z.enum(['APPROVED', 'DENIED']) }).strict();
const transitions: Record<SecurityPhase, readonly SecurityPhase[]> = {
  PLANNING: ['WAITING_FOR_INPUT', 'AWAITING_APPROVAL'],
  WAITING_FOR_INPUT: ['PLANNING', 'AWAITING_APPROVAL', 'SNAPSHOTTING', 'CANDIDATE_WORK', 'VERIFYING', 'READY_FOR_RELEASE'],
  AWAITING_APPROVAL: ['SNAPSHOTTING', 'APPLYING'],
  SNAPSHOTTING: ['CANDIDATE_WORK', 'WAITING_FOR_INPUT'],
  CANDIDATE_WORK: ['VERIFYING', 'WAITING_FOR_INPUT'],
  VERIFYING: ['READY_FOR_RELEASE', 'WAITING_FOR_INPUT'],
  READY_FOR_RELEASE: ['AWAITING_APPROVAL', 'WAITING_FOR_INPUT'],
  APPLYING: ['POST_VERIFYING'], POST_VERIFYING: ['COMPLETED'],
  COMPLETED: [], FAILED: [], CANCELLED: [], STALE: [], OUTCOME_UNKNOWN: []
};
function fail(code: string): never { throw new SecurityWorkflowError(code); }
function key(scope: SecurityScope) { return { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, id: scope.runId }; }
function refs(scope: SecurityScope) { return { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, runId: scope.runId }; }
function active(run: SecurityRepairRun, now: Date) {
  if (terminal.includes(run.phase) || run.phase === 'OUTCOME_UNKNOWN' || run.phase === 'STALE') fail('SECURITY_RUN_NOT_ACTIVE');
  if (run.expiresAt <= now) fail('SECURITY_AUTHORITY_EXPIRED');
}
function lease(run: SecurityRepairRun, fence: SecurityLeaseFence, now: Date) {
  active(run, now);
  // Client expiresAt is informational; the persisted lease is authoritative.
  if (run.leaseOwnerId !== fence.ownerId || run.leaseVersion !== fence.version || !run.leaseExpiresAt || run.leaseExpiresAt <= now) fail('SECURITY_LEASE_LOST');
}

/** Dormant journal only. No executor, provider, outbox dispatcher or public route.
 * Commit acknowledgement loss is never retried here. The next caller can return
 * an exact completed receipt or must refuse an unfinished effect. */
export function createSecurityRepairJournal(options: SecurityJournalOptions) {
  const leaseMs = z.number().int().min(1000).max(60_000).parse(options.leaseMs ?? 30_000);
  async function transaction<T>(input: SecurityScope, operation: SecurityJournalOperation, fn: (tx: Prisma.TransactionClient, scope: SecurityScope, now: Date) => Promise<T>) {
    const scope = scopeSchema.parse(input);
    return options.database.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
      const sites = await tx.$queryRaw<Array<{ lifecycle: string }>>`SELECT lifecycle FROM websites WHERE tenant_id = ${scope.tenantId}::uuid AND id = ${scope.websiteId}::uuid FOR UPDATE`;
      if (!sites[0] || sites[0].lifecycle !== 'ACTIVE') fail('SECURITY_WEBSITE_UNAVAILABLE');
      await options.assertAuthority(tx, scope, operation);
      // Refresh time after authority checks/locks, not before a potentially busy wait.
      const now = options.now?.() ?? (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
      if (!Number.isFinite(now.getTime())) fail('SECURITY_CLOCK_INVALID');
      return fn(tx, scope, now);
    }, { maxWait: 2000, timeout: 5000 });
  }
  async function getRun(tx: Prisma.TransactionClient, scope: SecurityScope) {
    await tx.$queryRaw`SELECT id FROM security_repair_runs WHERE tenant_id = ${scope.tenantId}::uuid AND website_id = ${scope.websiteId}::uuid AND environment = ${scope.environment} AND id = ${scope.runId}::uuid FOR UPDATE`;
    const run = await tx.securityRepairRun.findFirst({ where: key(scope) });
    if (!run) fail('SECURITY_RUN_NOT_FOUND');
    return run;
  }
  async function event(tx: Prisma.TransactionClient, scope: SecurityScope, eventKey: string, eventType: string, phase: string, errorCode?: string) {
    await tx.securityRepairOutbox.create({ data: { ...refs(scope), eventKey, eventType, phase, ...(errorCode ? { errorCode } : {}) } });
    await tx.securityRepairRun.update({ where: { id: scope.runId }, data: { eventVersion: { increment: 1 } } });
  }
  async function noOtherWork(tx: Prisma.TransactionClient, scope: SecurityScope) {
    const [otherRuns, jobs, releases] = await Promise.all([
      tx.securityRepairRun.count({ where: { tenantId: scope.tenantId, websiteId: scope.websiteId, id: { not: scope.runId }, phase: { notIn: terminal } } }),
      tx.careJob.count({ where: { tenantId: scope.tenantId, websiteId: scope.websiteId, kind: { in: ['REPAIR', 'REVIEW'] }, state: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] } } }),
      tx.careRelease.count({ where: { tenantId: scope.tenantId, websiteId: scope.websiteId, state: { notIn: ['SUCCEEDED', 'COMPLETED', 'FAILED', 'CANCELLED', 'ROLLED_BACK', 'BASELINE_CONFIRMED'] } } })
    ]);
    if (otherRuns || jobs || releases) fail('SECURITY_WEBSITE_WORK_CONFLICT');
  }
  async function artifact(tx: Prisma.TransactionClient, scope: SecurityScope, receipt: ArtifactReceipt, now: Date) {
    const found = await tx.careArtifact.findFirst({ where: { id: receipt.artifactId, tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, status: 'ACCEPTED', digest: receipt.digest, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }, select: { id: true } });
    if (!found) fail('SECURITY_ARTIFACT_UNAVAILABLE');
    // Metadata equality only; this is NOT decryption, byte verification or recovery proof.
  }
  async function markUnknown(tx: Prisma.TransactionClient, scope: SecurityScope, attempts: SecurityRepairAttempt[], now: Date) {
    for (const attempt of attempts) {
      if (attempt.state === 'SUCCEEDED') continue;
      await tx.securityRepairAttempt.update({ where: { id: attempt.id }, data: { state: 'OUTCOME_UNKNOWN', errorCode: 'SECURITY_EFFECT_UNRESOLVED', completedAt: now } });
      if (!await tx.securityRepairCostEntry.findUnique({ where: { attemptId_kind: { attemptId: attempt.id, kind: 'UNKNOWN' } } })) await tx.securityRepairCostEntry.create({ data: { ...refs(scope), attemptId: attempt.id, kind: 'UNKNOWN', reservedDeltaMicros: 0, chargedDeltaMicros: 0 } });
    }
  }
  async function planReceipt(tx: Prisma.TransactionClient, scope: SecurityScope, receipt: ArtifactReceipt, now: Date) {
    const plan = await tx.securityRepairAttempt.findFirst({ where: { ...refs(scope), stepKey: 'plan' }, orderBy: { attemptNumber: 'desc' } });
    if (!plan || plan.state !== 'SUCCEEDED' || plan.artifactId !== receipt.artifactId || plan.artifactDigest !== receipt.digest) fail('SECURITY_DECISION_RECEIPT_CHANGED');
    await artifact(tx, scope, receipt, now);
  }
  async function candidateEffectAuthority(tx: Prisma.TransactionClient, scope: SecurityScope, run: SecurityRepairRun, now: Date) {
    const plan = await tx.securityRepairAttempt.findFirst({ where: { ...refs(scope), stepKey: 'plan' }, orderBy: { attemptNumber: 'desc' } });
    if (!plan || plan.state !== 'SUCCEEDED' || !plan.artifactId || !plan.artifactDigest) fail('SECURITY_DECISION_RECEIPT_CHANGED');
    await artifact(tx, scope, { artifactId: plan.artifactId, digest: plan.artifactDigest }, now);
    const decision = await tx.securityRepairDecision.findFirst({ where: { ...refs(scope), kind: 'CANDIDATE', artifactId: plan.artifactId } });
    if (!decision || decision.status !== 'APPROVED' || decision.actorId !== run.actorId || decision.sessionId !== run.sessionId || decision.digest !== plan.artifactDigest) fail('SECURITY_DECISION_BINDING_CHANGED');
    if (decision.expiresAt <= now || decision.expiresAt > run.expiresAt) fail('SECURITY_DECISION_EXPIRED');
  }
  async function stagingAuthority(tx: Prisma.TransactionClient, scope: SecurityScope, run: SecurityRepairRun, now: Date, action: 'DECIDE' | 'APPLY' | 'POST_VERIFY' | 'SETTLE', receipt?: ArtifactReceipt) {
    const policy = options.stagingMutation;
    if (!policy || scope.environment !== 'STAGING' || run.executionProfile !== policy.profile || !run.admissionArtifactId || !run.admissionDigest) fail('UNREGISTERED_SECURITY_EXECUTOR');
    await artifact(tx, scope, { artifactId: run.admissionArtifactId, digest: run.admissionDigest }, now);
    await policy.assertReady(tx, scope, run, action, receipt ? { artifactId: receipt.artifactId, digest: receipt.digest } : undefined);
  }
  async function proposalReceipt(tx: Prisma.TransactionClient, scope: SecurityScope, receipt: ArtifactReceipt, now: Date) {
    const proposal = await tx.securityRepairAttempt.findFirst({ where: { ...refs(scope), stepKey: 'proposal' }, orderBy: { attemptNumber: 'desc' } });
    if (!proposal || proposal.state !== 'SUCCEEDED' || proposal.artifactId !== receipt.artifactId || proposal.artifactDigest !== receipt.digest) fail('SECURITY_DECISION_RECEIPT_CHANGED');
    await artifact(tx, scope, receipt, now);
  }
  async function changeEffectAuthority(tx: Prisma.TransactionClient, scope: SecurityScope, run: SecurityRepairRun, now: Date) {
    await candidateEffectAuthority(tx, scope, run, now);
    const proposal = await tx.securityRepairAttempt.findFirst({ where: { ...refs(scope), stepKey: 'proposal', state: 'SUCCEEDED' } });
    if (!proposal?.artifactId || !proposal.artifactDigest) fail('SECURITY_DECISION_RECEIPT_CHANGED');
    const receipt = { artifactId: proposal.artifactId, digest: proposal.artifactDigest };
    await proposalReceipt(tx, scope, receipt, now);
    const decision = await tx.securityRepairDecision.findFirst({ where: { ...refs(scope), kind: 'PRODUCTION', artifactId: receipt.artifactId } });
    if (!decision || decision.status !== 'APPROVED' || decision.actorId !== run.actorId || decision.sessionId !== run.sessionId || decision.digest !== receipt.digest) fail('SECURITY_DECISION_BINDING_CHANGED');
    if (decision.expiresAt <= now || decision.expiresAt > run.expiresAt) fail('SECURITY_DECISION_EXPIRED');
    await stagingAuthority(tx, scope, run, now, 'APPLY', receipt);
  }
  return {
    async createRun(input: z.input<typeof createSchema>) {
      const value = createSchema.parse(input);
      return transaction({ tenantId: value.tenantId, websiteId: value.websiteId, environment: value.environment, runId: value.runId }, 'CREATE', async (tx, scope, now) => {
        if (value.expiresAt <= now || value.expiresAt.getTime() - now.getTime() > 86_400_000) fail('SECURITY_AUTHORITY_EXPIRED');
        const existing = await tx.securityRepairRun.findUnique({ where: { tenantId_websiteId_environment_requestKey: { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, requestKey: value.requestKey } } });
        if (existing) {
          if (existing.id !== scope.runId || existing.actorId !== value.actorId || existing.sessionId !== value.sessionId || existing.inputDigest !== value.inputDigest || existing.authorityDigest !== value.authorityDigest || existing.allowanceMicros !== value.allowanceMicros || existing.expiresAt.getTime() !== value.expiresAt.getTime() || (existing.admissionArtifactId ?? undefined) !== value.admissionArtifactId || (existing.admissionDigest ?? undefined) !== value.admissionDigest || (existing.executionProfile ?? undefined) !== value.executionProfile) fail('SECURITY_REQUEST_BINDING_CHANGED');
          return existing;
        }
        await noOtherWork(tx, scope);
        if (value.admissionArtifactId && value.admissionDigest) await artifact(tx, scope, { artifactId: value.admissionArtifactId, digest: value.admissionDigest }, now);
        const run = await tx.securityRepairRun.create({ data: { ...key(scope), requestKey: value.requestKey, actorId: value.actorId, sessionId: value.sessionId, inputDigest: value.inputDigest, authorityDigest: value.authorityDigest, allowanceMicros: value.allowanceMicros, expiresAt: value.expiresAt, ...(value.admissionArtifactId ? { admissionArtifactId: value.admissionArtifactId, admissionDigest: value.admissionDigest!, executionProfile: value.executionProfile! } : {}) } });
        await event(tx, scope, 'run.created', 'run.created', run.phase);
        return run;
      });
    },
    async claimRun(input: SecurityScope, workerId: string): Promise<SecurityLeaseFence> {
      const ownerId = uuid.parse(workerId);
      return transaction(input, 'CLAIM', async (tx, scope, now) => {
        const run = await getRun(tx, scope); active(run, now);
        await noOtherWork(tx, scope);
        if (run.leaseExpiresAt && run.leaseExpiresAt > now) fail('SECURITY_LEASE_BUSY');
        if (await tx.securityRepairAttempt.count({ where: { ...refs(scope), state: { not: 'SUCCEEDED' } } })) fail('SECURITY_EFFECT_UNRESOLVED');
        const expiresAt = new Date(Math.min(now.getTime() + leaseMs, run.expiresAt.getTime()));
        const updated = await tx.securityRepairRun.update({ where: { id: scope.runId }, data: { leaseOwnerId: ownerId, leaseVersion: { increment: 1 }, leaseExpiresAt: expiresAt } });
        await event(tx, scope, `lease.${updated.leaseVersion}`, 'lease.claimed', run.phase);
        return { ownerId, version: updated.leaseVersion, expiresAt };
      });
    },
    async heartbeat(input: SecurityScope, inputFence: SecurityLeaseFence): Promise<SecurityLeaseFence> {
      const fence = fenceSchema.parse(inputFence);
      return transaction(input, 'HEARTBEAT', async (tx, scope, now) => {
        const run = await getRun(tx, scope); lease(run, fence, now);
        const expiresAt = new Date(Math.min(now.getTime() + leaseMs, run.expiresAt.getTime()));
        await tx.securityRepairRun.update({ where: { id: scope.runId }, data: { leaseExpiresAt: expiresAt } });
        return { ...fence, expiresAt };
      });
    },
    /** Release only after the synchronous checkpoint is durably acknowledged.
     * Never use it to abandon a running effect or to make uncertain work replayable. */
    async releaseLease(input: SecurityScope, inputFence: SecurityLeaseFence) {
      const fence = fenceSchema.parse(inputFence);
      return transaction(input, 'RELEASE', async (tx, scope, now) => {
        const run = await getRun(tx, scope); lease(run, fence, now);
        if (await tx.securityRepairAttempt.count({ where: { ...refs(scope), state: { not: 'SUCCEEDED' } } })) fail('SECURITY_EFFECT_UNRESOLVED');
        const updated = await tx.securityRepairRun.update({ where: { id: scope.runId }, data: { leaseOwnerId: null, leaseExpiresAt: null, leaseVersion: { increment: 1 } } });
        await event(tx, scope, `lease.${updated.leaseVersion}.released`, 'lease.released', run.phase);
        return updated;
      });
    },
    /** Candidate-only decision, entered after the awaiting-approval checkpoint and
     * lease release. A persisted historical receipt is not production authority. */
    async recordCandidateDecision(input: SecurityScope, inputDecision: z.input<typeof decisionSchema>): Promise<string> {
      const value = decisionSchema.parse(inputDecision);
      return transaction(input, 'DECIDE', async (tx, scope, now) => {
        const run = await getRun(tx, scope);
        if (run.actorId !== value.actorId || run.sessionId !== value.sessionId) fail('SECURITY_ACTOR_BINDING_CHANGED');
        const prior = await tx.securityRepairDecision.findUnique({ where: { tenantId_websiteId_environment_runId_requestKey: { ...refs(scope), requestKey: value.requestKey } } });
        if (prior) {
          if (prior.kind !== 'CANDIDATE' || prior.actorId !== value.actorId || prior.sessionId !== value.sessionId || prior.artifactId !== value.artifactId || prior.digest !== value.digest || prior.status !== value.status) fail('SECURITY_DECISION_BINDING_CHANGED');
          return prior.id;
        }
        active(run, now);
        if (run.phase !== 'AWAITING_APPROVAL' || run.leaseOwnerId || run.leaseExpiresAt) fail('SECURITY_DECISION_NOT_WAITING');
        await planReceipt(tx, scope, value, now);
        if (await tx.securityRepairDecision.findUnique({ where: { runId_kind_artifactId: { runId: scope.runId, kind: 'CANDIDATE', artifactId: value.artifactId } } })) fail('SECURITY_DECISION_ALREADY_RECORDED');
        const decision = await tx.securityRepairDecision.create({ data: { ...refs(scope), ...value, kind: 'CANDIDATE', expiresAt: new Date(Math.min(now.getTime() + 900_000, run.expiresAt.getTime())), createdAt: now } });
        await event(tx, scope, `decision.${decision.id}.recorded`, value.status === 'APPROVED' ? 'decision.approved' : 'decision.denied', run.phase);
        return decision.id;
      });
    },
    async resolveCandidateDecision(input: SecurityScope, inputFence: SecurityLeaseFence, inputDecisionId: string, inputArtifact: ArtifactReceipt): Promise<'APPROVED' | 'DENIED'> {
      const fence = fenceSchema.parse(inputFence); const decisionId = uuid.parse(inputDecisionId); const receipt = artifactReceiptSchema.parse(inputArtifact);
      return transaction(input, 'DECIDE', async (tx, scope, now) => {
        const run = await getRun(tx, scope); lease(run, fence, now);
        if (!['AWAITING_APPROVAL', 'SNAPSHOTTING', 'CANDIDATE_WORK', 'VERIFYING', 'READY_FOR_RELEASE', 'WAITING_FOR_INPUT'].includes(run.phase)) fail('SECURITY_DECISION_NOT_WAITING');
        const decision = await tx.securityRepairDecision.findFirst({ where: { ...refs(scope), id: decisionId, kind: 'CANDIDATE' } });
        if (!decision || decision.actorId !== run.actorId || decision.sessionId !== run.sessionId || decision.artifactId !== receipt.artifactId || decision.digest !== receipt.digest) fail('SECURITY_DECISION_BINDING_CHANGED');
        if (decision.expiresAt <= now || decision.expiresAt > run.expiresAt) fail('SECURITY_DECISION_EXPIRED');
        await planReceipt(tx, scope, receipt, now);
        if (decision.status !== 'APPROVED' && decision.status !== 'DENIED') fail('SECURITY_DECISION_BINDING_CHANGED');
        return decision.status;
      });
    },
    async recordChangeDecision(input: SecurityScope, inputDecision: z.input<typeof decisionSchema>): Promise<string> {
      if (!options.stagingMutation) fail('UNREGISTERED_SECURITY_EXECUTOR');
      const value = decisionSchema.parse(inputDecision);
      return transaction(input, 'DECIDE', async (tx, scope, now) => {
        const run = await getRun(tx, scope);
        if (run.actorId !== value.actorId || run.sessionId !== value.sessionId) fail('SECURITY_ACTOR_BINDING_CHANGED');
        await stagingAuthority(tx, scope, run, now, 'DECIDE', value);
        const prior = await tx.securityRepairDecision.findUnique({ where: { tenantId_websiteId_environment_runId_requestKey: { ...refs(scope), requestKey: value.requestKey } } });
        if (prior) {
          if (prior.kind !== 'PRODUCTION' || prior.actorId !== value.actorId || prior.sessionId !== value.sessionId || prior.artifactId !== value.artifactId || prior.digest !== value.digest || prior.status !== value.status) fail('SECURITY_DECISION_BINDING_CHANGED');
          return prior.id;
        }
        active(run, now);
        if (run.phase !== 'AWAITING_APPROVAL' || run.leaseOwnerId || run.leaseExpiresAt) fail('SECURITY_DECISION_NOT_WAITING');
        await candidateEffectAuthority(tx, scope, run, now);
        await proposalReceipt(tx, scope, value, now);
        if (await tx.securityRepairAttempt.count({ where: { ...refs(scope), stepKey: 'apply' } })) fail('SECURITY_EFFECT_UNRESOLVED');
        if (await tx.securityRepairDecision.findUnique({ where: { runId_kind_artifactId: { runId: scope.runId, kind: 'PRODUCTION', artifactId: value.artifactId } } })) fail('SECURITY_DECISION_ALREADY_RECORDED');
        const decision = await tx.securityRepairDecision.create({ data: { ...refs(scope), ...value, kind: 'PRODUCTION', expiresAt: new Date(Math.min(now.getTime() + 300_000, run.expiresAt.getTime())), createdAt: now } });
        await event(tx, scope, `decision.${decision.id}.recorded`, value.status === 'APPROVED' ? 'decision.approved' : 'decision.denied', run.phase);
        return decision.id;
      });
    },
    async resolveChangeDecision(input: SecurityScope, inputFence: SecurityLeaseFence, inputDecisionId: string, inputArtifact: ArtifactReceipt): Promise<'APPROVED' | 'DENIED'> {
      if (!options.stagingMutation) fail('UNREGISTERED_SECURITY_EXECUTOR');
      const fence = fenceSchema.parse(inputFence), decisionId = uuid.parse(inputDecisionId), receipt = artifactReceiptSchema.parse(inputArtifact);
      return transaction(input, 'DECIDE', async (tx, scope, now) => {
        const run = await getRun(tx, scope); lease(run, fence, now);
        if (!['AWAITING_APPROVAL', 'APPLYING', 'POST_VERIFYING'].includes(run.phase)) fail('SECURITY_DECISION_NOT_WAITING');
        await stagingAuthority(tx, scope, run, now, 'DECIDE', receipt);
        await proposalReceipt(tx, scope, receipt, now);
        const decision = await tx.securityRepairDecision.findFirst({ where: { ...refs(scope), id: decisionId, kind: 'PRODUCTION' } });
        if (!decision || decision.actorId !== run.actorId || decision.sessionId !== run.sessionId || decision.artifactId !== receipt.artifactId || decision.digest !== receipt.digest) fail('SECURITY_DECISION_BINDING_CHANGED');
        if (decision.expiresAt <= now || decision.expiresAt > run.expiresAt) fail('SECURITY_DECISION_EXPIRED');
        if (decision.status !== 'APPROVED' && decision.status !== 'DENIED') fail('SECURITY_DECISION_BINDING_CHANGED');
        return decision.status;
      });
    },
    async transition(input: SecurityScope, inputFence: SecurityLeaseFence, inputPhase: SecurityPhase, inputCode?: string) {
      const fence = fenceSchema.parse(inputFence); const phase = z.enum(phases).parse(inputPhase); const code = inputCode === undefined ? undefined : codeSchema.parse(inputCode);
      if ((phase === 'APPLYING' || phase === 'POST_VERIFYING') && !options.stagingMutation) fail('UNREGISTERED_SECURITY_EXECUTOR');
      return transaction(input, 'TRANSITION', async (tx, scope, now) => {
        const run = await getRun(tx, scope); lease(run, fence, now);
        if (run.phase === phase && run.errorCode === (code ?? null)) return run;
        if (phase === 'APPLYING') await changeEffectAuthority(tx, scope, run, now);
        if (phase === 'POST_VERIFYING') {
          await stagingAuthority(tx, scope, run, now, 'POST_VERIFY');
          const applied = await tx.securityRepairAttempt.findFirst({ where: { ...refs(scope), stepKey: 'apply', state: 'SUCCEEDED', kind: { in: ['STAGING_WRITE', 'STAGING_RECOVERY'] } } });
          if (!applied?.artifactId || !applied.artifactDigest) fail('SECURITY_MUTATION_NOT_VERIFIED');
          await artifact(tx, scope, { artifactId: applied.artifactId, digest: applied.artifactDigest }, now);
        }
        if (phase === 'COMPLETED' && run.executionProfile === 'MANAGED_STATIC_PERMISSION_V1') {
          const verified = await tx.securityRepairAttempt.findFirst({ where: { ...refs(scope), stepKey: 'post_verify', state: 'SUCCEEDED', kind: 'READ' } });
          if (!verified?.artifactId || !verified.artifactDigest) fail('SECURITY_MUTATION_NOT_VERIFIED');
          const receipt = { artifactId: verified.artifactId, digest: verified.artifactDigest };
          await artifact(tx, scope, receipt, now);
          await stagingAuthority(tx, scope, run, now, 'POST_VERIFY', receipt);
        }
        const outstanding = await tx.securityRepairAttempt.findMany({ where: { ...refs(scope), state: { not: 'SUCCEEDED' } } });
        if (phase !== 'OUTCOME_UNKNOWN' && outstanding.length) fail('SECURITY_EFFECT_UNRESOLVED');
        if (!['FAILED', 'CANCELLED', 'STALE', 'OUTCOME_UNKNOWN'].includes(phase) && !transitions[run.phase as SecurityPhase]?.includes(phase)) fail('SECURITY_TRANSITION_INVALID');
        if (phase === 'OUTCOME_UNKNOWN') await markUnknown(tx, scope, outstanding, now);
        const done = terminal.includes(phase) || phase === 'STALE' || phase === 'OUTCOME_UNKNOWN';
        const updated = await tx.securityRepairRun.update({ where: { id: scope.runId }, data: { phase, errorCode: code ?? null, ...(done ? { leaseOwnerId: null, leaseExpiresAt: null, leaseVersion: { increment: 1 } } : {}) } });
        await event(tx, scope, `phase.${run.eventVersion + 1}`, 'run.transitioned', phase, code);
        return updated;
      });
    },
    async beginStep(input: SecurityScope, inputFence: SecurityLeaseFence, inputStep: z.input<typeof stepSchema>): Promise<{ outcome: 'STARTED'; attemptId: string } | { outcome: 'SUCCEEDED'; artifact: ArtifactReceipt; costMicros: number }> {
      const fence = fenceSchema.parse(inputFence); const step = stepSchema.parse(inputStep);
      if (step.kind === 'PRODUCTION_WRITE' || step.kind === 'RECOVERY_WRITE') fail('UNREGISTERED_SECURITY_EXECUTOR');
      if (step.kind === 'MODEL' && step.reserveMicros === 0) fail('SECURITY_BUDGET_REQUIRED');
      return transaction(input, 'BEGIN_STEP', async (tx, scope, now) => {
        const run = await getRun(tx, scope); lease(run, fence, now);
        const existing = await tx.securityRepairAttempt.findFirst({ where: { ...refs(scope), stepKey: step.stepKey }, orderBy: { attemptNumber: 'desc' } });
        if (existing) {
          if (existing.kind !== step.kind || existing.inputDigest !== step.inputDigest || existing.reserveMicros !== step.reserveMicros) fail('SECURITY_STEP_BINDING_CHANGED');
          if (existing.state !== 'SUCCEEDED' || !existing.artifactId || !existing.artifactDigest || existing.costMicros === null) fail('SECURITY_EFFECT_UNRESOLVED');
          const receipt = { artifactId: existing.artifactId, digest: existing.artifactDigest };
          await artifact(tx, scope, receipt, now);
          return { outcome: 'SUCCEEDED', artifact: receipt, costMicros: existing.costMicros };
        }
        if (step.kind === 'STAGING_WRITE' || step.kind === 'STAGING_RECOVERY') {
          if (step.stepKey !== 'apply' || run.phase !== 'APPLYING') fail('SECURITY_TRANSITION_INVALID');
          await changeEffectAuthority(tx, scope, run, now);
        }
        // Recheck the actual immutable candidate decision in this same admission
        // transaction. Graph entry/readiness checks are not authority to start a
        // new paid/runtime effect after that approval expires. Completed receipts
        // above and result settlement remain available without repeating work.
        if (['snapshot', 'candidate', 'verify', 'proposal'].includes(step.stepKey)) await candidateEffectAuthority(tx, scope, run, now);
        if (await tx.securityRepairAttempt.count({ where: { ...refs(scope), state: { not: 'SUCCEEDED' } } })) fail('SECURITY_EFFECT_UNRESOLVED');
        if (await tx.securityRepairAttempt.count({ where: refs(scope) }) >= 64) fail('SECURITY_JOURNAL_LIMIT');
        if (run.reservedMicros + run.chargedMicros + step.reserveMicros > run.allowanceMicros) fail('SECURITY_BUDGET_EXCEEDED');
        const attempt = await tx.securityRepairAttempt.create({ data: { ...refs(scope), ...step, leaseVersion: fence.version } });
        await tx.securityRepairRun.update({ where: { id: scope.runId }, data: { reservedMicros: { increment: step.reserveMicros } } });
        await tx.securityRepairCostEntry.create({ data: { ...refs(scope), attemptId: attempt.id, kind: 'RESERVE', reservedDeltaMicros: step.reserveMicros, chargedDeltaMicros: 0 } });
        await event(tx, scope, `step.${attempt.id}.started`, 'step.started', run.phase);
        return { outcome: 'STARTED', attemptId: attempt.id };
      });
    },
    async completeStep(input: SecurityScope, inputFence: SecurityLeaseFence, inputAttemptId: string, inputReceipt: z.input<typeof receiptSchema>) {
      const fence = fenceSchema.parse(inputFence); const attemptId = uuid.parse(inputAttemptId); const receipt = receiptSchema.parse(inputReceipt);
      const result = await transaction(input, 'COMPLETE_STEP', async (tx, scope, now) => {
        const run = await getRun(tx, scope); lease(run, fence, now);
        const attempt = await tx.securityRepairAttempt.findFirst({ where: { ...refs(scope), id: attemptId } });
        if (!attempt) fail('SECURITY_ATTEMPT_NOT_FOUND');
        if (attempt.kind === 'PRODUCTION_WRITE' || attempt.kind === 'RECOVERY_WRITE') fail('UNREGISTERED_SECURITY_EXECUTOR');
        if (attempt.kind === 'STAGING_WRITE' || attempt.kind === 'STAGING_RECOVERY') await stagingAuthority(tx, scope, run, now, 'SETTLE', receipt);
        await artifact(tx, scope, receipt, now);
        if (attempt.state === 'SUCCEEDED') {
          if (attempt.artifactId !== receipt.artifactId || attempt.artifactDigest !== receipt.digest || attempt.costMicros !== receipt.costMicros) fail('SECURITY_RECEIPT_BINDING_CHANGED');
          return { attempt, budgetExceeded: false };
        }
        if (attempt.state !== 'STARTED' || attempt.leaseVersion !== fence.version) fail('SECURITY_EFFECT_UNRESOLVED');
        const budgetExceeded = receipt.costMicros > attempt.reserveMicros;
        const updated = await tx.securityRepairAttempt.update({ where: { id: attempt.id }, data: { state: 'SUCCEEDED', artifactId: receipt.artifactId, artifactDigest: receipt.digest, costMicros: receipt.costMicros, completedAt: now } });
        await tx.securityRepairRun.update({ where: { id: scope.runId }, data: { reservedMicros: { decrement: attempt.reserveMicros }, chargedMicros: { increment: receipt.costMicros }, ...(budgetExceeded ? { phase: 'FAILED', errorCode: 'SECURITY_BUDGET_EXCEEDED', leaseOwnerId: null, leaseExpiresAt: null, leaseVersion: { increment: 1 } } : {}) } });
        await tx.securityRepairCostEntry.create({ data: { ...refs(scope), attemptId: attempt.id, kind: 'SETTLE', reservedDeltaMicros: -attempt.reserveMicros, chargedDeltaMicros: receipt.costMicros } });
        await event(tx, scope, `step.${attempt.id}.completed`, 'step.completed', budgetExceeded ? 'FAILED' : run.phase, budgetExceeded ? 'SECURITY_BUDGET_EXCEEDED' : undefined);
        if (budgetExceeded) await event(tx, scope, `step.${attempt.id}.overrun`, 'run.failed', 'FAILED', 'SECURITY_BUDGET_EXCEEDED');
        return { attempt: updated, budgetExceeded };
      });
      // Throw only after commit: rolling back here would erase known provider cost.
      if (result.budgetExceeded) fail('SECURITY_BUDGET_EXCEEDED');
      return result.attempt;
    },
    async stopRun(input: SecurityScope, inputActor: { actorId: string; sessionId: string }) {
      const actor = z.object({ actorId: uuid, sessionId: uuid }).strict().parse(inputActor);
      return transaction(input, 'STOP', async (tx, scope, now) => {
        const run = await getRun(tx, scope);
        if (run.actorId !== actor.actorId || run.sessionId !== actor.sessionId) fail('SECURITY_ACTOR_BINDING_CHANGED');
        if (terminal.includes(run.phase) || run.phase === 'OUTCOME_UNKNOWN') return run;
        const attempts = await tx.securityRepairAttempt.findMany({ where: { ...refs(scope), state: { not: 'SUCCEEDED' } } });
        const phase = attempts.length ? 'OUTCOME_UNKNOWN' : 'CANCELLED';
        if (attempts.length) await markUnknown(tx, scope, attempts, now);
        const updated = await tx.securityRepairRun.update({ where: { id: scope.runId }, data: { phase, errorCode: attempts.length ? 'SECURITY_EFFECT_UNRESOLVED' : 'SECURITY_CANCELLED', leaseOwnerId: null, leaseExpiresAt: null, leaseVersion: { increment: 1 } } });
        await event(tx, scope, 'run.stopped', 'run.stopped', phase, updated.errorCode ?? undefined);
        return updated;
      });
    },
    async recoverExpired(input: SecurityScope) {
      return transaction(input, 'OBSERVE', async (tx, scope, now) => {
        const run = await getRun(tx, scope);
        const unfinishedAttempts = await tx.securityRepairAttempt.count({ where: { ...refs(scope), state: { not: 'SUCCEEDED' } } });
        return { phase: run.phase, expiredLease: !!run.leaseExpiresAt && run.leaseExpiresAt <= now, authorityExpired: run.expiresAt <= now, unfinishedAttempts, reservedMicros: run.reservedMicros, chargedMicros: run.chargedMicros, replayAllowed: false as const };
      });
    }
  };
}
