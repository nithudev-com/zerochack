import type { Prisma, SecurityRepairRun } from '@prisma/client';
import { manifestDigest, SecurityWorkflowError, type SecurityScope } from '@zerochack/security-orchestration';
import { securityEnrollmentSchema, SECURITY_REPAIR_ENTITLEMENT, type SecurityEnrollmentRegistry, type SecurityManagedEnrollment, type SecurityRepairAdmission } from './product-contracts.js';
import type { SecurityControllerAuthority } from './controller.js';

export type SecurityProductActor = { actorId: string; sessionId: string; tenantId: string };
const requiredPermissions = ['websites.manage', 'ai.use', 'ai.security_context'];
const fail = (code: string): never => { throw new SecurityWorkflowError(code); };
export async function securityDatabaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]?.now;
  if (!now || !Number.isFinite(now.getTime())) fail('SECURITY_CLOCK_INVALID');
  return now!;
}

/** Re-read current rows inside the same short transaction as journal admission.
 * The request's earlier RBAC/MFA snapshot is never execution authority. */
export async function currentSecurityActor(tx: Prisma.TransactionClient, actor: SecurityProductActor, websiteId: string, mutation: boolean) {
  await tx.$queryRaw`SELECT id FROM websites WHERE id=${websiteId}::uuid AND tenant_id=${actor.tenantId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM users WHERE id=${actor.actorId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM sessions WHERE id=${actor.sessionId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT id FROM tenant_memberships WHERE tenant_id=${actor.tenantId}::uuid AND user_id=${actor.actorId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT role_id FROM user_roles WHERE tenant_id=${actor.tenantId}::uuid AND user_id=${actor.actorId}::uuid FOR SHARE`;
  await tx.$queryRaw`SELECT p.role_id FROM role_permissions p JOIN user_roles a ON a.role_id=p.role_id WHERE a.tenant_id=${actor.tenantId}::uuid AND a.user_id=${actor.actorId}::uuid FOR SHARE OF p`;
  const [user, session, membership, website, assignments] = await Promise.all([
    tx.user.findUnique({ where: { id: actor.actorId } }), tx.session.findUnique({ where: { id: actor.sessionId } }),
    tx.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId: actor.tenantId, userId: actor.actorId } } }),
    tx.website.findFirst({ where: { id: websiteId, tenantId: actor.tenantId, lifecycle: 'ACTIVE' } }),
    tx.userRole.findMany({ where: { tenantId: actor.tenantId, userId: actor.actorId }, include: { role: { include: { permissions: { include: { permission: true } } } } } })
  ]);
  const now = await securityDatabaseNow(tx);
  if (!user || user.status !== 'APPROVED' || !user.emailVerifiedAt || !session || session.userId !== actor.actorId || session.tenantId !== actor.tenantId || session.revokedAt || session.expiresAt <= now || membership?.status !== 'ACTIVE') fail('SECURITY_ACTOR_REVOKED');
  if (!website) fail('SECURITY_WEBSITE_UNAVAILABLE');
  const permissions = [...new Set(assignments.flatMap(a => a.role.permissions.map(p => p.permission.key)))].sort();
  const required = mutation ? requiredPermissions : ['websites.read', 'chat.read'];
  if (required.some(permission => !permissions.includes(permission))) fail('SECURITY_PERMISSION_REQUIRED');
  const recentMfa = Boolean(user!.mfaEnabledAt && session!.mfaVerifiedAt && session!.mfaVerifiedAt <= now && session!.mfaVerifiedAt.getTime() >= now.getTime() - 300_000);
  if (mutation && !recentMfa) fail('SECURITY_MFA_REQUIRED');
  return { now, session: session!, website: website!, permissions, recentMfa };
}

export async function currentSecurityEnrollment(tx: Prisma.TransactionClient, registry: SecurityEnrollmentRegistry, actor: SecurityProductActor, websiteId: string, id: string, revision: number) {
  const values = await registry.list(tx, actor.tenantId, websiteId);
  const matches = values.filter(item => item.id === id);
  if (matches.length !== 1) fail('SECURITY_ENROLLMENT_UNAVAILABLE');
  const result = securityEnrollmentSchema.safeParse(matches[0]);
  if (!result.success) fail('SECURITY_ENROLLMENT_INVALID');
  const enrollment = result.data!;
  const now = await securityDatabaseNow(tx);
  if (!enrollment.enabled || enrollment.tenantId !== actor.tenantId || enrollment.websiteId !== websiteId || enrollment.actorId !== actor.actorId || enrollment.revision !== revision || new Date(enrollment.expiresAt) <= now) fail('SECURITY_ENROLLMENT_REVOKED');
  await tx.$queryRaw`SELECT id FROM care_credentials WHERE id=${enrollment.credentialId}::uuid AND tenant_id=${actor.tenantId}::uuid AND website_id=${websiteId}::uuid FOR SHARE`;
  const credential = await tx.careCredential.findFirst({ where: { id: enrollment.credentialId, tenantId: actor.tenantId, websiteId, environment: 'STAGING', kind: 'SSH', status: 'STORED', version: enrollment.credentialVersion, authorizedBy: actor.actorId } });
  if (!credential || credential.authorizationExpiresAt <= now || credential.username !== 'codebandage-managed-target' || credential.authMethod !== 'SSH_KEY' || !credential.encryptedEnvelope) fail('SECURITY_GRANT_REQUIRED');
  return { enrollment, credential: credential!, enrollmentDigest: manifestDigest(enrollment) };
}

