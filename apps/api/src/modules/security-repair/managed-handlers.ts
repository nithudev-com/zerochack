import { createDecipheriv, createHash, createHmac, randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient, SecurityRepairRun } from '@prisma/client';
import type { Environment } from '@zerochack/config';
import { artifactReceiptSchema, manifestDigest, scopeSchema, sha256, SecurityWorkflowError, uuid, type ArtifactReceipt, type SecurityStepResult, type SecurityWorkStep } from '@zerochack/security-orchestration';
import { z } from 'zod';
import { buildRecoveryExportPermitPayload, createManagedTargetBroker, type ManagedAccess, type ManagedBinding, type ManagedBroker, type ManagedPrepared, type ManagedSnapshot } from '../../../../../infrastructure/security-managed-target/broker.cjs';
import { readArtifact, writeArtifact } from '../care/repair-service.js';
import type { SecurityControllerAuthority, SecurityControllerStep, SecurityStepContext } from './controller.js';
import { SECURITY_MANAGED_ADAPTER, securityAdmissionSchema, securityProductEvidenceSchema, type SecurityRepairAdmission } from './product-contracts.js';

export type ManagedSecurityRuntime = { access: ManagedAccess; permitKey: Buffer; recoveryKey: Buffer };
export type ManagedSecurityDependencies = {
  database: PrismaClient; environment: Environment; authorize: SecurityControllerAuthority;
  /** Trusted operator composition, never customer/model input. Reload the vault
   * grant and exact enrolled signer key on each invocation; return owned buffers. */
  resolveRuntime(admission: SecurityRepairAdmission): Promise<ManagedSecurityRuntime>;
  /** Internal test seam. The default uses pinned public-IP SSH and literal exec. */
  brokerFactory?: typeof createManagedTargetBroker;
};
const numberString = z.string().regex(/^(0|[1-9][0-9]{0,23})$/u);
export const managedSnapshotSchema = z.object({ device: numberString, inode: numberString, uid: z.literal(0), gid: z.literal(0), mode: z.number().int().min(0).max(0o666), size: z.number().int().min(0).max(200000), mtimeNs: numberString, ctimeNs: numberString, digest: sha256 }).strict().refine(s => (s.mode & ~0o666) === 0 && (s.mode & 0o604) === 0o604);
const managedBindingSchema = z.object({ scope: scopeSchema.extend({ environment: z.literal('STAGING') }).strict(), namespaceId: uuid, targetId: uuid }).strict();
const preparedFields = managedBindingSchema.extend({ adapter: z.literal(SECURITY_MANAGED_ADAPTER), operationId: uuid, action: z.enum(['HARDEN', 'RESTORE']), planDigest: sha256, authorityDigest: sha256, snapshotDigest: sha256, recoveryDigest: sha256, challenge: sha256, preparedAt: z.number().int().nonnegative(), before: managedSnapshotSchema, targetMode: z.number().int().min(0).max(0o666) });
export const managedPreparedSchema = preparedFields.extend({ state: z.literal('PREPARED') }).strict();
export const managedResultSchema = preparedFields.extend({ state: z.literal('VERIFIED'), after: managedSnapshotSchema, verifiedAt: z.number().int().nonnegative() }).strict();
const recoveryEnvelopeSchema = z.object({ version: z.literal(1), algorithm: z.literal('AES-256-GCM'), aad: z.object({ protocol: z.literal(1), scope: scopeSchema.extend({ environment: z.literal('STAGING') }).strict(), namespaceId: uuid, targetId: uuid, operationId: uuid, snapshotDigest: sha256 }).strict(), iv: z.string().regex(/^[A-Za-z0-9+/]{16}$/u), ciphertext: z.string().min(1).max(533336).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u), tag: z.string().regex(/^[A-Za-z0-9+/]{22}==$/u) }).strict();
const stageSchema = z.enum(['plan', 'snapshot', 'candidate', 'verify', 'proposal', 'apply', 'post_verify']);
export const managedSecurityArtifactSchema = z.object({
  public: securityProductEvidenceSchema,
  private: z.object({ version: z.literal(1), scope: scopeSchema.extend({ environment: z.literal('STAGING') }).strict(), admissionDigest: sha256, stage: stageSchema, executor: managedBindingSchema, before: managedSnapshotSchema,
    plan: artifactReceiptSchema.optional(), prepared: managedPreparedSchema.optional(), result: managedResultSchema.optional(), previous: artifactReceiptSchema.optional(), recoveryEnvelope: recoveryEnvelopeSchema.optional(), recoverySource: artifactReceiptSchema.optional(), recoveryOperationId: uuid.optional()
  }).strict()
}).strict();
export type ManagedSecurityArtifact = z.infer<typeof managedSecurityArtifactSchema>;
function validateEvidence(value: ManagedSecurityArtifact, admission: SecurityRepairAdmission) {
  const operation = admission.operation;
  const binding = { scope: { ...admission.scope, runId: operation === 'RESTORE' ? admission.recoveryRunId! : admission.scope.runId }, namespaceId: admission.enrollment.namespaceId, targetId: admission.enrollment.targetId };
  const { before, prepared, result, recoveryEnvelope, plan } = value.private;
  if (!equal(value.private.executor, binding) || value.public.change.action !== operation || value.public.change.beforeMode !== before.mode || value.public.change.afterMode !== targetMode(before, operation) || value.public.change.contentDigest !== before.digest || value.public.change.preimageDigest !== manifestDigest(before)) fail('SECURITY_ARTIFACT_BINDING_CHANGED');
  if (prepared && (!equal({ scope: prepared.scope, namespaceId: prepared.namespaceId, targetId: prepared.targetId }, binding) || prepared.action !== operation || prepared.authorityDigest !== admission.authorityDigest || !equal(prepared.before, before) || prepared.snapshotDigest !== manifestDigest(before) || prepared.targetMode !== targetMode(before, operation) || !plan || prepared.planDigest !== plan.digest || value.public.recovery.digest !== prepared.recoveryDigest)) fail('SECURITY_ARTIFACT_BINDING_CHANGED');
  if (recoveryEnvelope && (!prepared || createHash('sha256').update(canonicalPermit(recoveryEnvelope)).digest('hex') !== prepared.recoveryDigest || !equal(recoveryEnvelope.aad, { protocol: 1, ...binding, operationId: prepared.operationId, snapshotDigest: prepared.snapshotDigest }))) fail('SECURITY_RECOVERY_INTEGRITY');
  if (result) {
    const actual = { ...result } as Record<string, unknown>; delete actual.state; delete actual.after; delete actual.verifiedAt;
    const expected = { ...prepared } as Record<string, unknown>; delete expected.state;
    if (!prepared || !equal(actual, expected) || !equal(result.after, { ...before, mode: prepared.targetMode, ctimeNs: result.after.ctimeNs })) fail('SECURITY_RESULT_BINDING_CHANGED');
  }
}
const fail = (value: string): never => { throw new SecurityWorkflowError(value); };
const equal = (left: unknown, right: unknown) => manifestDigest(left) === manifestDigest(right);
const targetMode = (before: ManagedSnapshot, operation: 'HARDEN' | 'RESTORE') => operation === 'HARDEN' ? before.mode & ~0o002 : before.mode | 0o002;

