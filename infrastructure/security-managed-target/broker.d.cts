export type ManagedScope = Readonly<{ tenantId: string; websiteId: string; environment: 'STAGING'; runId: string }>;
export type ManagedBinding = Readonly<{ scope: ManagedScope; namespaceId: string; targetId: string }>;
export type ManagedSnapshot = Readonly<{ device: string; inode: string; uid: 0; gid: 0; mode: number; size: number; mtimeNs: string; ctimeNs: string; digest: string }>;
export type ManagedPrepared = ManagedBinding & Readonly<{ adapter: 'MANAGED_STATIC_PERMISSION_V1'; state: 'PREPARED'; operationId: string; action: 'HARDEN' | 'RESTORE'; planDigest: string; authorityDigest: string; snapshotDigest: string; recoveryDigest: string; challenge: string; preparedAt: number; before: ManagedSnapshot; targetMode: number }>;
export type ManagedObserved = Readonly<{ adapter: 'MANAGED_STATIC_PERMISSION_V1'; state: 'OBSERVED'; snapshot: ManagedSnapshot; snapshotDigest: string }>;
export type ManagedResult = Omit<ManagedPrepared, 'state'> & Readonly<{ state: 'VERIFIED' | 'OUTCOME_UNKNOWN'; after?: ManagedSnapshot; verifiedAt?: number }>;
export type ManagedPermit = Readonly<{ payload: Readonly<Record<string, unknown>>; mac: string }>;
export type ManagedPreparation = ManagedBinding & Readonly<{ operationId: string; planDigest: string; authorityDigest: string; expectedSnapshot: ManagedSnapshot }> & ({ action: 'HARDEN' } | { action: 'RESTORE'; recoveryOperationId: string });
export type ManagedAccess = Readonly<{ address: string; port: number; username: 'codebandage-managed-target'; hostKeyFingerprint: string; privateKey: Buffer }>;
export type ManagedReconciliationInput = ManagedBinding & Readonly<{ operationId: string; reconciliationId: string }>;
export type ManagedReconciliationObservation = ManagedReconciliationInput & Readonly<{
  version: 1; adapter: 'MANAGED_STATIC_PERMISSION_V1'; state: 'RECONCILIATION_OBSERVED'; sourceState: 'INTENT' | 'OUTCOME_UNKNOWN';
  sourceDigest: string; sourceSnapshotDigest: string; recoveryDigest: string; action: 'HARDEN' | 'RESTORE'; targetMode: number;
  before: ManagedSnapshot; current: ManagedSnapshot; currentSnapshotDigest: string;
  classification: 'MATCHES_BEFORE' | 'MATCHES_EXPECTED_POSTIMAGE' | 'DRIFT'; observedAt: number; challenge: string;
}>;
export type ManagedReconciliationReceipt = Readonly<{
  version: 1; adapter: 'MANAGED_STATIC_PERMISSION_V1'; state: 'RECONCILED_OBSERVATION_ONLY';
  observation: ManagedReconciliationObservation; permitDigest: string; recordedAt: number; receiptDigest: string;
}>;
export type ManagedBroker = Readonly<{
  observe(binding: ManagedBinding, signal?: AbortSignal): Promise<ManagedObserved>;
  prepare(input: ManagedPreparation, signal?: AbortSignal): Promise<ManagedPrepared>;
  commit(prepared: ManagedPrepared, signal?: AbortSignal): Promise<ManagedResult>;
  status(binding: ManagedBinding & { operationId: string }, signal?: AbortSignal): Promise<ManagedPrepared | ManagedResult>;
  inspectReconciliation(input: ManagedReconciliationInput, signal?: AbortSignal): Promise<ManagedReconciliationObservation>;
  reconcile(observation: ManagedReconciliationObservation, signal?: AbortSignal): Promise<ManagedReconciliationReceipt>;
  reconciliationStatus(input: ManagedReconciliationInput, signal?: AbortSignal): Promise<ManagedReconciliationReceipt>;
}>;
export class ManagedTargetError extends Error { code: string; uncertain: boolean; }
/** No production authority/registration is supplied by this module. */
export function createManagedTargetBroker(access: ManagedAccess, dependencies?: {
  authorizeAndIssuePermit?: (prepared: ManagedPrepared, signal?: AbortSignal) => Promise<ManagedPermit>;
  authorizeAndIssueReconciliationPermit?: (observation: ManagedReconciliationObservation, signal?: AbortSignal) => Promise<ManagedPermit>;
}): ManagedBroker;
export const COMMAND: 'codebandage-managed-target-v1';
export const RECONCILIATION_PURPOSE: 'OBSERVATION_RECONCILIATION_V1';
