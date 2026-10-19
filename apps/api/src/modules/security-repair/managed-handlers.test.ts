import { randomUUID } from 'node:crypto';
import type { CareArtifact, Prisma, PrismaClient, SecurityRepairRun } from '@prisma/client';
import type { Environment } from '@zerochack/config';
import { manifestDigest, SecurityWorkflowError, type ArtifactReceipt, type SecurityWorkStep } from '@zerochack/security-orchestration';
import { describe, expect, it } from 'vitest';
import { readArtifact, writeArtifact } from '../care/repair-service.js';
import type { SecurityStepContext } from './controller.js';
import { createManagedSecurityControllerSteps, readManagedSecurityArtifact, type ManagedSecurityDependencies } from './managed-handlers.js';
import { createManagedTargetTestFixture } from './managed-fixture.test-helper.js';
import { type SecurityRepairAdmission, SECURITY_MANAGED_ADAPTER } from './product-contracts.js';

// Real artifact encryption and handler/authority contracts, with an in-memory DB
// and broker. These tests do not claim SSH/filesystem or PostgreSQL integration.
function matches(row: Record<string, unknown>, where: Record<string, unknown>) { return Object.entries(where).every(([key, expected]) => expected && typeof expected === 'object' && 'not' in expected ? row[key] !== expected.not : expected && typeof expected === 'object' ? true : row[key] === expected); }
function fixture() {
  let scope = { tenantId: randomUUID(), websiteId: randomUUID(), environment: 'STAGING' as const, runId: randomUUID() };
  const actorId = randomUUID(), sessionId = randomUUID(), fence = { ownerId: randomUUID(), version: 1, expiresAt: new Date(Date.now() + 60000) };
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  const enrollment: SecurityRepairAdmission['enrollment'] = { id: randomUUID(), revision: 1, tenantId: scope.tenantId, websiteId: scope.websiteId, actorId, label: 'Synthetic managed staging target', environment: 'STAGING', adapter: SECURITY_MANAGED_ADAPTER, enabled: true, expiresAt, credentialId: randomUUID(), credentialVersion: 1, namespaceId: randomUUID(), targetId: randomUUID(), hostKeyFingerprint: `SHA256:${'A'.repeat(43)}`, attestationDigest: '1'.repeat(64), implementationDigest: '2'.repeat(64), allowanceMicros: 0, proof: { independentWriterExcluded: true, publisherReadOnly: true, rootOwned: true, forcedCommandOnly: true, recoveryEncrypted: true } };
  let admission: SecurityRepairAdmission = { version: 1, scope, actorId, sessionId, requestKey: randomUUID(), operation: 'HARDEN', recoveryRunId: null, enrollment, enrollmentDigest: manifestDigest(enrollment), entitlement: { kind: 'PAID_SUBSCRIPTION', id: randomUUID(), packageVersionId: randomUUID(), termsDigest: '3'.repeat(64), expiresAt }, authorityDigest: '4'.repeat(64), requestDigest: '5'.repeat(64), implementationDigest: enrollment.implementationDigest, allowanceMicros: 0, expiresAt };
  let run = { id: scope.runId, tenantId: scope.tenantId, websiteId: scope.websiteId, environment: 'STAGING', actorId, sessionId, authorityDigest: admission.authorityDigest, phase: 'PLANNING', expiresAt: new Date(expiresAt), leaseOwnerId: fence.ownerId, leaseVersion: fence.version, leaseExpiresAt: fence.expiresAt } as SecurityRepairRun;
  const runs = new Map([[run.id, run]]);
  const artifacts = new Map<string, CareArtifact>();
  type Attempt = Record<string, unknown> & { id: string; stepKey: SecurityWorkStep; state: 'STARTED' | 'SUCCEEDED'; artifactId?: string; artifactDigest?: string };
  const attempts = new Map<string, Attempt>();
  const decisions: Array<Record<string, unknown>> = [];
  const tx = { $queryRaw: async () => [{ now: new Date() }], securityRepairRun: { findFirst: async ({ where }: { where: Record<string, unknown> }) => [...runs.values()].find(row => matches(row as unknown as Record<string, unknown>, where)) ?? null }, securityRepairAttempt: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => [...attempts.values()].find(row => matches(row, where)) ?? null,
    count: async ({ where }: { where: Record<string, unknown> }) => [...attempts.values()].filter(row => matches(row, where)).length
  }, securityRepairDecision: { findFirst: async ({ where }: { where: Record<string, unknown> }) => decisions.find(row => matches(row, where)) ?? null }, careArtifact: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => [...artifacts.values()].find(row => matches(row as unknown as Record<string, unknown>, where)) ?? null,
    aggregate: async () => ({ _count: artifacts.size, _sum: { sizeBytes: [...artifacts.values()].reduce((sum, row) => sum + row.sizeBytes, 0) } }),
    create: async ({ data }: { data: Record<string, unknown> }) => { const saved = { ...data, createdAt: new Date() } as unknown as CareArtifact; artifacts.set(saved.id, saved); return saved; }
  } } as unknown as Prisma.TransactionClient;
  const database = { $transaction: async <T>(fn: (value: Prisma.TransactionClient) => Promise<T>) => fn(tx) } as unknown as PrismaClient;
  const environment = { CARE_ARTIFACT_KEY: Buffer.alloc(32, 12).toString('base64') } as Environment;
  const remote = createManagedTargetTestFixture();
  let allowed = true;
  const dependencies: ManagedSecurityDependencies = { database, environment, async authorize() { if (!allowed) throw new SecurityWorkflowError('SECURITY_TEST_REVOKED'); }, resolveRuntime: remote.resolveRuntime, brokerFactory: remote.brokerFactory };
  let steps = createManagedSecurityControllerSteps(admission, dependencies);
  let receipt: ArtifactReceipt | undefined;
  async function execute(step: SecurityWorkStep, inputReceipt = receipt) {
    run.phase = ({ plan: 'PLANNING', snapshot: 'SNAPSHOTTING', candidate: 'CANDIDATE_WORK', verify: 'VERIFYING', proposal: 'READY_FOR_RELEASE', apply: 'APPLYING', post_verify: 'POST_VERIFYING' } as const)[step];
    const attempt: Attempt = { ...scope, id: randomUUID(), stepKey: step, state: 'STARTED', attemptNumber: 1, kind: step === 'apply' ? admission.operation === 'RESTORE' ? 'STAGING_RECOVERY' : 'STAGING_WRITE' : 'READ' };
    attempts.set(attempt.id, attempt);
    const controller = new AbortController();
    const context: SecurityStepContext = { scope, fence, attemptId: attempt.id, signal: controller.signal, ...(inputReceipt ? { previous: inputReceipt } : {}), async assertCurrent() { if (!allowed) throw new SecurityWorkflowError('SECURITY_TEST_REVOKED'); } };
    const output = await steps[step].execute(context);
    if (output.outcome !== 'SUCCEEDED') throw new Error('Fixture blocked');
    attempt.state = 'SUCCEEDED'; attempt.artifactId = output.artifact.artifactId; attempt.artifactDigest = output.artifact.digest;
    receipt = output.artifact; return output.artifact;
  }
  function approve(kind: 'CANDIDATE' | 'PRODUCTION', expected = receipt!) { decisions.push({ ...scope, id: randomUUID(), kind, actorId, sessionId, status: 'APPROVED', artifactId: expected.artifactId, digest: expected.digest, expiresAt: new Date(Date.now() + 60000) }); }
  async function proposal() { await execute('plan'); approve('CANDIDATE'); await execute('snapshot'); await execute('candidate'); await execute('verify'); return execute('proposal'); }
  return { get admission() { return admission; }, get run() { return run; }, artifacts, attempts, decisions, dependencies, permits: remote.permits, tx, environment, execute, approve, proposal, get receipt() { return receipt!; }, get snapshot() { return remote.snapshot; }, get commitCount() { return remote.calls.commit; }, get observeCount() { return remote.calls.observe; }, get exportCount() { return remote.calls.exportRecovery; }, get mutationPermitCount() { return remote.calls.mutationPermits; }, get exportPermitCount() { return remote.calls.recoveryExportPermits; }, revoke() { allowed = false; }, drift() { remote.drift(); }, loseAck() { remote.loseNextCommitAck(); }, beforePermit(work: () => void) { remote.beforePermit(work); }, beforeExportPermit(work: () => void) { remote.beforeExportPermit(work); }, restart() { steps = createManagedSecurityControllerSteps(admission, dependencies); },
    async beginSeparateRestore() {
      const original = admission;
      const saved = await writeArtifact(tx, { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: 'STAGING', jobId: null, createdBy: actorId }, Buffer.from(JSON.stringify(original)), 'SEC_ADMISSION', 'admission.json', 'application/json', environment);
      run.admissionArtifactId = saved.id; run.admissionDigest = saved.digest; run.executionProfile = SECURITY_MANAGED_ADAPTER; run.phase = 'COMPLETED';
      const oldRunId = scope.runId; scope = { ...scope, runId: randomUUID() };
      admission = { ...original, scope, requestKey: randomUUID(), operation: 'RESTORE', recoveryRunId: oldRunId };
      run = { ...run, id: scope.runId, phase: 'PLANNING', admissionArtifactId: null, admissionDigest: null };
      runs.set(run.id, run); receipt = undefined; steps = createManagedSecurityControllerSteps(admission, dependencies);
    } };
}