/** Decode only exact immutable security evidence, never arbitrary Care artifacts. */
export async function readManagedSecurityArtifact(tx: Prisma.TransactionClient, admission: SecurityRepairAdmission, receipt: ArtifactReceipt, environment: Environment, expectedStage?: SecurityWorkStep): Promise<ManagedSecurityArtifact> {
  const checked = artifactReceiptSchema.parse(receipt);
  const record = await tx.careArtifact.findFirst({ where: { id: checked.artifactId, tenantId: admission.scope.tenantId, websiteId: admission.scope.websiteId, environment: 'STAGING', kind: 'SECURITY_EVIDENCE', status: 'ACCEPTED', digest: checked.digest } });
  if (!record) fail('SECURITY_ARTIFACT_UNAVAILABLE');
  let parsed: ManagedSecurityArtifact;
  try { parsed = managedSecurityArtifactSchema.parse(JSON.parse(readArtifact(record!, environment).toString('utf8'))); }
  catch { return fail('SECURITY_ARTIFACT_INTEGRITY'); }
  if (!equal(parsed.private.scope, admission.scope) || parsed.private.admissionDigest !== manifestDigest(admission) || expectedStage && parsed.private.stage !== expectedStage || parsed.public.enrollmentId !== admission.enrollment.id || parsed.public.enrollmentRevision !== admission.enrollment.revision) fail('SECURITY_ARTIFACT_BINDING_CHANGED');
  validateEvidence(parsed, admission);
  return parsed;
}

/** A deterministic, single-profile implementation. It has no model, shell,
 * customer-selected path, SFTP fallback, dependency install or production write. */
