import { z } from 'zod';
import { artifactReceiptSchema, scopeSchema, sha256, uuid } from '@zerochack/security-orchestration';

export const SECURITY_MANAGED_ADAPTER = 'MANAGED_STATIC_PERMISSION_V1' as const;
export const SECURITY_REPAIR_ENTITLEMENT = 'securityManagedStagingPermissionRepair' as const;
/** Operator input only. Customers may select an opaque identity, never its SSH
 * address, credential, namespace, implementation or permit issuer. */
export const securityEnrollmentSchema = z.object({
  id: uuid, revision: z.number().int().positive(), tenantId: uuid, websiteId: uuid, actorId: uuid,
  label: z.string().trim().min(1).max(120), environment: z.literal('STAGING'), adapter: z.literal(SECURITY_MANAGED_ADAPTER),
  enabled: z.boolean(), expiresAt: z.iso.datetime(), credentialId: uuid, credentialVersion: z.number().int().positive(),
  namespaceId: uuid, targetId: uuid, hostKeyFingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/u),
  attestationDigest: sha256, implementationDigest: sha256, allowanceMicros: z.number().int().min(0).max(100_000_000),
  proof: z.object({ independentWriterExcluded: z.literal(true), publisherReadOnly: z.literal(true), rootOwned: z.literal(true), forcedCommandOnly: z.literal(true), recoveryEncrypted: z.literal(true) }).strict()
}).strict();
export type SecurityManagedEnrollment = z.infer<typeof securityEnrollmentSchema>;
export type SecurityEnrollmentRegistry = {
  /** Reload authoritative operator enrollment on every call. No request or model
   * input may create this registry. An empty registry is a supported deny state. */
  list(tx: import('@prisma/client').Prisma.TransactionClient, tenantId: string, websiteId: string): Promise<readonly SecurityManagedEnrollment[]>;
};
export const securityEntitlementSchema = z.object({ kind: z.literal('PAID_SUBSCRIPTION'), id: uuid, packageVersionId: uuid, termsDigest: sha256, expiresAt: z.iso.datetime() }).strict();
export const securityAdmissionSchema = z.object({
  version: z.literal(1), scope: scopeSchema.extend({ environment: z.literal('STAGING') }).strict(), actorId: uuid, sessionId: uuid, requestKey: uuid,
  operation: z.enum(['HARDEN', 'RESTORE']), recoveryRunId: uuid.nullable(),
  enrollment: securityEnrollmentSchema, enrollmentDigest: sha256, entitlement: securityEntitlementSchema,
  authorityDigest: sha256, requestDigest: sha256, implementationDigest: sha256,
  allowanceMicros: z.number().int().min(0).max(100_000_000), expiresAt: z.iso.datetime()
}).strict().superRefine((value, context) => {
  if (value.enrollment.tenantId !== value.scope.tenantId || value.enrollment.websiteId !== value.scope.websiteId || value.enrollment.actorId !== value.actorId || value.enrollment.environment !== value.scope.environment) context.addIssue({ code: 'custom', message: 'Admission and enrollment authority must have the same scope.' });
  if ((value.operation === 'RESTORE') !== Boolean(value.recoveryRunId) || value.recoveryRunId === value.scope.runId) context.addIssue({ code: 'custom', message: 'Recovery requires a separate prior run identity.' });
  if (value.implementationDigest !== value.enrollment.implementationDigest || value.allowanceMicros !== value.enrollment.allowanceMicros) context.addIssue({ code: 'custom', message: 'Admission must preserve reviewed implementation and cost bounds.' });
});
export type SecurityRepairAdmission = z.infer<typeof securityAdmissionSchema>;
export const securityAdmissionRequestSchema = z.object({ requestKey: uuid, enrollmentId: uuid, enrollmentRevision: z.number().int().positive(), authorizationConfirmed: z.literal(true), operation: z.enum(['HARDEN', 'RESTORE']).default('HARDEN'), recoveryRunId: uuid.optional() }).strict().superRefine((value, context) => {
  if ((value.operation === 'RESTORE') !== Boolean(value.recoveryRunId)) context.addIssue({ code: 'custom', path: ['recoveryRunId'], message: 'Restore requires exactly one prior verified run identity.' });
});
export const securityProductDecisionSchema = artifactReceiptSchema.extend({ requestKey: uuid, status: z.enum(['APPROVED', 'DENIED']) }).strict();
/** Safe, exact customer evidence. Full snapshots and access values stay in the
 * encrypted artifact, and the digest binds the complete immutable artifact. */
export const securityProductEvidenceSchema = z.object({
  version: z.literal(1), kind: z.enum(['PLAN', 'PROPOSAL', 'RESULT']), adapter: z.literal(SECURITY_MANAGED_ADAPTER),
  summary: z.string().trim().min(1).max(1000), environment: z.literal('STAGING'), enrollmentId: uuid, enrollmentRevision: z.number().int().positive(),
  change: z.object({ action: z.enum(['HARDEN', 'RESTORE']), targetLabel: z.string().min(1).max(120), beforeMode: z.number().int().min(0).max(511), afterMode: z.number().int().min(0).max(511), contentDigest: sha256, preimageDigest: sha256 }).strict(),
  recovery: z.object({ digest: sha256, encrypted: z.literal(true), verified: z.boolean() }).strict(),
  checks: z.array(z.object({ name: z.string().min(1).max(120), passed: z.boolean() }).strict()).max(30)
}).strict();
export type SecurityProductEvidence = z.infer<typeof securityProductEvidenceSchema>;
