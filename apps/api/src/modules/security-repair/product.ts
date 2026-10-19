import { randomUUID } from 'node:crypto';
import type { CareArtifact, Prisma, PrismaClient, SecurityRepairRun } from '@prisma/client';
import type { Environment } from '@zerochack/config';
import { manifestDigest, SECURITY_WORKFLOW_POLICY, SecurityWorkflowError, type ArtifactReceipt, type SecurityScope } from '@zerochack/security-orchestration';
import { ApiError } from '../../errors.js';
import { readArtifact, writeArtifact } from '../care/repair-service.js';
import { createSecurityRepairJournal } from './journal.js';
import type { createSecurityRepairController, SecurityControllerAuthority } from './controller.js';
import { createSecurityProductAuthority, currentSecurityActor, currentSecurityEnrollment, currentSecurityEntitlement, securityAuthorityDigest, type SecurityProductActor } from './authority.js';
import { SECURITY_MANAGED_ADAPTER, securityAdmissionRequestSchema, securityAdmissionSchema, securityEnrollmentSchema, securityProductDecisionSchema, securityProductEvidenceSchema, type SecurityEnrollmentRegistry, type SecurityRepairAdmission } from './product-contracts.js';

type Controller = ReturnType<typeof createSecurityRepairController>;
export type SecurityRepairProductOptions = {
  database: PrismaClient; environment: Environment; enrollments?: SecurityEnrollmentRegistry;
  controllerFactory?: (admission: SecurityRepairAdmission, authorize: SecurityControllerAuthority) => Promise<Controller>;
  /** Wake the existing durable outbox transport. An acknowledgement here is never
   * evidence of execution, a remote write or a successfully repaired website. */
  wakeDispatcher?: () => Promise<void>;
};
const emptyRegistry: SecurityEnrollmentRegistry = { async list() { return []; } };
const scopeOf = (run: SecurityRepairRun): SecurityScope => ({ tenantId: run.tenantId, websiteId: run.websiteId, environment: run.environment as 'STAGING', runId: run.id });
const errorMessages: Record<string, string> = {
  SECURITY_MFA_REQUIRED: 'Verify your authenticator within the last five minutes before approving security work.',
  SECURITY_PAID_ENTITLEMENT_REQUIRED: 'An active paid plan that explicitly includes managed staging security repair is required.',
  SECURITY_ENROLLMENT_UNAVAILABLE: 'This website has no supported operator-managed staging target enrolled.',
  SECURITY_ENROLLMENT_REVOKED: 'The managed staging enrollment expired or changed. Refresh the available target.',
  SECURITY_GRANT_REQUIRED: 'Current scoped staging access authorization is required.',
  SECURITY_EXECUTOR_UNAVAILABLE: 'No reviewed managed staging execution adapter is configured.',
  SECURITY_ACTOR_BINDING_CHANGED: 'This run belongs to the original user and login session. Its history remains available.',
  SECURITY_PERMISSION_REQUIRED: 'Your current role does not permit this security operation.'
};
export function securityProductError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  if (error instanceof SecurityWorkflowError) {
    const unavailable = ['SECURITY_EXECUTOR_UNAVAILABLE', 'SECURITY_IMPLEMENTATION_UNAVAILABLE', 'SECURITY_OPERATOR_CONFIG_UNAVAILABLE', 'UNREGISTERED_SECURITY_EXECUTOR'].includes(error.code);
    const denied = /MFA|ACTOR|PERMISSION|ENTITLEMENT|GRANT|AUTHORITY|REVOKED/u.test(error.code);
    throw new ApiError(unavailable ? 503 : denied ? 403 : 409, error.code, errorMessages[error.code] ?? 'The security operation is blocked by its current authorization or evidence requirements.');
  }
  throw error;
}
export function securityRunView(run: SecurityRepairRun, actor: SecurityProductActor) {
  return { id: run.id, environment: run.environment, phase: run.phase, errorCode: run.errorCode, allowanceMicros: run.allowanceMicros, reservedMicros: run.reservedMicros, chargedMicros: run.chargedMicros, createdAt: run.createdAt, expiresAt: run.expiresAt, sessionBound: run.actorId === actor.actorId && run.sessionId === actor.sessionId };
}
function admissionScopeEqual(admission: SecurityRepairAdmission, run: SecurityRepairRun) { return manifestDigest(admission.scope) === manifestDigest(scopeOf(run)) && admission.actorId === run.actorId && admission.sessionId === run.sessionId && admission.requestKey === run.requestKey && admission.allowanceMicros === run.allowanceMicros && new Date(admission.expiresAt).getTime() === run.expiresAt.getTime() && admission.authorityDigest === run.authorityDigest; }