export function createManagedSecurityControllerSteps(input: SecurityRepairAdmission, dependencies: ManagedSecurityDependencies): Record<SecurityWorkStep, SecurityControllerStep> {
  const admission = securityAdmissionSchema.parse(input);
  const operation = admission.operation;
  const admissionHash = manifestDigest(admission);
  const actor = admission.actorId;
  const refs = { tenantId: admission.scope.tenantId, websiteId: admission.scope.websiteId, environment: 'STAGING', runId: admission.scope.runId };
  const executor: ManagedBinding = { scope: { ...admission.scope, runId: operation === 'RESTORE' ? admission.recoveryRunId! : admission.scope.runId }, namespaceId: admission.enrollment.namespaceId, targetId: admission.enrollment.targetId };
  if (operation === 'RESTORE' && (!admission.recoveryRunId || admission.recoveryRunId === admission.scope.runId)) fail('SECURITY_RECOVERY_BINDING_INVALID');
  const phases = { plan: 'PLANNING', snapshot: 'SNAPSHOTTING', candidate: 'CANDIDATE_WORK', verify: 'VERIFYING', proposal: 'READY_FOR_RELEASE', apply: 'APPLYING', post_verify: 'POST_VERIFYING' } as const;
  const metadata = { reserveMicros: 0, timeoutMs: 110000, implementationId: 'managed-static-permission', implementationVersion: '1', implementationDigest: admission.implementationDigest };
  async function transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) { return dependencies.database.$transaction(fn, { maxWait: 2000, timeout: 5000 }); }
  async function current(tx: Prisma.TransactionClient, ctx: SecurityStepContext, step: SecurityWorkStep) {
    if (ctx.signal.aborted || !equal(ctx.scope, admission.scope)) fail('SECURITY_CONTROLLER_STOPPED');
    await tx.$queryRaw`SELECT id FROM websites WHERE id=${admission.scope.websiteId}::uuid AND tenant_id=${admission.scope.tenantId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM security_repair_runs WHERE id=${admission.scope.runId}::uuid AND tenant_id=${admission.scope.tenantId}::uuid AND website_id=${admission.scope.websiteId}::uuid FOR UPDATE`;
    const run = await tx.securityRepairRun.findFirst({ where: { id: admission.scope.runId, tenantId: admission.scope.tenantId, websiteId: admission.scope.websiteId, environment: 'STAGING' } });
    if (!run || run.actorId !== actor || run.sessionId !== admission.sessionId || run.authorityDigest !== admission.authorityDigest) fail('SECURITY_ACTOR_BINDING_CHANGED');
    await dependencies.authorize(tx, admission.scope, 'READINESS', run);
    const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]?.now;
    if (!now || run!.expiresAt <= now || new Date(admission.expiresAt) <= now || ['CANCELLED', 'FAILED', 'STALE', 'OUTCOME_UNKNOWN', 'COMPLETED'].includes(run!.phase) || run!.leaseOwnerId !== ctx.fence.ownerId || run!.leaseVersion !== ctx.fence.version || !run!.leaseExpiresAt || run!.leaseExpiresAt <= now) fail('SECURITY_LEASE_LOST');
    const attempt = await tx.securityRepairAttempt.findFirst({ where: { ...refs, id: ctx.attemptId, stepKey: step, state: 'STARTED' } });
    if (!attempt || run!.phase !== phases[step] || attempt.kind !== (step === 'apply' ? operation === 'RESTORE' ? 'STAGING_RECOVERY' : 'STAGING_WRITE' : 'READ')) fail('SECURITY_EFFECT_BINDING_CHANGED');
    if (await tx.securityRepairAttempt.count({ where: { ...refs, id: { not: ctx.attemptId }, state: { not: 'SUCCEEDED' } } })) fail('SECURITY_EFFECT_UNRESOLVED');
    const expiries = [run!.expiresAt.getTime(), run!.leaseExpiresAt!.getTime(), new Date(admission.expiresAt).getTime()];
    if (step !== 'plan') expiries.push((await exactApproval(tx, run!, 'CANDIDATE', 'plan')).getTime());
    if (step === 'apply' || step === 'post_verify') expiries.push((await exactApproval(tx, run!, 'PRODUCTION', 'proposal', step === 'apply' ? ctx.previous : undefined)).getTime());
    // Receipt reads, decryption and locks can take time. Refresh the database
    // clock after all exact decisions have been checked, then bind the remote
    // permit to the earliest approval/lease/run/admission deadline.
    const checkedAt = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]?.now;
    const authorityExpiresAt = new Date(Math.min(...expiries));
    if (!checkedAt || !Number.isFinite(checkedAt.getTime()) || !Number.isFinite(authorityExpiresAt.getTime()) || authorityExpiresAt <= checkedAt) fail('SECURITY_DECISION_EXPIRED');
    return { run: run!, now: checkedAt, authorityExpiresAt };
  }
  async function exactApproval(tx: Prisma.TransactionClient, run: SecurityRepairRun, kind: 'CANDIDATE' | 'PRODUCTION', step: 'plan' | 'proposal', expected?: ArtifactReceipt) {
    const attempt = await tx.securityRepairAttempt.findFirst({ where: { ...refs, stepKey: step }, orderBy: { attemptNumber: 'desc' } });
    if (!attempt || attempt.state !== 'SUCCEEDED' || !attempt.artifactId || !attempt.artifactDigest || expected && (expected.artifactId !== attempt.artifactId || expected.digest !== attempt.artifactDigest)) fail('SECURITY_DECISION_RECEIPT_CHANGED');
    const receipt = { artifactId: attempt!.artifactId!, digest: attempt!.artifactDigest! };
    await readManagedSecurityArtifact(tx, admission, receipt, dependencies.environment, step);
    const decision = await tx.securityRepairDecision.findFirst({ where: { ...refs, kind, artifactId: receipt.artifactId } });
    if (!decision || decision.status !== 'APPROVED' || decision.actorId !== run.actorId || decision.sessionId !== run.sessionId || decision.digest !== receipt.digest) fail('SECURITY_DECISION_BINDING_CHANGED');
    const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]?.now;
    if (!now || !Number.isFinite(now.getTime()) || !(decision!.expiresAt instanceof Date) || !Number.isFinite(decision!.expiresAt.getTime()) || decision!.expiresAt <= now || decision!.expiresAt > run.expiresAt) fail('SECURITY_DECISION_EXPIRED');
    return new Date(decision!.expiresAt);
  }
  async function assert(ctx: SecurityStepContext, step: SecurityWorkStep) { await ctx.assertCurrent(); await transaction(tx => current(tx, ctx, step)); if (ctx.signal.aborted) fail('SECURITY_CONTROLLER_STOPPED'); }
  async function previous(ctx: SecurityStepContext, stage: SecurityWorkStep) { if (!ctx.previous) return fail('SECURITY_ARTIFACT_UNAVAILABLE'); return transaction(tx => readManagedSecurityArtifact(tx, admission, ctx.previous!, dependencies.environment, stage)); }
  async function store(ctx: SecurityStepContext, step: SecurityWorkStep, value: ManagedSecurityArtifact): Promise<SecurityStepResult> {
    const parsed = managedSecurityArtifactSchema.parse(value);
    validateEvidence(parsed, admission);
    const artifact = await transaction(async tx => { await current(tx, ctx, step); return writeArtifact(tx, { tenantId: admission.scope.tenantId, websiteId: admission.scope.websiteId, environment: 'STAGING', jobId: null, createdBy: actor }, Buffer.from(JSON.stringify(parsed)), 'SECURITY_EVIDENCE', `security-${step}.json`, 'application/json', dependencies.environment); });
    return { outcome: 'SUCCEEDED', artifact: { artifactId: artifact.id, digest: artifact.digest }, costMicros: 0 };
  }
  function evidence(stage: SecurityWorkStep, before: ManagedSnapshot, inherited?: ManagedSecurityArtifact): ManagedSecurityArtifact {
    const prepared = inherited?.private.prepared;
    return { public: { version: 1, kind: stage === 'plan' ? 'PLAN' : ['apply', 'post_verify'].includes(stage) ? 'RESULT' : 'PROPOSAL', adapter: SECURITY_MANAGED_ADAPTER, summary: operation === 'HARDEN' ? 'Remove only the other-write permission from the enrolled staging static file; preserve its content and identity.' : 'Restore only the previously changed other-write permission using the retained, verified recovery for this enrolled staging file.', environment: 'STAGING', enrollmentId: admission.enrollment.id, enrollmentRevision: admission.enrollment.revision,
      change: { action: operation, targetLabel: admission.enrollment.label, beforeMode: before.mode, afterMode: targetMode(before, operation), contentDigest: before.digest, preimageDigest: manifestDigest(before) }, recovery: { digest: prepared?.recoveryDigest ?? manifestDigest(before), encrypted: true, verified: Boolean(prepared) }, checks: [] },
      private: { ...inherited?.private, version: 1, scope: admission.scope, admissionDigest: admissionHash, stage, executor, before } };
  }
  async function withBroker<T>(ctx: SecurityStepContext, step: SecurityWorkStep, work: (broker: ManagedBroker, runtime: ManagedSecurityRuntime) => Promise<T>, expectedPrepared?: ManagedPrepared): Promise<T> {
    await assert(ctx, step);
    const runtime = await dependencies.resolveRuntime(admission);
    if (!Buffer.isBuffer(runtime.permitKey) || runtime.permitKey.length !== 32 || !Buffer.isBuffer(runtime.recoveryKey) || runtime.recoveryKey.length !== 32 || runtime.permitKey.equals(runtime.recoveryKey) || !Buffer.isBuffer(runtime.access.privateKey) || runtime.access.hostKeyFingerprint !== admission.enrollment.hostKeyFingerprint || runtime.access.username !== 'codebandage-managed-target') { if (Buffer.isBuffer(runtime.access.privateKey)) runtime.access.privateKey.fill(0); if (Buffer.isBuffer(runtime.permitKey)) runtime.permitKey.fill(0); if (Buffer.isBuffer(runtime.recoveryKey)) runtime.recoveryKey.fill(0); fail('SECURITY_RUNTIME_BINDING_CHANGED'); }
    try {
      await assert(ctx, step);
      const broker = (dependencies.brokerFactory ?? createManagedTargetBroker)(runtime.access, { authorizeAndIssuePermit: async (prepared, signal) => {
        if (signal?.aborted || step !== 'apply' || !expectedPrepared || !equal(prepared, expectedPrepared) || !equal({ scope: prepared.scope, namespaceId: prepared.namespaceId, targetId: prepared.targetId }, executor) || prepared.action !== operation || prepared.authorityDigest !== admission.authorityDigest) fail('SECURITY_PERMIT_BINDING_CHANGED');
        await ctx.assertCurrent();
        const checked = await transaction(async tx => {
          const state = await current(tx, ctx, 'apply');
          const proposal = await readManagedSecurityArtifact(tx, admission, ctx.previous!, dependencies.environment, 'proposal');
          if (!equal(proposal.private.prepared, prepared) || !proposal.public.recovery.verified || !proposal.private.recoveryEnvelope) fail('SECURITY_RECOVERY_UNAVAILABLE');
          verifyManagedRecovery(proposal.private.recoveryEnvelope!, prepared, runtime.recoveryKey);
          return state;
        });
        const issuedAt = checked.now!.getTime();
        if (ctx.signal.aborted || signal?.aborted || issuedAt < prepared.preparedAt || Math.abs(Date.now() - issuedAt) > 2000 || checked.authorityExpiresAt.getTime() <= Date.now()) fail('SECURITY_PERMIT_EXPIRED');
        const payload = { version: 1, adapter: prepared.adapter, scope: prepared.scope, namespaceId: prepared.namespaceId, targetId: prepared.targetId, operationId: prepared.operationId, action: prepared.action, planDigest: prepared.planDigest, authorityDigest: prepared.authorityDigest, snapshotDigest: prepared.snapshotDigest, recoveryDigest: prepared.recoveryDigest, targetMode: prepared.targetMode, challenge: prepared.challenge, issuedAt, expiresAt: Math.min(issuedAt + 5000, checked.authorityExpiresAt.getTime()) };
        if (payload.expiresAt <= issuedAt) fail('SECURITY_PERMIT_EXPIRED');
        return { payload, mac: createHmac('sha256', runtime.permitKey).update(canonicalPermit(payload)).digest('hex') };
      }, authorizeAndIssueRecoveryExportPermit: async ({ prepared, exportId }, signal) => {
        if (signal?.aborted || step !== 'snapshot' || !expectedPrepared || !equal(prepared, expectedPrepared) || !equal({ scope: prepared.scope, namespaceId: prepared.namespaceId, targetId: prepared.targetId }, executor) || prepared.action !== operation || prepared.authorityDigest !== admission.authorityDigest || prepared.planDigest !== ctx.previous?.digest || prepared.operationId !== ctx.attemptId) fail('SECURITY_PERMIT_BINDING_CHANGED');
        await ctx.assertCurrent();
        const checked = await transaction(tx => current(tx, ctx, 'snapshot'));
        const issuedAt = checked.now!.getTime();
        if (ctx.signal.aborted || signal?.aborted || issuedAt < prepared.preparedAt || Math.abs(Date.now() - issuedAt) > 2000 || checked.authorityExpiresAt.getTime() <= Date.now()) fail('SECURITY_PERMIT_EXPIRED');
        const expiresAt = Math.min(issuedAt + 5000, checked.authorityExpiresAt.getTime());
        if (expiresAt <= issuedAt) fail('SECURITY_PERMIT_EXPIRED');
        const payload = buildRecoveryExportPermitPayload(prepared, exportId, issuedAt, expiresAt);
        return { payload, mac: createHmac('sha256', runtime.permitKey).update(canonicalPermit(payload)).digest('hex') };
      } });
      return await work(broker, runtime);
    } finally { runtime.access.privateKey.fill(0); runtime.permitKey.fill(0); runtime.recoveryKey.fill(0); }
  }
  async function recoveryOrigin(tx: Prisma.TransactionClient) {
    const sourceRun = await tx.securityRepairRun.findFirst({ where: { id: admission.recoveryRunId!, tenantId: admission.scope.tenantId, websiteId: admission.scope.websiteId, environment: 'STAGING', phase: 'COMPLETED', actorId: actor } });
    const attempt = await tx.securityRepairAttempt.findFirst({ where: { ...refs, runId: admission.recoveryRunId!, stepKey: 'post_verify', state: 'SUCCEEDED' }, orderBy: { attemptNumber: 'desc' } });
    if (!sourceRun || !attempt?.artifactId || !attempt.artifactDigest) return fail('SECURITY_RECOVERY_UNAVAILABLE');
    const record = await tx.careArtifact.findFirst({ where: { id: attempt.artifactId, tenantId: admission.scope.tenantId, websiteId: admission.scope.websiteId, environment: 'STAGING', kind: 'SECURITY_EVIDENCE', digest: attempt.artifactDigest, status: 'ACCEPTED' } });
    if (!record) return fail('SECURITY_RECOVERY_UNAVAILABLE');
    if (!sourceRun.admissionArtifactId || !sourceRun.admissionDigest || sourceRun.executionProfile !== SECURITY_MANAGED_ADAPTER) return fail('SECURITY_RECOVERY_BINDING_CHANGED');
    const admitted = await tx.careArtifact.findFirst({ where: { id: sourceRun.admissionArtifactId, tenantId: admission.scope.tenantId, websiteId: admission.scope.websiteId, environment: 'STAGING', kind: 'SEC_ADMISSION', digest: sourceRun.admissionDigest, status: 'ACCEPTED' } });
    if (!admitted) return fail('SECURITY_RECOVERY_UNAVAILABLE');
    let source: ManagedSecurityArtifact;
    try {
      const sourceAdmission = securityAdmissionSchema.parse(JSON.parse(readArtifact(admitted, dependencies.environment).toString('utf8')));
      if (sourceAdmission.operation !== 'HARDEN' || sourceAdmission.scope.runId !== sourceRun.id || sourceAdmission.actorId !== actor || !equal(sourceAdmission.enrollment, admission.enrollment)) return fail('SECURITY_RECOVERY_BINDING_CHANGED');
      source = managedSecurityArtifactSchema.parse(JSON.parse(readArtifact(record, dependencies.environment).toString('utf8')));
      if (source.private.admissionDigest !== manifestDigest(sourceAdmission)) return fail('SECURITY_RECOVERY_BINDING_CHANGED');
      validateEvidence(source, sourceAdmission);
    } catch { return fail('SECURITY_RECOVERY_INTEGRITY'); }
    if (source.private.scope.runId !== admission.recoveryRunId || source.private.scope.tenantId !== admission.scope.tenantId || source.private.scope.websiteId !== admission.scope.websiteId || source.private.stage !== 'post_verify' || source.public.change.action !== 'HARDEN' || source.public.enrollmentId !== admission.enrollment.id || source.public.enrollmentRevision !== admission.enrollment.revision || !source.private.result?.after || !source.private.recoveryEnvelope || !equal(source.private.executor, executor)) fail('SECURITY_RECOVERY_BINDING_CHANGED');
    return { source, receipt: { artifactId: attempt.artifactId, digest: attempt.artifactDigest } };
  }
  const handler = (step: SecurityWorkStep, execute: SecurityControllerStep['execute']): SecurityControllerStep => ({ ...metadata, kind: step === 'apply' ? operation === 'RESTORE' ? 'STAGING_RECOVERY' : 'STAGING_WRITE' : 'READ',
    async readiness({ tx, run, scope }) { if (!equal(scope, admission.scope)) fail('SECURITY_SCOPE_DENIED'); await dependencies.authorize(tx, scope, 'READINESS', run); return { ready: true }; }, execute });
  const steps: Record<SecurityWorkStep, SecurityControllerStep> = {
    plan: handler('plan', async ctx => {
      const origin = operation === 'RESTORE' ? await transaction(recoveryOrigin) : undefined;
      const observed = await withBroker(ctx, 'plan', async (broker, runtime) => {
        if (origin) verifyManagedRecovery(origin.source.private.recoveryEnvelope, origin.source.private.prepared!, runtime.recoveryKey);
        return broker.observe(executor, ctx.signal);
      });
      const before = managedSnapshotSchema.parse(observed.snapshot);
      if (observed.snapshotDigest !== manifestDigest(before) || targetMode(before, operation) === before.mode) fail('SECURITY_TARGET_NOT_APPLICABLE');
      if (origin && !equal(origin.source.private.result!.after, before)) fail('SECURITY_TARGET_DRIFT');
      const value = evidence('plan', before);
      value.public.checks = [{ name: 'Enrolled target identity and content observed', passed: true }];
      if (origin) { value.private.recoverySource = origin.receipt; value.private.recoveryOperationId = origin.source.private.result!.operationId; }
      return store(ctx, 'plan', value);
    }),
    snapshot: handler('snapshot', async ctx => {
      const prior = await previous(ctx, 'plan');
      const prepared = await withBroker(ctx, 'snapshot', broker => broker.prepare({ ...executor, operationId: ctx.attemptId, planDigest: ctx.previous!.digest, authorityDigest: admission.authorityDigest, expectedSnapshot: prior.private.before, ...(operation === 'RESTORE' ? { action: 'RESTORE' as const, recoveryOperationId: prior.private.recoveryOperationId! } : { action: 'HARDEN' as const }) }, ctx.signal));
      managedPreparedSchema.parse(prepared);
      if (!equal(prepared.before, prior.private.before) || !equal({ scope: prepared.scope, namespaceId: prepared.namespaceId, targetId: prepared.targetId }, executor) || prepared.planDigest !== ctx.previous!.digest || prepared.authorityDigest !== admission.authorityDigest || prepared.action !== operation || prepared.targetMode !== targetMode(prior.private.before, operation)) fail('SECURITY_PREPARATION_BINDING_CHANGED');
      // EXPORT_RECOVERY verifies the helper's encrypted bytes before releasing a copy.
      const recovery = await withBroker(ctx, 'snapshot', async (broker, runtime) => {
        const exported = await broker.exportRecovery(prepared, randomUUID(), ctx.signal);
        verifyManagedRecovery(exported.envelope, prepared, runtime.recoveryKey);
        return exported;
      }, prepared);
      if (recovery.recoveryDigest !== prepared.recoveryDigest || !equal(recovery.envelope.aad.scope, executor.scope) || recovery.envelope.aad.operationId !== prepared.operationId || recovery.envelope.aad.snapshotDigest !== prepared.snapshotDigest) fail('SECURITY_RECOVERY_INTEGRITY');
      const value = evidence('snapshot', prior.private.before, prior);
      value.private = { ...value.private, plan: ctx.previous!, prepared, previous: ctx.previous!, recoveryEnvelope: recovery.envelope };
      value.public.recovery = { digest: prepared.recoveryDigest, encrypted: true, verified: true };
      value.public.checks = [{ name: 'Encrypted recovery created, read back and verified by the bound helper', passed: true }];
      return store(ctx, 'snapshot', value);
    }),
    candidate: handler('candidate', async ctx => {
      await assert(ctx, 'candidate'); const prior = await previous(ctx, 'snapshot');
      if (!prior.private.prepared || !prior.private.recoveryEnvelope) fail('SECURITY_RECOVERY_UNAVAILABLE');
      const value = evidence('candidate', prior.private.before, prior); value.private.previous = ctx.previous!;
      value.public.checks = [{ name: 'Exact permission-only candidate; file contents and identity preserved', passed: true }];
      return store(ctx, 'candidate', value);
    }),
    verify: handler('verify', async ctx => {
      const prior = await previous(ctx, 'candidate');
      const observed = await withBroker(ctx, 'verify', broker => broker.observe(executor, ctx.signal));
      if (!equal(observed.snapshot, prior.private.before) || observed.snapshotDigest !== manifestDigest(prior.private.before)) fail('SECURITY_TARGET_DRIFT');
      const value = evidence('verify', prior.private.before, prior); value.private.previous = ctx.previous!;
      value.public.checks = [...prior.public.checks, { name: 'Current enrolled preimage still matches the exact candidate', passed: true }];
      return store(ctx, 'verify', value);
    }),
    proposal: handler('proposal', async ctx => {
      await assert(ctx, 'proposal'); const prior = await previous(ctx, 'verify');
      const value = evidence('proposal', prior.private.before, prior); value.private.previous = ctx.previous!; value.public.checks = prior.public.checks;
      return store(ctx, 'proposal', value);
    }),
    apply: handler('apply', async ctx => {
      const prior = await previous(ctx, 'proposal'); const prepared = managedPreparedSchema.parse(prior.private.prepared);
      if (!prior.private.recoveryEnvelope || !prior.public.recovery.verified) fail('SECURITY_RECOVERY_UNAVAILABLE');
      // Never retry COMMIT. A timeout, cancellation or lost acknowledgement leaves
      // this STARTED journal attempt unresolved for separate observation.
      const result = managedResultSchema.parse(await withBroker(ctx, 'apply', broker => broker.commit(prepared, ctx.signal), prepared));
      const resultBinding = { ...result } as Record<string, unknown>;
      delete resultBinding.after; delete resultBinding.verifiedAt; delete resultBinding.state;
      const originalBinding = { ...prepared } as Record<string, unknown>; delete originalBinding.state;
      if (!equal(resultBinding, originalBinding)) fail('SECURITY_RESULT_BINDING_CHANGED');
      if (!equal(result.after, { ...prepared.before, mode: prepared.targetMode, ctimeNs: result.after.ctimeNs })) fail('SECURITY_RESULT_BINDING_CHANGED');
      const value = evidence('apply', prior.private.before, prior); value.private = { ...value.private, previous: ctx.previous!, result }; value.public.checks = [{ name: 'The helper durably verified the single permission change', passed: true }];
      return store(ctx, 'apply', value);
    }),
    post_verify: handler('post_verify', async ctx => {
      const prior = await previous(ctx, 'apply'); const result = managedResultSchema.parse(prior.private.result);
      const observed = await withBroker(ctx, 'post_verify', broker => broker.observe(executor, ctx.signal));
      if (!equal(observed.snapshot, result.after) || observed.snapshotDigest !== manifestDigest(result.after)) fail('SECURITY_TARGET_DRIFT');
      const value = evidence('post_verify', prior.private.before, prior); value.private.previous = ctx.previous!; value.public.checks = [...prior.public.checks, { name: 'Independent SSH observation matches the verified postimage', passed: true }];
      return store(ctx, 'post_verify', value);
    })
  };
  return steps;
}

