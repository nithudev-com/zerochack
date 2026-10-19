import type { Prisma, PrismaClient, SecurityRepairRun } from '@prisma/client';
import type { Environment } from '@zerochack/config';
import { openSecret } from '@zerochack/care';
import { manifestDigest, scopeSchema, SECURITY_WORKFLOW_POLICY, SecurityWorkflowError, type ArtifactReceipt, type SecurityScope } from '@zerochack/security-orchestration';
import { artifactKey, readArtifact } from '../care/repair-service.js';
import { vaultKey } from '../care/runtime.js';
import { createSecurityProductAuthority, currentSecurityEnrollment } from './authority.js';
import { createSecurityRepairController, securityControllerManifest, type SecurityControllerAuthority } from './controller.js';
import { createManagedSecurityControllerSteps, readManagedSecurityArtifact, type ManagedSecurityRuntime } from './managed-handlers.js';
import { createSecurityOperatorRegistry, type SecurityOperatorRegistry } from './operator-registry.js';
import { createSecurityRepairProduct, type SecurityRepairProductOptions } from './product.js';
import { SECURITY_MANAGED_ADAPTER, securityAdmissionSchema, type SecurityRepairAdmission } from './product-contracts.js';

const fail = (code: string): never => { throw new SecurityWorkflowError(code); };
const equal = (left: unknown, right: unknown) => manifestDigest(left) === manifestDigest(right);
type Controller = ReturnType<typeof createSecurityRepairController>;
export type ConfiguredSecurityRepair = Pick<SecurityRepairProductOptions, 'enrollments' | 'controllerFactory'> & { controllerForScope(scope: SecurityScope): Promise<Controller> };

/** Trusted boot-time composition. Only the dedicated, attested STAGING profile is
 * registered; a feature flag or browser-supplied proof alone never enables it. */
