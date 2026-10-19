import { createHash } from 'node:crypto';
import { z } from 'zod';

export const SECURITY_WORKFLOW_POLICY = 'security-workflow-v1' as const;
export const uuid = z.string().uuid().transform(value => value.toLowerCase());
export const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
export const scopeSchema = z.object({ tenantId: uuid, websiteId: uuid, environment: z.enum(['PRODUCTION', 'STAGING']), runId: uuid }).strict();
export type SecurityScope = z.infer<typeof scopeSchema>;
export const phases = ['PLANNING', 'WAITING_FOR_INPUT', 'AWAITING_APPROVAL', 'SNAPSHOTTING', 'CANDIDATE_WORK', 'VERIFYING', 'READY_FOR_RELEASE', 'APPLYING', 'POST_VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED', 'STALE', 'OUTCOME_UNKNOWN'] as const;
export type SecurityPhase = typeof phases[number];
export const workSteps = ['plan', 'snapshot', 'candidate', 'verify', 'proposal', 'apply', 'post_verify'] as const;
export type SecurityWorkStep = typeof workSteps[number];
export const effectKinds = ['READ', 'MODEL', 'SANDBOX', 'PRODUCTION_WRITE', 'RECOVERY_WRITE', 'STAGING_WRITE', 'STAGING_RECOVERY'] as const;
export type SecurityEffectKind = typeof effectKinds[number];
export const artifactReceiptSchema = z.object({ artifactId: uuid, digest: sha256 }).strict();
export type ArtifactReceipt = z.infer<typeof artifactReceiptSchema>;
export const stepResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('SUCCEEDED'), artifact: artifactReceiptSchema, costMicros: z.number().int().min(0).max(100_000_000) }).strict(),
  z.object({ outcome: z.literal('BLOCKED'), code: z.string().regex(/^[A-Z][A-Z0-9_]{2,79}$/u) }).strict()
]);
export type SecurityStepResult = z.infer<typeof stepResultSchema>;
export const resumeSchema = z.object({ decisionId: uuid }).strict();
export type SecurityDecisionKind = 'CANDIDATE' | 'PRODUCTION' | 'RECOVERY';

export class SecurityWorkflowError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'SecurityWorkflowError'; }
}
export function securityThread(scope: SecurityScope): string {
  const s = scopeSchema.parse(scope);
  return `security:v1:${s.tenantId}:${s.websiteId}:${s.environment}:${s.runId}`;
}
/** Hash canonical JSON manifests, never secret envelopes or customer source. */
export function manifestDigest(input: unknown): string {
  let nodes = 0;
  function canonical(value: unknown, depth = 0): string {
    if (++nodes > 4096 || depth > 24) throw new SecurityWorkflowError('SECURITY_MANIFEST_LIMIT');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
    if (typeof value === 'object' && value && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
    throw new SecurityWorkflowError('SECURITY_MANIFEST_INVALID');
  }
  const serialized = canonical(input);
  if (Buffer.byteLength(serialized) > 65_536) throw new SecurityWorkflowError('SECURITY_MANIFEST_LIMIT');
  return createHash('sha256').update(serialized).digest('hex');
}

/** Trusted server implementation. Browser/model input is never this context. */
export interface SecurityWorkflowServices {
  assertLeaseAndAuthority(): Promise<void>;
  /** Must consult the durable journal before any model, sandbox or remote effect. */
  step(step: SecurityWorkStep, input: { previous?: ArtifactReceipt }): Promise<SecurityStepResult>;
  /** Re-read saved exact decision, session/MFA, grant, plan, recovery and expiry. */
  decision(kind: SecurityDecisionKind, decisionId: string, artifact: ArtifactReceipt): Promise<'APPROVED' | 'DENIED'>;
  transition(phase: SecurityPhase, code?: string): Promise<void>;
}
