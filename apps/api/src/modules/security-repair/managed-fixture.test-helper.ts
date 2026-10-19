// Test-only simulated remote. No network, shell, customer target or filesystem.
// Real AES-GCM envelopes let product/DB integration test independent recovery
// verification without falsely treating this as the disposable SSH helper proof.
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { manifestDigest } from '@zerochack/security-orchestration';
import type { ManagedPrepared, ManagedRecoveryEnvelope, ManagedResult, ManagedSnapshot, ManagedPermit } from '../../../../../infrastructure/security-managed-target/broker.cjs';
import type { ManagedSecurityDependencies } from './managed-handlers.js';
import { SECURITY_MANAGED_ADAPTER } from './product-contracts.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function same(left: unknown, right: unknown) { return canonical(left) === canonical(right); }
function requireTest(value: unknown, message: string): asserts value { if (!value) throw new Error(`SIMULATED_MANAGED_${message}`); }

export function createManagedTargetTestFixture() {
  const content = Buffer.from('<h1>Synthetic managed staging fixture only</h1>');
  const permitKey = Buffer.alloc(32, 24), recoveryKey = Buffer.alloc(32, 25);
  let current: ManagedSnapshot = { device: '1', inode: '2', uid: 0, gid: 0, mode: 0o666, size: content.length, mtimeNs: '3', ctimeNs: '4', digest: createHash('sha256').update(content).digest('hex') };
  const operations = new Map<string, { prepared: ManagedPrepared; envelope: ManagedRecoveryEnvelope; result?: ManagedResult }>();
  const calls = { observe: 0, prepare: 0, exportRecovery: 0, commit: 0, mutationPermits: 0, recoveryExportPermits: 0 };
  const permits: { mutation?: ManagedPermit; recoveryExport?: ManagedPermit } = {};
  let beforeExportPermit: (() => void | Promise<void>) | undefined;
  let beforePermit: (() => void | Promise<void>) | undefined;
  let loseAck = false;
  function verifyPermit(permit: ManagedPermit, prepared: ManagedPrepared, purpose?: string, exportId?: string) {
    const payload = permit.payload;
    requireTest(permit.mac === createHmac('sha256', permitKey).update(canonical(payload)).digest('hex'), 'BAD_PERMIT');
    for (const field of ['adapter', 'scope', 'namespaceId', 'targetId', 'operationId', 'action', 'planDigest', 'authorityDigest', 'snapshotDigest', 'recoveryDigest', 'targetMode', 'challenge'] as const) requireTest(same(payload[field], prepared[field]), 'BAD_PERMIT_BINDING');
    requireTest(payload.version === 1 && Number.isSafeInteger(payload.issuedAt) && Number.isSafeInteger(payload.expiresAt), 'BAD_PERMIT_CLOCK');
    requireTest((payload.issuedAt as number) >= prepared.preparedAt && (payload.issuedAt as number) <= Date.now() && (payload.expiresAt as number) > Date.now() && (payload.expiresAt as number) - (payload.issuedAt as number) <= 15000, 'EXPIRED_PERMIT');
    if (purpose) requireTest(payload.purpose === purpose && payload.exportId === exportId, 'BAD_PERMIT_PURPOSE');
    else requireTest(!('purpose' in payload) && !('exportId' in payload), 'CROSS_PURPOSE_PERMIT');
  }
  const resolveRuntime: ManagedSecurityDependencies['resolveRuntime'] = async admission => ({ access: { address: '8.8.8.8', port: 22, username: 'codebandage-managed-target', hostKeyFingerprint: admission.enrollment.hostKeyFingerprint, privateKey: Buffer.alloc(200, 21) }, permitKey: Buffer.from(permitKey), recoveryKey: Buffer.from(recoveryKey) });
  const brokerFactory: NonNullable<ManagedSecurityDependencies['brokerFactory']> = (_access, authority) => ({
    async observe() { calls.observe++; return { adapter: SECURITY_MANAGED_ADAPTER, state: 'OBSERVED', snapshot: { ...current }, snapshotDigest: manifestDigest(current) }; },
    async prepare(input) {
      requireTest(same(input.expectedSnapshot, current), 'TARGET_DRIFT');
      requireTest(!operations.has(input.operationId), 'OPERATION_EXISTS');
      if (input.action === 'RESTORE') {
        const original = operations.get(input.recoveryOperationId);
        requireTest(original?.result?.state === 'VERIFIED' && original.prepared.action === 'HARDEN' && same(original.result.after, current) && same(original.prepared.scope, input.scope), 'RESTORE_MISMATCH');
      }
      const targetMode = input.action === 'HARDEN' ? current.mode & ~0o002 : current.mode | 0o002;
      requireTest(targetMode !== current.mode, 'NOT_APPLICABLE');
      const aad: ManagedRecoveryEnvelope['aad'] = { protocol: 1, scope: input.scope, namespaceId: input.namespaceId, targetId: input.targetId, operationId: input.operationId, snapshotDigest: manifestDigest(current) };
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', recoveryKey, iv); cipher.setAAD(Buffer.from(canonical(aad)));
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(canonical({ snapshot: current, bytes: content.toString('base64') }))), cipher.final()]);
      const envelope: ManagedRecoveryEnvelope = { version: 1, algorithm: 'AES-256-GCM', aad, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
      const prepared: ManagedPrepared = { scope: input.scope, namespaceId: input.namespaceId, targetId: input.targetId, adapter: SECURITY_MANAGED_ADAPTER, state: 'PREPARED', operationId: input.operationId, action: input.action, planDigest: input.planDigest, authorityDigest: input.authorityDigest, before: { ...current }, snapshotDigest: manifestDigest(current), recoveryDigest: createHash('sha256').update(canonical(envelope)).digest('hex'), challenge: randomBytes(32).toString('hex'), preparedAt: Date.now(), targetMode };
      operations.set(prepared.operationId, { prepared, envelope }); calls.prepare++; return structuredClone(prepared);
    },
    async exportRecovery(prepared, exportId, signal) {
      requireTest(authority?.authorizeAndIssueRecoveryExportPermit, 'EXPORT_NOT_AUTHORIZED');
      requireTest(exportId !== prepared.operationId, 'EXPORT_ID_REUSED');
      await beforeExportPermit?.();
      const permit = await authority.authorizeAndIssueRecoveryExportPermit({ prepared, exportId }, signal);
      calls.recoveryExportPermits++; permits.recoveryExport = structuredClone(permit);
      verifyPermit(permit, prepared, 'RECOVERY_EXPORT_V1', exportId);
      const operation = operations.get(prepared.operationId); requireTest(operation && same(operation.prepared, prepared), 'PREPARATION_CHANGED');
      calls.exportRecovery++;
      return { version: 1, adapter: SECURITY_MANAGED_ADAPTER, state: 'RECOVERY_EXPORTED', scope: prepared.scope, namespaceId: prepared.namespaceId, targetId: prepared.targetId, operationId: prepared.operationId, exportId, planDigest: prepared.planDigest, authorityDigest: prepared.authorityDigest, snapshotDigest: prepared.snapshotDigest, recoveryDigest: prepared.recoveryDigest, before: prepared.before, envelope: structuredClone(operation.envelope), exportedAt: Date.now() };
    },
    async commit(prepared, signal) {
      await beforePermit?.(); requireTest(authority?.authorizeAndIssuePermit, 'COMMIT_NOT_AUTHORIZED');
      const permit = await authority.authorizeAndIssuePermit(prepared, signal);
      calls.mutationPermits++; permits.mutation = structuredClone(permit);
      verifyPermit(permit, prepared);
      const operation = operations.get(prepared.operationId); requireTest(operation && !operation.result && same(operation.prepared, prepared) && same(prepared.before, current), 'REPLAY_OR_DRIFT');
      calls.commit++; current = { ...current, mode: prepared.targetMode, ctimeNs: String(Number(current.ctimeNs) + 1) };
      operation.result = { ...prepared, state: 'VERIFIED', after: { ...current }, verifiedAt: Date.now() };
      if (loseAck) { loseAck = false; throw Object.assign(new Error('OUTCOME_UNKNOWN'), { code: 'OUTCOME_UNKNOWN', uncertain: true }); }
      return structuredClone(operation.result);
    },
    async status(input) { const operation = operations.get(input.operationId); requireTest(operation, 'NO_SUCH_OPERATION'); return structuredClone(operation.result ?? operation.prepared); },
    async inspectReconciliation() { throw new Error('SIMULATED_MANAGED_RECONCILIATION_NOT_IMPLEMENTED'); },
    async reconcile() { throw new Error('SIMULATED_MANAGED_RECONCILIATION_NOT_IMPLEMENTED'); },
    async reconciliationStatus() { throw new Error('SIMULATED_MANAGED_RECONCILIATION_NOT_IMPLEMENTED'); }
  });
  return { resolveRuntime, brokerFactory, calls, permits, get snapshot() { return { ...current }; }, drift() { current = { ...current, ctimeNs: String(Number(current.ctimeNs) + 100) }; }, beforePermit(work: () => void | Promise<void>) { beforePermit = work; }, beforeExportPermit(work: () => void | Promise<void>) { beforeExportPermit = work; }, loseNextCommitAck() { loseAck = true; } };
}
