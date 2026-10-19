import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { CareArtifact, CareCredential, Prisma, PrismaClient } from '@prisma/client';
import { sealSecret } from '@zerochack/care';
import { manifestDigest, type ArtifactReceipt, type SecurityScope } from '@zerochack/security-orchestration';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfiguredSecurityRepair } from './composition.js';
import * as managed from './managed-handlers.js';
import { operatorFixture } from './operator-registry.test-helper.js';

afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const f = operatorFixture(); const artifacts = new Map<string, CareArtifact>();
  const credential = { id: f.enrollment.credentialId, tenantId: f.enrollment.tenantId, websiteId: f.enrollment.websiteId, environment: 'STAGING', kind: 'SSH', status: 'STORED', version: 1, authorizedBy: f.enrollment.actorId, authorizationExpiresAt: new Date(f.enrollment.expiresAt), authMethod: 'SSH_KEY', username: f.attestation.access.username, host: f.attestation.access.address, port: f.attestation.access.port } as CareCredential;
  credential.encryptedEnvelope = sealSecret('synthetic-private-key-buffer-for-resolution-only-'.repeat(5), credential, f.environment.CARE_VAULT_KEY!);
  let applied: { artifactId: string; artifactDigest: string } | null = null;
  const authorize = vi.fn(async () => undefined);
  const tx = { $queryRaw: async () => [{ now: f.now }], securityRepairRun: { findFirst: async () => f.run }, careCredential: { findFirst: async () => credential }, securityRepairAttempt: { findFirst: async () => applied }, careArtifact: { findFirst: async ({ where }: { where: Record<string, unknown> }) => [...artifacts.values()].find(row => Object.entries(where).every(([key, value]) => (row as unknown as Record<string, unknown>)[key] === value)) ?? null } } as unknown as Prisma.TransactionClient;
  const database = { $transaction: async <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) => fn(tx), securityRepairRun: tx.securityRepairRun, careArtifact: tx.careArtifact } as unknown as PrismaClient;
  let dependencies: managed.ManagedSecurityDependencies | undefined;
  const original = managed.createManagedSecurityControllerSteps;
  vi.spyOn(managed, 'createManagedSecurityControllerSteps').mockImplementation((admission, deps) => { dependencies = deps; return original(admission, deps); });
  const configured = createConfiguredSecurityRepair(database, f.environment, f.workerId, { registry: f.registry });
  const controller = await configured.controllerFactory!(f.admission, authorize);
  f.run.inputDigest = controller.expectedCreateBinding.inputDigest;
  function save(body: unknown, kind: string): ArtifactReceipt {
    const bytes = Buffer.from(JSON.stringify(body)); const id = randomUUID(); const digest = createHash('sha256').update(bytes).digest('hex');
    const row = { id, tenantId: f.admission.scope.tenantId, websiteId: f.admission.scope.websiteId, environment: 'STAGING', kind, status: 'ACCEPTED', digest, expiresAt: null, createdBy: f.admission.actorId, sizeBytes: bytes.length } as CareArtifact;
    row.encryptedBody = sealSecret(bytes.toString('base64'), { ...row, version: 1 }, f.environment.CARE_ARTIFACT_KEY!); artifacts.set(id, row); return { artifactId: id, digest };
  }
  const admissionReceipt = save(f.admission, 'SEC_ADMISSION'); f.run.admissionArtifactId = admissionReceipt.artifactId; f.run.admissionDigest = admissionReceipt.digest;
  function evidence(stage: 'proposal' | 'apply' | 'post_verify'): ArtifactReceipt {
    const before = { device: '1', inode: '2', uid: 0 as const, gid: 0 as const, mode: 0o666, size: 1, mtimeNs: '1', ctimeNs: '2', digest: 'a'.repeat(64) };
    const binding = { scope: f.admission.scope, namespaceId: f.enrollment.namespaceId, targetId: f.enrollment.targetId }; const operationId = randomUUID(); const snapshotDigest = manifestDigest(before);
    const recoveryEnvelope = { version: 1, algorithm: 'AES-256-GCM', aad: { protocol: 1, ...binding, operationId, snapshotDigest }, iv: randomBytes(12).toString('base64'), ciphertext: 'AA==', tag: randomBytes(16).toString('base64') };
    const recoveryDigest = manifestDigest(recoveryEnvelope); const plan = { artifactId: randomUUID(), digest: 'b'.repeat(64) };
    const prepared = { ...binding, adapter: 'MANAGED_STATIC_PERMISSION_V1', state: 'PREPARED', operationId, action: 'HARDEN', planDigest: plan.digest, authorityDigest: f.admission.authorityDigest, snapshotDigest, recoveryDigest, challenge: 'c'.repeat(64), preparedAt: f.now.getTime(), before, targetMode: 0o664 };
    const result = stage === 'proposal' ? {} : { result: { ...prepared, state: 'VERIFIED', after: { ...before, mode: 0o664, ctimeNs: '3' }, verifiedAt: f.now.getTime() } };
    return save({ public: { version: 1, kind: stage === 'proposal' ? 'PROPOSAL' : 'RESULT', adapter: 'MANAGED_STATIC_PERMISSION_V1', summary: 'Synthetic encrypted stage receipt', environment: 'STAGING', enrollmentId: f.enrollment.id, enrollmentRevision: 1, change: { action: 'HARDEN', targetLabel: f.enrollment.label, beforeMode: before.mode, afterMode: 0o664, contentDigest: before.digest, preimageDigest: snapshotDigest }, recovery: { digest: recoveryDigest, encrypted: true, verified: true }, checks: [{ name: 'Immutable receipt fixture', passed: true }] }, private: { version: 1, scope: f.admission.scope, admissionDigest: manifestDigest(f.admission), stage, executor: binding, before, plan, prepared, recoveryEnvelope, ...result } }, 'SECURITY_EVIDENCE');
  }
  return { ...f, configured, controller, database, tx, credential, authorize, artifacts, save, evidence, get dependencies() { return dependencies!; }, applied(receipt: ArtifactReceipt) { applied = { artifactId: receipt.artifactId, artifactDigest: receipt.digest }; } };
}

