import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { database } from '@zerochack/database';
import { hashOpaqueToken } from '@zerochack/auth';
import { loadEnvironment } from '@zerochack/config';
import { buildApp } from '../../app.js';
import { manifestDigest, SECURITY_WORKFLOW_POLICY, SecurityWorkflowError } from '@zerochack/security-orchestration';
import { currentSecurityActor, currentSecurityEnrollment, currentSecurityEntitlement, createSecurityProductAuthority } from './authority.js';
import { createSecurityRepairController } from './controller.js';
import { createManagedSecurityControllerSteps, readManagedSecurityArtifact } from './managed-handlers.js';
import { createManagedTargetTestFixture } from './managed-fixture.test-helper.js';
import { createSecurityRepairProduct, type SecurityRepairProductOptions } from './product.js';
import { readArtifact } from '../care/repair-service.js';
import type { SecurityManagedEnrollment } from './product-contracts.js';
import { assertSecurityWorkplaceTestDatabase } from './fixture-guard.test-helper.js';

const retained: Array<{ tenantId: string; actorId: string; packageId?: string; providerId?: string }> = [];
beforeAll(assertSecurityWorkplaceTestDatabase);
afterAll(async () => {
  for (const item of retained) {
    const where = { tenantId: item.tenantId };
    await database.securityRepairDecision.deleteMany({ where }); await database.securityGraphWrite.deleteMany({ where }); await database.securityGraphCheckpoint.deleteMany({ where });
    await database.securityRepairOutbox.deleteMany({ where }); await database.securityRepairCostEntry.deleteMany({ where }); await database.securityRepairAttempt.deleteMany({ where });
    await database.securityRepairRun.deleteMany({ where }); await database.careArtifact.deleteMany({ where });
    await database.paymentRefund.deleteMany({ where: { transaction: { tenantId: item.tenantId } } });
    await database.paymentTransaction.deleteMany({ where: { tenantId: item.tenantId } });
    await database.invoice.deleteMany({ where: { tenantId: item.tenantId } });
    await database.subscription.deleteMany({ where: { tenantId: item.tenantId } });
    if (item.packageId) { await database.packageVersion.deleteMany({ where: { packageId: item.packageId } }); await database.commercialPackage.delete({ where: { id: item.packageId } }); }
    if (item.providerId) await database.paymentProviderConfig.delete({ where: { id: item.providerId } });
    await database.tenant.delete({ where: { id: item.tenantId } }); await database.user.delete({ where: { id: item.actorId } });
  }
  await database.$disconnect();
});
async function fixture() {
  const now = new Date(); const tenant = await database.tenant.create({ data: { name: 'Security product authority fixture', slug: `security-product-${randomUUID()}` } });
  const user = await database.user.create({ data: { email: `${randomUUID()}@example.test`, status: 'APPROVED', emailVerifiedAt: now, mfaEnabledAt: now } });
  const retainedItem = { tenantId: tenant.id, actorId: user.id } as typeof retained[number]; retained.push(retainedItem);
  await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: 'ACTIVE' } });
  const role = await database.role.create({ data: { tenantId: tenant.id, name: 'Security product fixture' } });
  for (const key of ['websites.manage', 'websites.read', 'chat.read', 'ai.use', 'ai.security_context']) {
    const permission = await database.permission.upsert({ where: { key }, create: { key }, update: {} });
    await database.rolePermission.create({ data: { roleId: role.id, permissionId: permission.id } });
  }
  await database.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
  const session = await database.session.create({ data: { tenantId: tenant.id, userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(now.getTime() + 3600000), mfaVerifiedAt: now } });
  const website = await database.website.create({ data: { tenantId: tenant.id, name: 'Enrolled staging fixture', url: 'https://product.example.test/', normalizedHost: 'product.example.test' } });
  const actor = { actorId: user.id, tenantId: tenant.id, sessionId: session.id };
  return { now, tenant, user, role, session, website, actor, retainedItem };
}
async function paidTerms(f: Awaited<ReturnType<typeof fixture>>, withPayment = true) {
  const pkg = await database.commercialPackage.create({ data: { key: `fixture-${randomUUID()}` } }); f.retainedItem.packageId = pkg.id;
  const version = await database.packageVersion.create({ data: { packageId: pkg.id, version: 1, name: 'Authority test terms', description: 'Synthetic recorded commerce state for authorization checks only', priceMinor: 100, currency: 'GBP', billingInterval: 'MONTHLY', websiteLimit: 1, scanLimit: 1, monitoringIntervalMinutes: 60, backupFrequencyHours: 24, backupRetentionDays: 1, warrantyDays: 0, aiRequestLimit: 0, aiCostLimitMicros: 0, supportLevel: 'fixture', featureEntitlements: { securityManagedStagingPermissionRepair: true }, createdByUserId: f.user.id } });
  const provider = await database.paymentProviderConfig.create({ data: { name: 'No external calls test fixture', adapterKey: 'manual-fixture' } }); f.retainedItem.providerId = provider.id;
  const subscription = await database.subscription.create({ data: { tenantId: f.tenant.id, packageVersionId: version.id, providerConfigId: provider.id, planName: 'Authority test terms', status: 'ACTIVE', termsSnapshot: { packageVersionId: version.id, featureEntitlements: { securityManagedStagingPermissionRepair: true } }, currentPeriodEnd: new Date(Date.now() + 3600000) } });
  async function payment() {
    const invoice = await database.invoice.create({ data: { tenantId: f.tenant.id, subscriptionId: subscription.id, packageVersionId: version.id, amountMinor: 100, currency: 'GBP', status: 'PAID', issuedAt: new Date(), paidAt: new Date() } });
    return database.paymentTransaction.create({ data: { tenantId: f.tenant.id, subscriptionId: subscription.id, invoiceId: invoice.id, providerConfigId: provider.id, packageVersionId: version.id, idempotencyKey: randomUUID(), amountMinor: 100, currency: 'GBP', status: 'SUCCEEDED', completedAt: new Date(), providerPaymentReference: `synthetic-ledger-${randomUUID()}` } });
  }
  if (withPayment) await payment();
  return { subscription, payment };
}
async function productJourneyFixture() {
  const f = await fixture(); await paidTerms(f); const remote = createManagedTargetTestFixture();
  const secret = 'security-product-fixture-session-at-least32', raw = randomUUID();
  await database.session.update({ where: { id: f.session.id }, data: { tokenHash: hashOpaqueToken(raw, secret) } });
  const env = loadEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: 'redis://127.0.0.1:6380', LOG_LEVEL: 'silent', CORS_ORIGINS: 'http://localhost:3000', SESSION_SECRET: secret, CARE_ENABLED: 'true', CARE_VAULT_KEY: Buffer.alloc(32, 37).toString('base64'), CARE_ARTIFACT_KEY: Buffer.alloc(32, 38).toString('base64') });
  const credential = await database.careCredential.create({ data: { tenantId: f.tenant.id, websiteId: f.website.id, environment: 'STAGING', kind: 'SSH', host: '8.8.8.8', username: 'codebandage-managed-target', authMethod: 'SSH_KEY', encryptedEnvelope: 'test-only-not-opened-remote-runtime-is-injected', authorizedBy: f.user.id, authorizationExpiresAt: new Date(Date.now() + 3600000) } });
  const enrollment: SecurityManagedEnrollment = { id: randomUUID(), revision: 1, tenantId: f.tenant.id, websiteId: f.website.id, actorId: f.user.id, label: 'Explicitly simulated managed test target', environment: 'STAGING', adapter: 'MANAGED_STATIC_PERMISSION_V1', enabled: true, expiresAt: new Date(Date.now() + 3600000).toISOString(), credentialId: credential.id, credentialVersion: 1, namespaceId: randomUUID(), targetId: randomUUID(), hostKeyFingerprint: `SHA256:${'a'.repeat(43)}`, attestationDigest: 'a'.repeat(64), implementationDigest: 'b'.repeat(64), allowanceMicros: 0, proof: { independentWriterExcluded: true, publisherReadOnly: true, rootOwned: true, forcedCommandOnly: true, recoveryEncrypted: true } };
  const registry = { async list() { return [enrollment]; } };
  const factory: NonNullable<SecurityRepairProductOptions['controllerFactory']> = async (admission, authorize) => {
    const steps = createManagedSecurityControllerSteps(admission, { database, environment: env, authorize, resolveRuntime: remote.resolveRuntime, brokerFactory: remote.brokerFactory });
    return createSecurityRepairController({ database, scope: admission.scope, workerId: randomUUID(), artifactKey: env.CARE_ARTIFACT_KEY!, binding: { actorId: admission.actorId, sessionId: admission.sessionId, requestDigest: admission.requestDigest, authorityDigest: admission.authorityDigest, implementationDigest: admission.implementationDigest, allowanceMicros: admission.allowanceMicros, policy: SECURITY_WORKFLOW_POLICY }, authorize, steps,
      stagingMutation: { profile: 'MANAGED_STATIC_PERMISSION_V1', async assertReady(tx, scope, run, action, receipt) {
        await authorize(tx, scope, action === 'DECIDE' ? 'DECIDE' : 'READINESS', run);
        const record = await tx.careArtifact.findFirstOrThrow({ where: { id: run.admissionArtifactId!, digest: run.admissionDigest!, tenantId: scope.tenantId, websiteId: scope.websiteId, environment: 'STAGING' } });
        if (manifestDigest(JSON.parse(readArtifact(record, env).toString('utf8'))) !== manifestDigest(admission)) throw new SecurityWorkflowError('SECURITY_ADMISSION_BINDING_CHANGED');
        if (action === 'DECIDE' || action === 'APPLY' || action === 'SETTLE') {
          if (!receipt) throw new SecurityWorkflowError('SECURITY_ARTIFACT_UNAVAILABLE');
          const value = await readManagedSecurityArtifact(tx, admission, receipt, env, action === 'SETTLE' ? 'apply' : 'proposal');
          if (!value.public.recovery.verified || !value.private.recoveryEnvelope || !value.private.prepared || action === 'SETTLE' && !value.private.result) throw new SecurityWorkflowError('SECURITY_RECOVERY_UNAVAILABLE');
        }
      } }
    });
  };
  const product = createSecurityRepairProduct({ database, environment: env, enrollments: registry, controllerFactory: factory });
  const app = await buildApp(env, { securityRepair: { enrollments: registry, controllerFactory: factory } });
  const cookie = `zerochack_session=${raw}`, prefix = `/v1/websites/${f.website.id}/security-repair`;
  async function controller(runId: string) { const run = await database.securityRepairRun.findUniqueOrThrow({ where: { id: runId } }); const admission = await product.loadAdmission(run); return factory(admission, createSecurityProductAuthority(admission, registry)); }
  async function admit(operation: 'HARDEN' | 'RESTORE' = 'HARDEN', recoveryRunId?: string) {
    const response = await app.inject({ method: 'POST', url: `${prefix}/runs`, headers: { cookie }, payload: { requestKey: randomUUID(), enrollmentId: enrollment.id, enrollmentRevision: enrollment.revision, authorizationConfirmed: true, operation, ...(recoveryRunId ? { recoveryRunId } : {}) } });
    expect(response.statusCode, response.body).toBe(201); return response.json().run.id as string;
  }
  async function detail(runId: string) { const response = await app.inject({ method: 'GET', url: `${prefix}/runs/${runId}`, headers: { cookie } }); expect(response.statusCode, response.body).toBe(200); return response.json(); }
  async function approve(runId: string, kind: 'candidate' | 'change') {
    const value = await detail(runId), evidence = kind === 'candidate' ? value.plan : value.proposal;
    const response = await app.inject({ method: 'POST', url: `${prefix}/runs/${runId}/${kind}-decisions`, headers: { cookie }, payload: { requestKey: randomUUID(), artifactId: evidence.artifactId, digest: evidence.digest, status: 'APPROVED' } });
    expect(response.statusCode, response.body).toBe(200); return response.json().decisionId as string;
  }
  return { ...f, remote, enrollment, registry, product, app, cookie, prefix, secret, admit, detail, approve, controller };
}
describe.sequential('security product current authority: real isolated PostgreSQL, no remote execution', () => {
  it('exposes truthful authenticated capability/history APIs and refuses admission without a trusted operator adapter', async () => {
    const f = await fixture(); const raw = randomUUID(); const secret = 'security-product-fixture-session-at-least32';
    await database.session.update({ where: { id: f.session.id }, data: { tokenHash: hashOpaqueToken(raw, secret) } });
    const env = loadEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: 'redis://127.0.0.1:6380', LOG_LEVEL: 'silent', CORS_ORIGINS: 'http://localhost:3000', SESSION_SECRET: secret });
    const app = await buildApp(env);
    try {
      const prefix = `/v1/websites/${f.website.id}/security-repair`;
      expect((await app.inject({ method: 'GET', url: `${prefix}/capabilities` })).statusCode).toBe(401);
      const cookie = `zerochack_session=${raw}`;
      const capabilities = await app.inject({ method: 'GET', url: `${prefix}/capabilities`, headers: { cookie } });
      expect(capabilities.statusCode).toBe(200); expect(capabilities.json()).toMatchObject({ environment: 'STAGING', productionWrites: false, enrollments: [], authority: { canCreate: false } });
      expect(capabilities.json().blockers.map((item: { code: string }) => item.code)).toContain('SECURITY_EXECUTOR_UNAVAILABLE');
      const rejected = await app.inject({ method: 'POST', url: `${prefix}/runs`, headers: { cookie }, payload: { requestKey: randomUUID(), enrollmentId: randomUUID(), enrollmentRevision: 1, authorizationConfirmed: true } });
      expect(rejected.statusCode).toBe(503); expect(rejected.json().error.code).toBe('SECURITY_EXECUTOR_UNAVAILABLE');
      expect(await database.securityRepairRun.count({ where: { tenantId: f.tenant.id } })).toBe(0);
      const injected = await app.inject({ method: 'POST', url: `${prefix}/runs`, headers: { cookie }, payload: { requestKey: randomUUID(), enrollmentId: randomUUID(), enrollmentRevision: 1, authorizationConfirmed: true, command: 'arbitrary-shell' } });
      expect(injected.statusCode).toBe(400);
    } finally { await app.close(); }
  });
  it('rechecks exact session, current RBAC, and recent MFA against actual persisted rows', async () => {
    const f = await fixture();
    expect((await database.$transaction(tx => currentSecurityActor(tx, f.actor, f.website.id, true))).recentMfa).toBe(true);
    await database.session.update({ where: { id: f.session.id }, data: { mfaVerifiedAt: new Date(Date.now() - 300001) } });
    await expect(database.$transaction(tx => currentSecurityActor(tx, f.actor, f.website.id, true))).rejects.toMatchObject({ code: 'SECURITY_MFA_REQUIRED' });
    expect((await database.$transaction(tx => currentSecurityActor(tx, f.actor, f.website.id, false))).recentMfa).toBe(false);
    await database.session.update({ where: { id: f.session.id }, data: { mfaVerifiedAt: new Date(), revokedAt: new Date() } });
    await expect(database.$transaction(tx => currentSecurityActor(tx, f.actor, f.website.id, true))).rejects.toMatchObject({ code: 'SECURITY_ACTOR_REVOKED' });
    await database.session.update({ where: { id: f.session.id }, data: { revokedAt: null } });
    await database.rolePermission.deleteMany({ where: { roleId: f.role.id, permission: { key: 'websites.manage' } } });
    await expect(database.$transaction(tx => currentSecurityActor(tx, f.actor, f.website.id, true))).rejects.toMatchObject({ code: 'SECURITY_PERMISSION_REQUIRED' });
  });
  it('requires the current version of an authorized forced-command staging vault account', async () => {
    const f = await fixture(); const credential = await database.careCredential.create({ data: { tenantId: f.tenant.id, websiteId: f.website.id, environment: 'STAGING', kind: 'SSH', host: '198.18.0.1', username: 'codebandage-managed-target', authMethod: 'SSH_KEY', encryptedEnvelope: 'not-opened-by-authority-fixture', authorizedBy: f.user.id, authorizationExpiresAt: new Date(Date.now() + 60000) } });
    const enrollment: SecurityManagedEnrollment = { id: randomUUID(), revision: 1, tenantId: f.tenant.id, websiteId: f.website.id, actorId: f.user.id, label: 'Disposable staging authority fixture', environment: 'STAGING', adapter: 'MANAGED_STATIC_PERMISSION_V1', enabled: true, expiresAt: new Date(Date.now() + 60000).toISOString(), credentialId: credential.id, credentialVersion: 1, namespaceId: randomUUID(), targetId: randomUUID(), hostKeyFingerprint: `SHA256:${'a'.repeat(43)}`, attestationDigest: 'a'.repeat(64), implementationDigest: 'b'.repeat(64), allowanceMicros: 0, proof: { independentWriterExcluded: true, publisherReadOnly: true, rootOwned: true, forcedCommandOnly: true, recoveryEncrypted: true } };
    const registry = { async list() { return [enrollment]; } };
    expect((await database.$transaction(tx => currentSecurityEnrollment(tx, registry, f.actor, f.website.id, enrollment.id, 1))).credential.id).toBe(credential.id);
    await database.careCredential.update({ where: { id: credential.id }, data: { version: 2 } });
    await expect(database.$transaction(tx => currentSecurityEnrollment(tx, registry, f.actor, f.website.id, enrollment.id, 1))).rejects.toMatchObject({ code: 'SECURITY_GRANT_REQUIRED' });
    enrollment.credentialVersion = 2; enrollment.enabled = false;
    await expect(database.$transaction(tx => currentSecurityEnrollment(tx, registry, f.actor, f.website.id, enrollment.id, 1))).rejects.toMatchObject({ code: 'SECURITY_ENROLLMENT_REVOKED' });
  });
  it('requires paid immutable repair entitlement and immediately denies a successful refund', async () => {
    const f = await fixture();
    const { subscription, payment: createPayment } = await paidTerms(f, false);
    await expect(database.$transaction(tx => currentSecurityEntitlement(tx, f.tenant.id))).rejects.toMatchObject({ code: 'SECURITY_PAID_ENTITLEMENT_REQUIRED' });
    const payment = await createPayment();
    expect(await database.$transaction(tx => currentSecurityEntitlement(tx, f.tenant.id))).toMatchObject({ id: subscription.id, kind: 'PAID_SUBSCRIPTION' });
    await database.subscription.update({ where: { id: subscription.id }, data: { status: 'TRIALING' } });
    await expect(database.$transaction(tx => currentSecurityEntitlement(tx, f.tenant.id))).rejects.toMatchObject({ code: 'SECURITY_PAID_ENTITLEMENT_REQUIRED' });
    await database.subscription.update({ where: { id: subscription.id }, data: { status: 'ACTIVE' } });
    await database.paymentRefund.create({ data: { transactionId: payment.id, idempotencyKey: randomUUID(), amountMinor: 100, status: 'SUCCEEDED', completedAt: new Date() } });
    await expect(database.$transaction(tx => currentSecurityEntitlement(tx, f.tenant.id, subscription.id))).rejects.toMatchObject({ code: 'SECURITY_PAID_ENTITLEMENT_REQUIRED' });
  });
  it('binds real HTTP admission, encrypted checkpoints, both approvals and a separately approved restore to actual database authority', async () => {
    const f = await productJourneyFixture();
    try {
      const capabilities = await f.app.inject({ method: 'GET', url: `${f.prefix}/capabilities`, headers: { cookie: f.cookie } }); expect(capabilities.statusCode, capabilities.body).toBe(200); expect(capabilities.json().authority.canCreate).toBe(true);
      const id = await f.admit(); expect(f.remote.calls.observe).toBe(0); expect(f.remote.calls.commit).toBe(0);
      expect(await (await f.controller(id)).run({ mode: 'start' })).toMatchObject({ phase: 'AWAITING_APPROVAL', disposition: 'WAITING' });
      const plan = await f.detail(id); expect(plan.awaitingDecision).toBe('CANDIDATE'); expect(plan.plan.change).toMatchObject({ action: 'HARDEN', beforeMode: 0o666, afterMode: 0o664 }); expect(plan.plan).not.toHaveProperty('private');
      const otherToken = randomUUID(); await database.session.create({ data: { userId: f.user.id, tenantId: f.tenant.id, tokenHash: hashOpaqueToken(otherToken, f.secret), expiresAt: new Date(Date.now() + 60000), mfaVerifiedAt: new Date() } });
      const wrongSession = await f.app.inject({ method: 'POST', url: `${f.prefix}/runs/${id}/candidate-decisions`, headers: { cookie: `zerochack_session=${otherToken}` }, payload: { requestKey: randomUUID(), artifactId: plan.plan.artifactId, digest: plan.plan.digest, status: 'APPROVED' } });
      expect(wrongSession.statusCode).toBe(403); expect(wrongSession.json().error.code).toBe('SECURITY_ACTOR_BINDING_CHANGED'); expect(f.remote.calls.commit).toBe(0);
      const candidateId = await f.approve(id, 'candidate'); expect(await (await f.controller(id)).run({ mode: 'resume', decisionId: candidateId })).toMatchObject({ phase: 'AWAITING_APPROVAL', disposition: 'WAITING' });
      const proposal = await f.detail(id); expect(proposal.awaitingDecision).toBe('CHANGE'); expect(proposal.proposal.recovery).toMatchObject({ encrypted: true, verified: true }); expect(f.remote.calls.commit).toBe(0);
      const corrupted = await f.app.inject({ method: 'POST', url: `${f.prefix}/runs/${id}/change-decisions`, headers: { cookie: f.cookie }, payload: { requestKey: randomUUID(), artifactId: proposal.proposal.artifactId, digest: 'f'.repeat(64), status: 'APPROVED' } }); expect(corrupted.statusCode).toBe(409); expect(f.remote.calls.commit).toBe(0);
      const changeId = await f.approve(id, 'change'); expect(await (await f.controller(id)).run({ mode: 'resume', decisionId: changeId })).toMatchObject({ phase: 'COMPLETED', disposition: 'TERMINAL', checkpointConfirmed: true });
      const finished = await f.detail(id); expect(finished.result.change.action).toBe('HARDEN'); expect(f.remote.calls.commit).toBe(1); expect(f.remote.snapshot.mode).toBe(0o664);
      const checkpoints = await database.securityGraphCheckpoint.findMany({ where: { runId: id } }); expect(checkpoints.length).toBeGreaterThan(5); expect(JSON.stringify(checkpoints.map(row => row.encryptedEnvelope))).not.toContain('AWAITING_APPROVAL');
      const restoredId = await f.admit('RESTORE', id); expect(restoredId).not.toBe(id); expect(f.remote.calls.commit).toBe(1);
      expect(await (await f.controller(restoredId)).run({ mode: 'start' })).toMatchObject({ phase: 'AWAITING_APPROVAL' }); const restorePlan = await f.detail(restoredId); expect(restorePlan.plan.change).toMatchObject({ action: 'RESTORE', beforeMode: 0o664, afterMode: 0o666 });
      await (await f.controller(restoredId)).run({ mode: 'resume', decisionId: await f.approve(restoredId, 'candidate') }); expect(f.remote.calls.commit).toBe(1);
      expect(await (await f.controller(restoredId)).run({ mode: 'resume', decisionId: await f.approve(restoredId, 'change') })).toMatchObject({ phase: 'COMPLETED', disposition: 'TERMINAL' });
      expect(f.remote.calls.commit).toBe(2); expect(f.remote.snapshot.mode).toBe(0o666); expect((await f.detail(restoredId)).result.change.action).toBe('RESTORE');
      expect(await database.securityRepairRun.count({ where: { tenantId: f.tenant.id } })).toBe(2); expect(await database.securityRepairAttempt.count({ where: { tenantId: f.tenant.id, kind: { in: ['PRODUCTION_WRITE', 'RECOVERY_WRITE'] } } })).toBe(0);
    } finally { await f.app.close(); }
  });
  it('stops before a managed mutation when the exact change approval expires or the current session is revoked', async () => {
    for (const condition of ['EXPIRED_APPROVAL', 'REVOKED_SESSION'] as const) {
      const f = await productJourneyFixture();
      try {
        const id = await f.admit(); await (await f.controller(id)).run({ mode: 'start' }); await (await f.controller(id)).run({ mode: 'resume', decisionId: await f.approve(id, 'candidate') }); const decisionId = await f.approve(id, 'change');
        if (condition === 'EXPIRED_APPROVAL') { const now = Date.now(); await database.securityRepairDecision.update({ where: { id: decisionId }, data: { createdAt: new Date(now - 2000), expiresAt: new Date(now - 1000) } }); }
        else await database.session.update({ where: { id: f.session.id }, data: { revokedAt: new Date() } });
        const result = await (await f.controller(id)).run({ mode: 'resume', decisionId }); expect(result.phase).not.toBe('COMPLETED'); expect(f.remote.calls.commit).toBe(0); expect(f.remote.snapshot.mode).toBe(0o666);
        expect(await database.securityRepairAttempt.count({ where: { runId: id, stepKey: 'apply' } })).toBe(0);
      } finally { await f.app.close(); }
    }
  });
  it('retains an orphan encrypted admission on a conflicting job without starting a controller or remote work', async () => {
    const f = await productJourneyFixture();
    try {
      await database.careJob.create({ data: { tenantId: f.tenant.id, websiteId: f.website.id, userId: f.user.id, requestKey: randomUUID(), environment: 'STAGING', kind: 'REPAIR', state: 'WAITING_FOR_INPUT', summary: 'Existing fixture repair must retain its slot' } });
      const rejected = await f.app.inject({ method: 'POST', url: `${f.prefix}/runs`, headers: { cookie: f.cookie }, payload: { requestKey: randomUUID(), enrollmentId: f.enrollment.id, enrollmentRevision: 1, authorizationConfirmed: true } });
      expect(rejected.statusCode, rejected.body).toBe(409); expect(rejected.json().error.code).toBe('SECURITY_WEBSITE_WORK_CONFLICT'); expect(await database.securityRepairRun.count({ where: { tenantId: f.tenant.id } })).toBe(0);
      const admissions = await database.careArtifact.findMany({ where: { tenantId: f.tenant.id, kind: 'SEC_ADMISSION' } }); expect(admissions).toHaveLength(1); expect(admissions[0]!.encryptedBody).not.toContain('scope');
      expect(f.remote.calls).toEqual({ observe: 0, prepare: 0, exportRecovery: 0, commit: 0, mutationPermits: 0, recoveryExportPermits: 0 });
    } finally { await f.app.close(); }
  });
});