export function createSecurityRepairProduct(options: SecurityRepairProductOptions) {
  const { database, environment } = options; const registry = options.enrollments ?? emptyRegistry;
  async function transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>) {
    return database.$transaction(async tx => { await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`; await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`; return work(tx); }, { maxWait: 2000, timeout: 5000 });
  }
  async function scopedRun(actor: SecurityProductActor, websiteId: string, runId: string) {
    return transaction(async tx => {
      await currentSecurityActor(tx, actor, websiteId, false);
      const run = await tx.securityRepairRun.findFirst({ where: { id: runId, tenantId: actor.tenantId, websiteId, actorId: actor.actorId, environment: 'STAGING' } });
      if (!run) throw new ApiError(404, 'SECURITY_RUN_NOT_FOUND', 'Security run was not found.'); return run;
    });
  }
  async function loadAdmission(run: SecurityRepairRun) {
    if (!run.admissionArtifactId || !run.admissionDigest || run.executionProfile !== SECURITY_MANAGED_ADAPTER) throw new SecurityWorkflowError('SECURITY_ADMISSION_REQUIRED');
    const artifact = await database.careArtifact.findFirst({ where: { id: run.admissionArtifactId, tenantId: run.tenantId, websiteId: run.websiteId, environment: 'STAGING', kind: 'SEC_ADMISSION', digest: run.admissionDigest, status: 'ACCEPTED' } });
    if (!artifact) throw new SecurityWorkflowError('SECURITY_ADMISSION_REQUIRED');
    let admission: SecurityRepairAdmission;
    try { admission = securityAdmissionSchema.parse(JSON.parse(readArtifact(artifact, environment).toString('utf8'))); } catch { throw new SecurityWorkflowError('SECURITY_ADMISSION_INVALID'); }
    if (!admissionScopeEqual(admission, run) || manifestDigest(admission.enrollment) !== admission.enrollmentDigest) throw new SecurityWorkflowError('SECURITY_ADMISSION_BINDING_CHANGED');
    return admission;
  }
  async function controllerFor(run: SecurityRepairRun, actor: SecurityProductActor) {
    if (run.actorId !== actor.actorId || run.sessionId !== actor.sessionId) throw new SecurityWorkflowError('SECURITY_ACTOR_BINDING_CHANGED');
    if (!options.controllerFactory) throw new SecurityWorkflowError('SECURITY_EXECUTOR_UNAVAILABLE');
    const admission = await loadAdmission(run); const authority = createSecurityProductAuthority(admission, registry);
    const controller = await options.controllerFactory(admission, authority);
    if (controller.expectedCreateBinding.inputDigest !== run.inputDigest || controller.expectedCreateBinding.authorityDigest !== run.authorityDigest) throw new SecurityWorkflowError('SECURITY_CONTROLLER_BINDING_CHANGED');
    return { admission, authority, controller };
  }
  async function evidence(run: SecurityRepairRun, receipt?: ArtifactReceipt | null) {
    if (!receipt) return null;
    const artifact = await database.careArtifact.findFirst({ where: { id: receipt.artifactId, digest: receipt.digest, tenantId: run.tenantId, websiteId: run.websiteId, environment: 'STAGING', status: 'ACCEPTED' } });
    if (!artifact) return null;
    try {
      const decoded = JSON.parse(readArtifact(artifact, environment).toString('utf8')) as { public?: unknown };
      const safe = securityProductEvidenceSchema.parse(decoded.public);
      return { artifactId: receipt.artifactId, digest: receipt.digest, ...safe };
    } catch { return null; }
  }
  async function wake() { try { await options.wakeDispatcher?.(); } catch { /* Durable admission/decision remains recorded for later dispatch. */ } }
  return {
    loadAdmission,
    async capabilities(actor: SecurityProductActor, websiteId: string) {
      return transaction(async tx => {
        const current = await currentSecurityActor(tx, actor, websiteId, false);
        const blockers: Array<{ code: string; message: string }> = [];
        const enrolled = (await registry.list(tx, actor.tenantId, websiteId)).flatMap(value => { const parsed = securityEnrollmentSchema.safeParse(value); return parsed.success && parsed.data.tenantId === actor.tenantId && parsed.data.websiteId === websiteId && parsed.data.actorId === actor.actorId && parsed.data.enabled && new Date(parsed.data.expiresAt) > current.now ? [parsed.data] : []; });
        if (!options.controllerFactory) blockers.push({ code: 'SECURITY_EXECUTOR_UNAVAILABLE', message: errorMessages.SECURITY_EXECUTOR_UNAVAILABLE! });
        if (!enrolled.length) blockers.push({ code: 'SECURITY_ENROLLMENT_UNAVAILABLE', message: errorMessages.SECURITY_ENROLLMENT_UNAVAILABLE! });
        try { await currentSecurityActor(tx, actor, websiteId, true); await currentSecurityEntitlement(tx, actor.tenantId); for (const item of enrolled) await currentSecurityEnrollment(tx, registry, actor, websiteId, item.id, item.revision); }
        catch (error) { if (error instanceof SecurityWorkflowError) blockers.push({ code: error.code, message: errorMessages[error.code] ?? 'Current security authority is required.' }); else throw error; }
        return { environment: 'STAGING' as const, tracks: [{ id: 'managed-static-permission-v1', label: 'Managed staging file permission', available: blockers.length === 0 }], enrollments: enrolled.map(({ id, revision, label, environment, adapter }) => ({ id, revision, label, environment, adapter })), blockers, productionWrites: false, authority: { canCreate: blockers.length === 0, requiresRecentMfa: !current.recentMfa } };
      });
    },
    async list(actor: SecurityProductActor, websiteId: string) {
      return transaction(async tx => { await currentSecurityActor(tx, actor, websiteId, false); return { runs: (await tx.securityRepairRun.findMany({ where: { tenantId: actor.tenantId, websiteId, actorId: actor.actorId, environment: 'STAGING' }, orderBy: { createdAt: 'desc' }, take: 50 })).map(run => securityRunView(run, actor)) }; });
    },
    async admit(actor: SecurityProductActor, websiteId: string, raw: unknown) {
      const input = securityAdmissionRequestSchema.parse(raw);
      if (!options.controllerFactory) throw new SecurityWorkflowError('SECURITY_EXECUTOR_UNAVAILABLE');
      const previous = await database.securityRepairRun.findUnique({ where: { tenantId_websiteId_environment_requestKey: { tenantId: actor.tenantId, websiteId, environment: 'STAGING', requestKey: input.requestKey } } });
      if (previous) {
        const old = await controllerFor(previous, actor);
        if (old.admission.enrollment.id !== input.enrollmentId || old.admission.enrollment.revision !== input.enrollmentRevision || old.admission.operation !== input.operation || old.admission.recoveryRunId !== (input.recoveryRunId ?? null)) throw new SecurityWorkflowError('SECURITY_REQUEST_BINDING_CHANGED');
        await transaction(tx => old.authority(tx, old.admission.scope, 'OBSERVE', previous));
        return { run: securityRunView(previous, actor), created: false };
      }
      const admission = await transaction(async tx => {
        const current = await currentSecurityActor(tx, actor, websiteId, true);
        const grant = await currentSecurityEnrollment(tx, registry, actor, websiteId, input.enrollmentId, input.enrollmentRevision);
        const entitlement = await currentSecurityEntitlement(tx, actor.tenantId);
        if (input.operation === 'RESTORE') {
          const original = await tx.securityRepairRun.findFirst({ where: { id: input.recoveryRunId!, tenantId: actor.tenantId, websiteId, actorId: actor.actorId, environment: 'STAGING', phase: 'COMPLETED', executionProfile: SECURITY_MANAGED_ADAPTER } });
          if (!original || !original.admissionArtifactId) throw new SecurityWorkflowError('SECURITY_RECOVERY_SOURCE_REQUIRED');
          const originalArtifact = await tx.careArtifact.findFirst({ where: { id: original.admissionArtifactId, digest: original.admissionDigest!, tenantId: actor.tenantId, websiteId, status: 'ACCEPTED' } });
          if (!originalArtifact) throw new SecurityWorkflowError('SECURITY_RECOVERY_SOURCE_REQUIRED');
          let originalAdmission: SecurityRepairAdmission;
          try { originalAdmission = securityAdmissionSchema.parse(JSON.parse(readArtifact(originalArtifact, environment).toString('utf8'))); } catch { throw new SecurityWorkflowError('SECURITY_RECOVERY_SOURCE_REQUIRED'); }
          if (originalAdmission.operation !== 'HARDEN' || originalAdmission.enrollmentDigest !== grant.enrollmentDigest || !await tx.securityRepairAttempt.count({ where: { runId: original.id, tenantId: actor.tenantId, websiteId, stepKey: 'post_verify', state: 'SUCCEEDED' } })) throw new SecurityWorkflowError('SECURITY_RECOVERY_SOURCE_REQUIRED');
        }
        const scope = { tenantId: actor.tenantId, websiteId, environment: 'STAGING' as const, runId: randomUUID() };
        return securityAdmissionSchema.parse({ version: 1, scope, actorId: actor.actorId, sessionId: actor.sessionId, requestKey: input.requestKey, operation: input.operation, recoveryRunId: input.recoveryRunId ?? null, enrollment: grant.enrollment, enrollmentDigest: grant.enrollmentDigest, entitlement,
          authorityDigest: securityAuthorityDigest({ actor, permissions: current.permissions, enrollment: grant.enrollment, entitlement, credentialExpiresAt: grant.credential.authorizationExpiresAt }),
          requestDigest: manifestDigest({ policy: SECURITY_WORKFLOW_POLICY, input, scope }), implementationDigest: grant.enrollment.implementationDigest,
          allowanceMicros: grant.enrollment.allowanceMicros, expiresAt: new Date(Math.min(current.now.getTime() + 3_600_000, current.session.expiresAt.getTime(), grant.credential.authorizationExpiresAt.getTime(), new Date(grant.enrollment.expiresAt).getTime(), new Date(entitlement.expiresAt).getTime())).toISOString() });
      });
      const authority = createSecurityProductAuthority(admission, registry); const controller = await options.controllerFactory(admission, authority);
      const artifact: CareArtifact = await transaction(async tx => { await authority(tx, admission.scope, 'CREATE', null); return writeArtifact(tx, { tenantId: actor.tenantId, websiteId, environment: 'STAGING', jobId: null, createdBy: actor.actorId }, Buffer.from(JSON.stringify(admission)), 'SEC_ADMISSION', `security-admission-${admission.scope.runId}.json`, 'application/json', environment); });
      const journal = createSecurityRepairJournal({ database, assertAuthority: controller.authorizeJournal });
      const run = await journal.createRun({ ...controller.expectedCreateBinding, requestKey: input.requestKey, expiresAt: new Date(admission.expiresAt), admissionArtifactId: artifact.id, admissionDigest: artifact.digest, executionProfile: SECURITY_MANAGED_ADAPTER });
      await wake(); return { run: securityRunView(run, actor), created: true };
    },
    async detail(actor: SecurityProductActor, websiteId: string, runId: string) {
      const run = await scopedRun(actor, websiteId, runId);
      const [attempts, decisions] = await Promise.all([
        database.securityRepairAttempt.findMany({ where: { tenantId: actor.tenantId, websiteId, runId }, orderBy: { startedAt: 'asc' }, select: { stepKey: true, state: true, errorCode: true, artifactId: true, artifactDigest: true, completedAt: true } }),
        database.securityRepairDecision.findMany({ where: { tenantId: actor.tenantId, websiteId, runId }, orderBy: { createdAt: 'asc' }, select: { id: true, kind: true, status: true, artifactId: true, digest: true, expiresAt: true } })
      ]);
      const receipt = (step: string) => { const item = attempts.find(a => a.stepKey === step && a.state === 'SUCCEEDED'); return item?.artifactId && item.artifactDigest ? { artifactId: item.artifactId, digest: item.artifactDigest } : null; };
      const [plan, proposal, result] = await Promise.all([evidence(run, receipt('plan')), evidence(run, receipt('proposal')), evidence(run, receipt('post_verify'))]);
      return { run: securityRunView(run, actor), attempts, decisions, plan, proposal, result, awaitingDecision: run.phase === 'AWAITING_APPROVAL' ? proposal ? 'CHANGE' as const : plan ? 'CANDIDATE' as const : null : null };
    },
    async decide(actor: SecurityProductActor, websiteId: string, runId: string, kind: 'CANDIDATE' | 'CHANGE', raw: unknown) {
      const input = securityProductDecisionSchema.parse(raw); const run = await scopedRun(actor, websiteId, runId); const { controller } = await controllerFor(run, actor);
      const decisionId = kind === 'CANDIDATE' ? await controller.recordCandidateDecision({ ...input, actorId: actor.actorId, sessionId: actor.sessionId }) : await controller.recordChangeDecision({ ...input, actorId: actor.actorId, sessionId: actor.sessionId });
      await wake(); return { decisionId };
    },
    async cancel(actor: SecurityProductActor, websiteId: string, runId: string) {
      const run = await scopedRun(actor, websiteId, runId); const { controller } = await controllerFor(run, actor); const result = await controller.stop();
      return { phase: result.phase, recorded: result.recorded, effectsUndone: false as const };
    }
  };
}