export async function currentSecurityEntitlement(tx: Prisma.TransactionClient, tenantId: string, pinnedId?: string) {
  const now = await securityDatabaseNow(tx);
  const candidates = await tx.subscription.findMany({ where: { tenantId, ...(pinnedId ? { id: pinnedId } : {}), status: 'ACTIVE', currentPeriodEnd: { gt: now }, cancelledAt: null }, orderBy: { createdAt: 'desc' }, take: 50 });
  for (const candidate of candidates) {
    await tx.$queryRaw`SELECT id FROM subscriptions WHERE id=${candidate.id}::uuid AND tenant_id=${tenantId}::uuid FOR SHARE`;
    const current = await tx.subscription.findFirst({ where: { id: candidate.id, tenantId, status: 'ACTIVE', currentPeriodEnd: { gt: await securityDatabaseNow(tx) }, cancelledAt: null } });
    if (!current) continue;
    const terms = current.termsSnapshot;
    if (!terms || Array.isArray(terms) || typeof terms !== 'object' || !current.packageVersionId || !terms.featureEntitlements || typeof terms.featureEntitlements !== 'object' || Array.isArray(terms.featureEntitlements) || terms.featureEntitlements[SECURITY_REPAIR_ENTITLEMENT] !== true || terms.packageVersionId !== current.packageVersionId) continue;
    // Also fence insertion of a new refund through the parent's FK lock while
    // this short authority transaction admits a paid effect.
    await tx.$queryRaw`SELECT id FROM payment_transactions WHERE tenant_id=${tenantId}::uuid AND subscription_id=${current.id}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM invoices WHERE tenant_id=${tenantId}::uuid AND subscription_id=${current.id}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT r.id FROM payment_refunds r JOIN payment_transactions p ON p.id=r.transaction_id WHERE p.tenant_id=${tenantId}::uuid AND p.subscription_id=${current.id}::uuid FOR SHARE OF r`;
    const paid = await tx.paymentTransaction.findFirst({ where: { tenantId, subscriptionId: current.id, packageVersionId: current.packageVersionId, status: 'SUCCEEDED', completedAt: { not: null }, providerPaymentReference: { not: null }, invoice: { tenantId, subscriptionId: current.id, status: 'PAID', paidAt: { not: null } }, refunds: { none: { status: 'SUCCEEDED' } } }, select: { id: true } });
    if (!paid) continue;
    return { kind: 'PAID_SUBSCRIPTION' as const, id: current.id, packageVersionId: current.packageVersionId, termsDigest: manifestDigest(terms), expiresAt: current.currentPeriodEnd!.toISOString() };
  }
  return fail('SECURITY_PAID_ENTITLEMENT_REQUIRED');
}

export function securityAuthorityDigest(input: { actor: SecurityProductActor; permissions: string[]; enrollment: SecurityManagedEnrollment; entitlement: SecurityRepairAdmission['entitlement']; credentialExpiresAt: Date }) {
  return manifestDigest({ actor: input.actor, permissions: input.permissions, enrollmentDigest: manifestDigest(input.enrollment), entitlement: input.entitlement, credentialId: input.enrollment.credentialId, credentialVersion: input.enrollment.credentialVersion, credentialExpiresAt: input.credentialExpiresAt.toISOString() });
}

export function createSecurityProductAuthority(admission: SecurityRepairAdmission, registry: SecurityEnrollmentRegistry): SecurityControllerAuthority {
  const actor = { actorId: admission.actorId, sessionId: admission.sessionId, tenantId: admission.scope.tenantId };
  return async (tx, scope: SecurityScope, operation, run: SecurityRepairRun | null) => {
    if (manifestDigest(scope) !== manifestDigest(admission.scope) || run && (run.actorId !== actor.actorId || run.sessionId !== actor.sessionId || run.authorityDigest !== admission.authorityDigest)) fail('SECURITY_ACTOR_BINDING_CHANGED');
    // Cancellation must remain available after the operator withdraws a grant or
    // a payment expires. It authorizes stopping, never a new remote side effect.
    const current = await currentSecurityActor(tx, actor, scope.websiteId, operation !== 'OBSERVE' && operation !== 'STOP');
    if (operation === 'STOP' || operation === 'OBSERVE') return;
    if (new Date(admission.expiresAt) <= current.now) fail('SECURITY_AUTHORITY_EXPIRED');
    const grant = await currentSecurityEnrollment(tx, registry, actor, scope.websiteId, admission.enrollment.id, admission.enrollment.revision);
    const entitlement = await currentSecurityEntitlement(tx, actor.tenantId, admission.entitlement.id);
    if (grant.enrollmentDigest !== admission.enrollmentDigest || manifestDigest(entitlement) !== manifestDigest(admission.entitlement) || securityAuthorityDigest({ actor, permissions: current.permissions, enrollment: grant.enrollment, entitlement, credentialExpiresAt: grant.credential.authorizationExpiresAt }) !== admission.authorityDigest) fail('SECURITY_AUTHORITY_BINDING_CHANGED');
  };
}