/** Independently decrypts the retained encrypted recovery and verifies actual
 * content bytes, metadata and exact AAD. No plaintext leaves this function. */
export function verifyManagedRecovery(input: unknown, prepared: ManagedPrepared, key: Buffer): void {
  let plaintext: Buffer | undefined; let bytes: Buffer | undefined;
  try {
    if (!Buffer.isBuffer(key) || key.length !== 32) fail('SECURITY_RECOVERY_KEY_REQUIRED');
    const envelope = recoveryEnvelopeSchema.parse(input);
    if (!equal(envelope.aad, { protocol: 1, scope: prepared.scope, namespaceId: prepared.namespaceId, targetId: prepared.targetId, operationId: prepared.operationId, snapshotDigest: prepared.snapshotDigest }) || createHash('sha256').update(canonicalPermit(envelope)).digest('hex') !== prepared.recoveryDigest) fail('SECURITY_RECOVERY_INTEGRITY');
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(Buffer.from(canonicalPermit(envelope.aad))); decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    const payload: unknown = JSON.parse(plaintext.toString('utf8'));
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).sort().join(',') !== 'bytes,snapshot') fail('SECURITY_RECOVERY_INTEGRITY');
    const item = payload as { snapshot: unknown; bytes: unknown };
    if (typeof item.bytes !== 'string' || item.bytes.length > 266668) fail('SECURITY_RECOVERY_INTEGRITY');
    const snapshot = managedSnapshotSchema.parse(item.snapshot);
    bytes = Buffer.from(item.bytes as string, 'base64');
    if (bytes.toString('base64') !== item.bytes || !equal(snapshot, prepared.before) || manifestDigest(snapshot) !== prepared.snapshotDigest || bytes.length !== snapshot.size || createHash('sha256').update(bytes).digest('hex') !== snapshot.digest) fail('SECURITY_RECOVERY_INTEGRITY');
    item.bytes = '';
  } catch { fail('SECURITY_RECOVERY_INTEGRITY'); }
  finally { plaintext?.fill(0); bytes?.fill(0); }
}

/** Matches the fixed helper's canonical ASCII permit encoding. */
function canonicalPermit(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalPermit).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalPermit((value as Record<string, unknown>)[k])}`).join(',')}}`;
  return fail('SECURITY_PERMIT_BINDING_CHANGED');
}