export function createConfiguredSecurityRepair(database: PrismaClient, environment: Environment, workerId: string, internal?: { registry?: SecurityOperatorRegistry }): ConfiguredSecurityRepair {
  const registry = internal?.registry ?? createSecurityOperatorRegistry(environment);
  async function resolveRuntime(admission: SecurityRepairAdmission, authorize: SecurityControllerAuthority): Promise<ManagedSecurityRuntime> {
    const material = await registry.resolve(admission.enrollment); let privateKey: Buffer | undefined;
    try {
      const credential = await database.$transaction(async tx => {
        const run = await tx.securityRepairRun.findFirst({ where: { id: admission.scope.runId, tenantId: admission.scope.tenantId, websiteId: admission.scope.websiteId, environment: 'STAGING' } });
        if (!run) return fail('SECURITY_RUN_NOT_FOUND');
        await authorize(tx, admission.scope, 'READINESS', run);
        const grant = await currentSecurityEnrollment(tx, registry, { actorId: admission.actorId, sessionId: admission.sessionId, tenantId: admission.scope.tenantId }, admission.scope.websiteId, admission.enrollment.id, admission.enrollment.revision);
        if (grant.enrollmentDigest !== admission.enrollmentDigest) fail('SECURITY_AUTHORITY_BINDING_CHANGED');
        return grant.credential;
      }, { maxWait: 2000, timeout: 5000 });
      const pinned = material.attestation.access;
      if (credential.id !== admission.enrollment.credentialId || credential.version !== admission.enrollment.credentialVersion || credential.tenantId !== admission.scope.tenantId || credential.websiteId !== admission.scope.websiteId || credential.authorizedBy !== admission.actorId || credential.environment !== 'STAGING' || credential.kind !== 'SSH' || credential.status !== 'STORED' || credential.authMethod !== 'SSH_KEY' || credential.username !== pinned.username || credential.host !== pinned.address || credential.port !== pinned.port || pinned.hostKeyFingerprint !== admission.enrollment.hostKeyFingerprint) fail('SECURITY_GRANT_REQUIRED');
      privateKey = Buffer.from(openSecret(credential.encryptedEnvelope, credential, { v1: vaultKey(environment) }), 'utf8');
      if (privateKey.length < 100 || privateKey.length > 16384) fail('SECURITY_GRANT_REQUIRED');
      return { access: { address: pinned.address, port: pinned.port, username: pinned.username, hostKeyFingerprint: pinned.hostKeyFingerprint, privateKey }, permitKey: material.permitKey, recoveryKey: material.recoveryKey };
    } catch (error) { material.permitKey.fill(0); material.recoveryKey.fill(0); privateKey?.fill(0); throw error; }
  }
  const controllerFactory: SecurityRepairProductOptions['controllerFactory'] = environment.SECURITY_REPAIR_ENABLED && registry.configured ? async (input, authorize) => {
    const admission = securityAdmissionSchema.parse(input);
    if (admission.implementationDigest !== environment.SECURITY_REPAIR_IMPLEMENTATION_DIGEST) fail('SECURITY_IMPLEMENTATION_UNAVAILABLE');
    const binding = { actorId: admission.actorId, sessionId: admission.sessionId, requestDigest: admission.requestDigest, authorityDigest: admission.authorityDigest, implementationDigest: admission.implementationDigest, allowanceMicros: admission.allowanceMicros, policy: SECURITY_WORKFLOW_POLICY };
    const steps = createManagedSecurityControllerSteps(admission, { database, environment, authorize, resolveRuntime: value => resolveRuntime(value, authorize) });
    const expected = securityControllerManifest({ scope: admission.scope, binding, steps }).expectedCreateBinding;
    async function assertAdmission(tx: Prisma.TransactionClient, scope: SecurityScope, run: SecurityRepairRun, action: 'DECIDE' | 'APPLY' | 'POST_VERIFY' | 'SETTLE', receipt?: ArtifactReceipt) {
      if (scope.environment !== 'STAGING' || !equal(scope, admission.scope) || run.id !== scope.runId || run.tenantId !== scope.tenantId || run.websiteId !== scope.websiteId || run.environment !== scope.environment || run.actorId !== binding.actorId || run.sessionId !== binding.sessionId || run.authorityDigest !== binding.authorityDigest || run.inputDigest !== expected.inputDigest || run.allowanceMicros !== binding.allowanceMicros || run.requestKey !== admission.requestKey || run.expiresAt.getTime() !== new Date(admission.expiresAt).getTime() || run.executionProfile !== SECURITY_MANAGED_ADAPTER || !run.admissionArtifactId || !run.admissionDigest) fail('SECURITY_ADMISSION_BINDING_CHANGED');
      const record = await tx.careArtifact.findFirst({ where: { id: run.admissionArtifactId!, tenantId: scope.tenantId, websiteId: scope.websiteId, environment: 'STAGING', kind: 'SEC_ADMISSION', digest: run.admissionDigest!, status: 'ACCEPTED', createdBy: admission.actorId } });
      if (!record) return fail('SECURITY_ADMISSION_REQUIRED');
      let saved: SecurityRepairAdmission;
      try { saved = securityAdmissionSchema.parse(JSON.parse(readArtifact(record, environment).toString('utf8'))); } catch { return fail('SECURITY_ADMISSION_INVALID'); }
      if (!equal(saved, admission) || manifestDigest(saved.enrollment) !== saved.enrollmentDigest) fail('SECURITY_ADMISSION_BINDING_CHANGED');
      await authorize(tx, scope, action === 'DECIDE' ? 'DECIDE' : action === 'APPLY' ? 'BEGIN_STEP' : action === 'SETTLE' ? 'COMPLETE_STEP' : 'READINESS', run);
      let boundReceipt = receipt;
      if (action === 'POST_VERIFY' && !boundReceipt) {
        const applied = await tx.securityRepairAttempt.findFirst({ where: { runId: scope.runId, tenantId: scope.tenantId, websiteId: scope.websiteId, environment: 'STAGING', stepKey: 'apply', state: 'SUCCEEDED', kind: { in: ['STAGING_WRITE', 'STAGING_RECOVERY'] } }, orderBy: { attemptNumber: 'desc' } });
        if (!applied?.artifactId || !applied.artifactDigest) return fail('SECURITY_MUTATION_EVIDENCE_REQUIRED');
        boundReceipt = { artifactId: applied.artifactId, digest: applied.artifactDigest };
      }
      if (!boundReceipt) return fail('SECURITY_MUTATION_EVIDENCE_REQUIRED');
      const stage = action === 'DECIDE' || action === 'APPLY' ? 'proposal' : action === 'POST_VERIFY' && receipt ? 'post_verify' : 'apply';
      const evidence = await readManagedSecurityArtifact(tx, admission, boundReceipt, environment, stage);
      if (!evidence.private.prepared || !evidence.private.recoveryEnvelope || !evidence.public.recovery.verified || stage !== 'proposal' && evidence.private.result?.state !== 'VERIFIED') fail('SECURITY_MUTATION_EVIDENCE_REQUIRED');
    }
    return createSecurityRepairController({ database, scope: admission.scope, workerId, artifactKey: artifactKey(environment), binding, authorize, steps, stagingMutation: { profile: SECURITY_MANAGED_ADAPTER, assertReady: assertAdmission } });
  } : undefined;
  const productOptions = { database, environment, enrollments: registry, ...(controllerFactory ? { controllerFactory } : {}) };
  const product = createSecurityRepairProduct(productOptions);
  return {
    enrollments: registry, ...(controllerFactory ? { controllerFactory } : {}),
    async controllerForScope(input) {
      if (!controllerFactory) return fail('SECURITY_EXECUTOR_UNAVAILABLE');
      const scope = scopeSchema.parse(input); if (scope.environment !== 'STAGING') return fail('UNREGISTERED_SECURITY_EXECUTOR');
      const run = await database.securityRepairRun.findFirst({ where: { id: scope.runId, tenantId: scope.tenantId, websiteId: scope.websiteId, environment: 'STAGING' } });
      if (!run) return fail('SECURITY_RUN_NOT_FOUND');
      const admission = await product.loadAdmission(run);
      const controller = await controllerFactory(admission, createSecurityProductAuthority(admission, registry));
      if (controller.expectedCreateBinding.inputDigest !== run.inputDigest || controller.expectedCreateBinding.authorityDigest !== run.authorityDigest) fail('SECURITY_CONTROLLER_BINDING_CHANGED');
      return controller;
    }
  };
}