describe('managed staging permission product handlers', () => {
  it('persists encrypted evidence, reopens it after restart and executes the exact approved permission-only flow', async () => {
    const f = fixture(); await f.proposal(); f.restart(); f.approve('PRODUCTION'); await f.execute('apply'); await f.execute('post_verify');
    expect(f.snapshot.mode).toBe(0o664); expect(f.commitCount).toBe(1); expect(f.exportCount).toBe(1); expect(f.observeCount).toBe(3);
    expect(f.artifacts.size).toBe(7);
    for (const artifact of f.artifacts.values()) { expect(artifact.encryptedBody).toMatch(/^zr1\./u); expect(artifact.encryptedBody).not.toContain('Synthetic'); }
    const final = await readManagedSecurityArtifact(f.tx, f.admission, f.receipt, f.environment, 'post_verify');
    expect(final.private.recoveryEnvelope?.ciphertext).toBeTruthy(); expect(final.private.result?.after.mode).toBe(0o664); expect(final.public.checks.every(c => c.passed)).toBe(true);
    expect(final.public.change.contentDigest).toBe(final.private.result?.after.digest);
  });
  it('restores the exact prior verified change only through a new run with fresh approvals', async () => {
    const f = fixture(); await f.proposal(); f.approve('PRODUCTION'); await f.execute('apply'); await f.execute('post_verify');
    const originalRunId = f.admission.scope.runId; await f.beginSeparateRestore();
    expect(f.admission.scope.runId).not.toBe(originalRunId); expect(f.admission.recoveryRunId).toBe(originalRunId);
    await f.proposal(); f.approve('PRODUCTION'); await f.execute('apply'); await f.execute('post_verify');
    expect(f.snapshot.mode).toBe(0o666); expect(f.commitCount).toBe(2);
    const final = await readManagedSecurityArtifact(f.tx, f.admission, f.receipt, f.environment, 'post_verify');
    expect(final.public.change.action).toBe('RESTORE'); expect(final.private.executor.scope.runId).toBe(originalRunId); expect(final.private.scope.runId).toBe(f.admission.scope.runId);
  });
  it('refuses a mismatched local recovery key before retaining unverified recovery or issuing a mutation', async () => {
    const f = fixture(); const resolve = f.dependencies.resolveRuntime;
    f.dependencies.resolveRuntime = async admission => { const runtime = await resolve(admission); runtime.recoveryKey.fill(99); return runtime; };
    await f.execute('plan'); f.approve('CANDIDATE');
    await expect(f.execute('snapshot')).rejects.toMatchObject({ code: 'SECURITY_RECOVERY_INTEGRITY' });
    expect(f.artifacts.size).toBe(1); expect(f.commitCount).toBe(0);
  });
  it('refuses an unapproved candidate before preparing remote recovery', async () => {
    const f = fixture(); await f.execute('plan');
    await expect(f.execute('snapshot')).rejects.toMatchObject({ code: 'SECURITY_DECISION_BINDING_CHANGED' }); expect(f.exportCount).toBe(0); expect(f.commitCount).toBe(0);
  });
  it('refuses a changed proposal approval immediately before signing', async () => {
    const f = fixture(); await f.proposal(); f.approve('PRODUCTION');
    f.beforePermit(() => { f.decisions.find(d => d.kind === 'PRODUCTION')!.digest = '0'.repeat(64); });
    await expect(f.execute('apply')).rejects.toMatchObject({ code: 'SECURITY_DECISION_BINDING_CHANGED' }); expect(f.commitCount).toBe(0); expect(f.snapshot.mode).toBe(0o666);
  });
  it('refuses an exact proposal approval expiring during runtime resolution before signing', async () => {
    const f = fixture(); await f.proposal(); f.approve('PRODUCTION'); const resolve = f.dependencies.resolveRuntime;
    f.dependencies.resolveRuntime = async admission => { const runtime = await resolve(admission); f.decisions.find(d => d.kind === 'PRODUCTION')!.expiresAt = new Date(0); return runtime; };
    await expect(f.execute('apply')).rejects.toMatchObject({ code: 'SECURITY_DECISION_EXPIRED' });
    expect(f.mutationPermitCount).toBe(0); expect(f.commitCount).toBe(0); expect(f.snapshot.mode).toBe(0o666);
  });
  it('refuses an exact candidate approval expiring immediately before recovery export signing', async () => {
    const f = fixture(); await f.execute('plan'); f.approve('CANDIDATE');
    f.beforeExportPermit(() => { f.decisions.find(d => d.kind === 'CANDIDATE')!.expiresAt = new Date(0); });
    await expect(f.execute('snapshot')).rejects.toMatchObject({ code: 'SECURITY_DECISION_EXPIRED' });
    expect(f.exportPermitCount).toBe(0); expect(f.exportCount).toBe(0); expect(f.commitCount).toBe(0);
  });
  it('caps the encrypted recovery export permit at its exact candidate approval expiry', async () => {
    const f = fixture(); await f.execute('plan'); f.approve('CANDIDATE');
    const expiresAt = new Date(Date.now() + 2000); f.decisions.find(d => d.kind === 'CANDIDATE')!.expiresAt = expiresAt;
    await f.execute('snapshot'); expect(f.permits.recoveryExport?.payload.expiresAt).toBe(expiresAt.getTime());
  });
  it.each(['CANDIDATE', 'PRODUCTION'] as const)('caps the mutation permit at the earlier %s approval expiry', async kind => {
    const f = fixture(); await f.proposal(); f.approve('PRODUCTION');
    const expiresAt = new Date(Date.now() + 2000); f.decisions.find(d => d.kind === kind)!.expiresAt = expiresAt;
    await f.execute('apply'); expect(f.permits.mutation?.payload.expiresAt).toBe(expiresAt.getTime()); expect(f.commitCount).toBe(1);
  });
  it('refuses an approval whose expiry exceeds its admitted run authority', async () => {
    const f = fixture(); await f.execute('plan'); f.approve('CANDIDATE'); f.decisions[0]!.expiresAt = new Date(f.run.expiresAt.getTime() + 1);
    await expect(f.execute('snapshot')).rejects.toMatchObject({ code: 'SECURITY_DECISION_EXPIRED' }); expect(f.exportPermitCount).toBe(0);
  });
  it('rechecks current actor authority after prepare and before the mutation permit', async () => {
    const f = fixture(); await f.proposal(); f.approve('PRODUCTION'); f.beforePermit(() => f.revoke());
    await expect(f.execute('apply')).rejects.toMatchObject({ code: 'SECURITY_TEST_REVOKED' }); expect(f.commitCount).toBe(0);
  });
  it('refuses a rotated fence even if an old caller carries the approved proposal', async () => {
    const f = fixture(); await f.proposal(); f.approve('PRODUCTION'); f.run.leaseVersion++;
    await expect(f.execute('apply')).rejects.toMatchObject({ code: 'SECURITY_LEASE_LOST' }); expect(f.commitCount).toBe(0);
  });
  it('does not retry a lost commit acknowledgement and retains the recoverable prepared receipt', async () => {
    const f = fixture(); await f.proposal(); f.approve('PRODUCTION'); f.loseAck();
    await expect(f.execute('apply')).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(f.commitCount).toBe(1); expect(f.snapshot.mode).toBe(0o664);
    f.restart(); await expect(f.execute('apply')).rejects.toMatchObject({ code: 'SECURITY_EFFECT_UNRESOLVED' }); expect(f.commitCount).toBe(1);
    const proposal = await readManagedSecurityArtifact(f.tx, f.admission, f.receipt, f.environment, 'proposal'); expect(proposal.private.prepared?.operationId).toBeTruthy(); expect(proposal.private.recoveryEnvelope).toBeTruthy();
  });
  it('detects unchanged-content metadata drift before presenting a release proposal', async () => {
    const f = fixture(); await f.execute('plan'); f.approve('CANDIDATE'); await f.execute('snapshot'); await f.execute('candidate'); f.drift();
    await expect(f.execute('verify')).rejects.toMatchObject({ code: 'SECURITY_TARGET_DRIFT' }); expect(f.commitCount).toBe(0);
  });
  it('fails closed on ciphertext corruption rather than treating metadata as recovery proof', async () => {
    const f = fixture(); await f.proposal(); f.approve('PRODUCTION'); const record = f.artifacts.get(f.receipt.artifactId)!;
    record.encryptedBody = record.encryptedBody.slice(0, -8) + 'AAAAAAAA';
    await expect(f.execute('apply')).rejects.toMatchObject({ code: 'SECURITY_ARTIFACT_INTEGRITY' }); expect(f.commitCount).toBe(0);
  });
  it('rejects cross-run evidence despite identical target enrollment and actor', async () => {
    const f = fixture(); await f.proposal(); const other = { ...f.admission, scope: { ...f.admission.scope, runId: randomUUID() } };
    await expect(readManagedSecurityArtifact(f.tx, other, f.receipt, f.environment)).rejects.toMatchObject({ code: 'SECURITY_ARTIFACT_BINDING_CHANGED' });
  });
  it('retains exact recovery bytes in ciphertext and never puts ciphertext or inode metadata in public evidence', async () => {
    const f = fixture(); await f.proposal(); const artifact = f.artifacts.get(f.receipt.artifactId)!;
    const wrapper = JSON.parse(readArtifact(artifact, f.environment).toString('utf8'));
    expect(wrapper.private.recoveryEnvelope.algorithm).toBe('AES-256-GCM'); expect(wrapper.private.recoveryEnvelope.aad.operationId).toBe(wrapper.private.prepared.operationId);
    const visible = JSON.stringify(wrapper.public); expect(visible).not.toContain('ciphertext'); expect(visible).not.toContain('inode'); expect(visible).not.toContain('credentialId');
  });
});