describe('trusted security repair composition', () => {
  it('keeps the default executor unavailable and rejects production even with an internal registry seam', async () => {
    const f = operatorFixture(); const database = {} as PrismaClient;
    const disabled = createConfiguredSecurityRepair(database, { ...f.environment, SECURITY_REPAIR_ENABLED: false }, f.workerId, { registry: f.registry });
    expect(disabled.controllerFactory).toBeUndefined(); await expect(disabled.controllerForScope(f.admission.scope)).rejects.toMatchObject({ code: 'SECURITY_EXECUTOR_UNAVAILABLE' });
    const absent = createConfiguredSecurityRepair(database, { ...f.environment, SECURITY_REPAIR_CONFIG_FILE: undefined }, f.workerId);
    expect(absent.controllerFactory).toBeUndefined();
    const configured = createConfiguredSecurityRepair(database, f.environment, f.workerId, { registry: f.registry });
    await expect(configured.controllerForScope({ ...f.admission.scope, environment: 'PRODUCTION' } as SecurityScope)).rejects.toMatchObject({ code: 'UNREGISTERED_SECURITY_EXECUTOR' });
  });
  it('loads exactly the admitted artifact and reconstructs the same immutable controller binding', async () => {
    const f = await fixture(); const loaded = await f.configured.controllerForScope(f.admission.scope);
    expect(loaded.expectedCreateBinding).toEqual(f.controller.expectedCreateBinding);
    f.run.admissionDigest = 'a'.repeat(64);
    await expect(f.configured.controllerForScope(f.admission.scope)).rejects.toMatchObject({ code: 'SECURITY_ADMISSION_REQUIRED' });
  });
  it('requires full decrypted admission bytes and exact scope before staging mutation authority', async () => {
    const f = await fixture(); const ready = f.controller.stagingMutationPolicy!.assertReady; const receipt = f.evidence('proposal');
    await ready(f.tx, f.admission.scope, f.run, 'DECIDE', receipt); expect(f.authorize).toHaveBeenCalled();
    await expect(ready(f.tx, { ...f.admission.scope, websiteId: randomUUID() }, f.run, 'APPLY', receipt)).rejects.toMatchObject({ code: 'SECURITY_ADMISSION_BINDING_CHANGED' });
    f.artifacts.get(f.run.admissionArtifactId!)!.encryptedBody += '.corrupt';
    await expect(ready(f.tx, f.admission.scope, f.run, 'APPLY', receipt)).rejects.toMatchObject({ code: 'SECURITY_ADMISSION_INVALID' });
  });
  it('validates exact stage bytes at decision, apply settlement, post-verification entry and completion', async () => {
    const f = await fixture(); const ready = f.controller.stagingMutationPolicy!.assertReady;
    const proposal = f.evidence('proposal'), apply = f.evidence('apply'), final = f.evidence('post_verify');
    await ready(f.tx, f.admission.scope, f.run, 'DECIDE', proposal); await ready(f.tx, f.admission.scope, f.run, 'APPLY', proposal);
    await ready(f.tx, f.admission.scope, f.run, 'SETTLE', apply); f.applied(apply);
    await ready(f.tx, f.admission.scope, f.run, 'POST_VERIFY'); await ready(f.tx, f.admission.scope, f.run, 'POST_VERIFY', final);
    for (const [action, receipt] of [['SETTLE', proposal], ['DECIDE', apply], ['POST_VERIFY', apply]] as const) await expect(ready(f.tx, f.admission.scope, f.run, action, receipt)).rejects.toMatchObject({ code: 'SECURITY_ARTIFACT_BINDING_CHANGED' });
    await expect(ready(f.tx, f.admission.scope, f.run, 'APPLY', { artifactId: proposal.artifactId, digest: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'SECURITY_ARTIFACT_UNAVAILABLE' });
    f.artifacts.get(final.artifactId)!.encryptedBody += '.corrupt';
    await expect(ready(f.tx, f.admission.scope, f.run, 'POST_VERIFY', final)).rejects.toMatchObject({ code: 'SECURITY_ARTIFACT_INTEGRITY' });
  });
  it('opens only the currently authorized pinned staging vault credential and returns owned keys', async () => {
    const f = await fixture(); const runtime = await f.dependencies.resolveRuntime(f.admission);
    expect(runtime.access.address).toBe(f.attestation.access.address); expect(runtime.access.port).toBe(f.attestation.access.port); expect(runtime.access.privateKey.length).toBeGreaterThan(100); expect(runtime.permitKey.length).toBe(32);
    runtime.access.privateKey.fill(0); runtime.permitKey.fill(0); runtime.recoveryKey.fill(0);
    f.credential.host = '1.1.1.1';
    await expect(f.dependencies.resolveRuntime(f.admission)).rejects.toMatchObject({ code: 'SECURITY_GRANT_REQUIRED' });
    expect(f.buffers.get(f.entry.permitKeyFile)!.every(byte => byte === 0)).toBe(true); expect(f.buffers.get(f.entry.recoveryKeyFile)!.every(byte => byte === 0)).toBe(true);
    f.credential.host = f.attestation.access.address; f.credential.authorizationExpiresAt = new Date(f.now.getTime() - 1);
    await expect(f.dependencies.resolveRuntime(f.admission)).rejects.toMatchObject({ code: 'SECURITY_GRANT_REQUIRED' });
  });
});
