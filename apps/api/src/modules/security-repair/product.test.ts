import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { currentSecurityActor, currentSecurityEnrollment, currentSecurityEntitlement } from './authority.js';
import { securityAdmissionRequestSchema, securityEnrollmentSchema, securityProductDecisionSchema, securityProductEvidenceSchema, type SecurityManagedEnrollment } from './product-contracts.js';

function fixture() {
  const now = new Date(); const actor = { actorId: randomUUID(), sessionId: randomUUID(), tenantId: randomUUID() }; const websiteId = randomUUID();
  const state = {
    user: { id: actor.actorId, status: 'APPROVED', emailVerifiedAt: now, mfaEnabledAt: now },
    session: { id: actor.sessionId, userId: actor.actorId, tenantId: actor.tenantId, revokedAt: null as Date | null, expiresAt: new Date(now.getTime() + 3600000), mfaVerifiedAt: now },
    membership: { status: 'ACTIVE' }, website: { id: websiteId },
    permissions: ['websites.manage', 'websites.read', 'chat.read', 'ai.use', 'ai.security_context'],
    credential: { id: randomUUID(), tenantId: actor.tenantId, websiteId, environment: 'STAGING', version: 1, authorizedBy: actor.actorId, authorizationExpiresAt: new Date(now.getTime() + 60000), username: 'codebandage-managed-target', authMethod: 'SSH_KEY', encryptedEnvelope: 'opaque-vault-encrypted-value' }
  };
  const tx = {
    async $queryRaw() { return [{ now }]; },
    user: { async findUnique() { return state.user; } }, session: { async findUnique() { return state.session; } },
    tenantMembership: { async findUnique() { return state.membership; } }, website: { async findFirst() { return state.website; } },
    userRole: { async findMany() { return [{ role: { permissions: state.permissions.map(key => ({ permission: { key } })) } }]; } },
    careCredential: { async findFirst() { return state.credential; } }, subscription: { async findMany() { return []; } }
  } as unknown as Prisma.TransactionClient;
  const enrollment: SecurityManagedEnrollment = { id: randomUUID(), revision: 1, tenantId: actor.tenantId, websiteId, actorId: actor.actorId, label: 'Operator-enrolled test target', environment: 'STAGING', adapter: 'MANAGED_STATIC_PERMISSION_V1', enabled: true, expiresAt: new Date(now.getTime() + 60000).toISOString(), credentialId: state.credential.id, credentialVersion: 1, namespaceId: randomUUID(), targetId: randomUUID(), hostKeyFingerprint: `SHA256:${'a'.repeat(43)}`, attestationDigest: 'a'.repeat(64), implementationDigest: 'b'.repeat(64), allowanceMicros: 0, proof: { independentWriterExcluded: true, publisherReadOnly: true, rootOwned: true, forcedCommandOnly: true, recoveryEncrypted: true } };
  return { now, actor, websiteId, state, tx, enrollment, registry: { async list() { return [enrollment]; } } };
}
describe('security product admission and current authority', () => {
  it('accepts only an opaque managed staging target and explicit authorization; rejects execution/credential/path injection', () => {
    const input = { requestKey: randomUUID(), enrollmentId: randomUUID(), enrollmentRevision: 1, authorizationConfirmed: true };
    expect(securityAdmissionRequestSchema.parse(input).operation).toBe('HARDEN');
    for (const extra of [{ environment: 'PRODUCTION' }, { executor: 'shell' }, { command: 'anything' }, { credentialId: randomUUID() }, { path: '/unrelated' }, { allowanceMicros: 100 }]) expect(securityAdmissionRequestSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    expect(securityAdmissionRequestSchema.safeParse({ ...input, authorizationConfirmed: false }).success).toBe(false);
  });
  it('requires a new restore admission bound to one prior run; a harden request cannot smuggle recovery', () => {
    const input = { requestKey: randomUUID(), enrollmentId: randomUUID(), enrollmentRevision: 1, authorizationConfirmed: true };
    expect(securityAdmissionRequestSchema.safeParse({ ...input, operation: 'RESTORE' }).success).toBe(false);
    expect(securityAdmissionRequestSchema.safeParse({ ...input, recoveryRunId: randomUUID() }).success).toBe(false);
    expect(securityAdmissionRequestSchema.safeParse({ ...input, operation: 'RESTORE', recoveryRunId: randomUUID() }).success).toBe(true);
  });
  it('does not accept incomplete enrollment evidence or generic production/SFTP targets', () => {
    const f = fixture(); expect(securityEnrollmentSchema.safeParse(f.enrollment).success).toBe(true);
    expect(securityEnrollmentSchema.safeParse({ ...f.enrollment, environment: 'PRODUCTION' }).success).toBe(false);
    expect(securityEnrollmentSchema.safeParse({ ...f.enrollment, proof: { ...f.enrollment.proof, independentWriterExcluded: false } }).success).toBe(false);
  });
  it('rechecks session revocation and exact actor/tenant binding instead of trusting cached request permissions', async () => {
    const f = fixture(); expect((await currentSecurityActor(f.tx, f.actor, f.websiteId, true)).recentMfa).toBe(true);
    f.state.session.revokedAt = f.now; await expect(currentSecurityActor(f.tx, f.actor, f.websiteId, true)).rejects.toMatchObject({ code: 'SECURITY_ACTOR_REVOKED' });
    f.state.session.revokedAt = null; f.state.session.tenantId = randomUUID(); await expect(currentSecurityActor(f.tx, f.actor, f.websiteId, true)).rejects.toMatchObject({ code: 'SECURITY_ACTOR_REVOKED' });
  });
  it('keeps history readable with stale MFA while denying new execution and approvals', async () => {
    const f = fixture(); f.state.session.mfaVerifiedAt = new Date(f.now.getTime() - 300001);
    expect((await currentSecurityActor(f.tx, f.actor, f.websiteId, false)).recentMfa).toBe(false);
    await expect(currentSecurityActor(f.tx, f.actor, f.websiteId, true)).rejects.toMatchObject({ code: 'SECURITY_MFA_REQUIRED' });
  });
  it('denies a permission withdrawn after admission and a revoked vault grant', async () => {
    const f = fixture(); f.state.permissions = f.state.permissions.filter(key => key !== 'websites.manage');
    await expect(currentSecurityActor(f.tx, f.actor, f.websiteId, true)).rejects.toMatchObject({ code: 'SECURITY_PERMISSION_REQUIRED' });
    f.state.credential.authorizationExpiresAt = new Date(f.now.getTime() - 1);
    await expect(currentSecurityEnrollment(f.tx, f.registry, f.actor, f.websiteId, f.enrollment.id, 1)).rejects.toMatchObject({ code: 'SECURITY_GRANT_REQUIRED' });
  });
  it('rejects actor/enrollment revision substitution and a missing explicitly paid entitlement', async () => {
    const f = fixture(); await expect(currentSecurityEnrollment(f.tx, f.registry, f.actor, f.websiteId, f.enrollment.id, 2)).rejects.toMatchObject({ code: 'SECURITY_ENROLLMENT_REVOKED' });
    f.enrollment.actorId = randomUUID(); await expect(currentSecurityEnrollment(f.tx, f.registry, f.actor, f.websiteId, f.enrollment.id, 1)).rejects.toMatchObject({ code: 'SECURITY_ENROLLMENT_REVOKED' });
    await expect(currentSecurityEntitlement(f.tx, f.actor.tenantId)).rejects.toMatchObject({ code: 'SECURITY_PAID_ENTITLEMENT_REQUIRED' });
  });
  it('binds approvals to an exact digest and rejects arbitrary commands or secrets in customer evidence', () => {
    expect(securityProductDecisionSchema.safeParse({ requestKey: randomUUID(), artifactId: randomUUID(), digest: 'a'.repeat(64), status: 'APPROVED', executor: 'shell' }).success).toBe(false);
    const f = fixture(); const evidence = { version: 1, kind: 'PROPOSAL', adapter: f.enrollment.adapter, environment: 'STAGING', enrollmentId: f.enrollment.id, enrollmentRevision: 1, summary: 'Remove other-write permission from the enrolled staging file', change: { action: 'HARDEN', targetLabel: 'Managed staging file', beforeMode: 0o666, afterMode: 0o664, contentDigest: 'a'.repeat(64), preimageDigest: 'b'.repeat(64) }, recovery: { digest: 'c'.repeat(64), encrypted: true, verified: true }, checks: [{ name: 'Content unchanged', passed: true }] };
    expect(securityProductEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(securityProductEvidenceSchema.safeParse({ ...evidence, privateKey: 'must-never-be-returned' }).success).toBe(false);
  });
});
