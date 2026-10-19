import { createHash } from 'node:crypto';
import type { Prisma, WebsiteAccessCredential } from '@prisma/client';
import { ApiError } from '../../errors.js';

export type AssessmentBinding = {
  tenantId: string;
  websiteId: string;
  scanId: string;
  userId: string;
  sessionId: string;
  url: string;
  normalizedHost: string;
  accessDigest: string;
  vaultVersion: number | null;
};

type AccessSnapshot = Pick<WebsiteAccessCredential, 'id' | 'updatedAt' | 'host' | 'port' | 'username' | 'authMethod' | 'hostKeyFingerprint' | 'vaultCredentialId' | 'encryptedSecret'>;

/** Internal equality fence only: never persist or log these secret-bearing inputs. */
export function assessmentAccessDigest(access: AccessSnapshot): string {
  return createHash('sha256').update(JSON.stringify({
    id: access.id,
    updatedAt: access.updatedAt.toISOString(),
    host: access.host,
    port: access.port,
    username: access.username,
    authMethod: access.authMethod,
    hostKeyFingerprint: access.hostKeyFingerprint,
    vaultCredentialId: access.vaultCredentialId,
    encryptedSecret: access.encryptedSecret
  })).digest('hex');
}

/** Retry only a completed transaction rejection that proves NOWAIT contention.
 * `transaction` must await the whole short database transaction, including its
 * rollback, and must not include network work, notification or post-commit work.
 * Never retry raw driver/commit errors: their outcome may be uncertain. The
 * current binding/stop/deadline guard runs afresh before every attempt.
 */
export async function retryAssessmentAuthority<T>(transaction: () => Promise<T>, beforeAttempt: () => Promise<void>): Promise<T> {
  const delays = [25, 50, 100] as const;
  for (let attempt = 0; ; attempt++) {
    await beforeAttempt();
    try { return await transaction(); }
    catch (error) {
      const delay = delays[attempt];
      if (!(error instanceof ApiError) || error.code !== 'ASSESSMENT_AUTHORITY_BUSY' || delay === undefined) throw error;
      await new Promise<void>(resolve => setTimeout(resolve, delay));
    }
  }
}

/** Use inside short transactions before network work and before accepting its result. */
export async function assertActiveAssessment(tx: Prisma.TransactionClient, binding: AssessmentBinding, now = new Date()): Promise<void> {
  const { tenantId, websiteId, userId } = binding;
  const [scan, website, access, user, membership, session, assignments] = await Promise.all([
    tx.scan.findFirst({ where: { id: binding.scanId, tenantId, websiteId }, select: { status: true } }),
    tx.website.findFirst({ where: { id: websiteId, tenantId }, select: { lifecycle: true, url: true, normalizedHost: true } }),
    tx.websiteAccessCredential.findFirst({ where: { tenantId, websiteId }, include: { vaultCredential: { select: { tenantId: true, websiteId: true, environment: true, kind: true, status: true, version: true, authorizationExpiresAt: true, host: true, port: true, username: true, authMethod: true } } } }),
    tx.user.findUnique({ where: { id: userId }, select: { status: true } }),
    tx.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId, userId } }, select: { status: true } }),
    tx.session.findFirst({ where: { id: binding.sessionId, tenantId, userId }, select: { revokedAt: true, expiresAt: true } }),
    tx.userRole.findMany({ where: { tenantId, userId }, select: { role: { select: { permissions: { select: { permission: { select: { key: true } } } } } } } })
  ]);
  if (!scan || scan.status !== 'RUNNING') throw new ApiError(409, 'ASSESSMENT_CANCELLED', 'This assessment is no longer active. Review its saved state before starting another.');
  if (!website || website.lifecycle !== 'ACTIVE' || website.url !== binding.url || website.normalizedHost !== binding.normalizedHost || !access || access.status !== 'READY_FOR_SECURE_SESSION' || assessmentAccessDigest(access) !== binding.accessDigest) throw new ApiError(409, 'ASSESSMENT_BINDING_CHANGED', 'The website or saved access changed. Its old assessment result was not accepted.');
  const permissions = new Set(assignments.flatMap(assignment => assignment.role.permissions.map(item => item.permission.key)));
  if (user?.status !== 'APPROVED' || membership?.status !== 'ACTIVE' || !session || session.revokedAt || session.expiresAt <= now || !['scans.run', 'ai.security_context'].every(permission => permissions.has(permission))) throw new ApiError(403, 'AUTHORIZATION_REQUIRED', 'Current account, session, membership and assessment permissions are required.');
  if (access.vaultCredentialId) {
    const vault = access.vaultCredential;
    if (!vault || vault.tenantId !== tenantId || vault.websiteId !== websiteId || vault.environment !== 'PRODUCTION' || vault.kind !== 'SSH' || vault.version !== binding.vaultVersion || vault.host !== access.host || vault.port !== access.port || vault.username !== access.username || vault.authMethod !== access.authMethod) throw new ApiError(409, 'ASSESSMENT_BINDING_CHANGED', 'The stored account changed. Its old assessment result was not accepted.');
    if (vault.status !== 'STORED' || vault.authorizationExpiresAt <= now) throw new ApiError(403, 'AUTHORIZATION_REQUIRED', 'The saved account was revoked or its inspection permission expired.');
  } else if (binding.vaultVersion !== null) throw new ApiError(409, 'ASSESSMENT_BINDING_CHANGED', 'The stored account changed. Its old assessment result was not accepted.');
}

/** Caller holds the website row in this same short transaction; never hold over network work.
 * SHARE fences UPDATE/DELETE revocation until this result commits. NOWAIT fails closed
 * instead of creating lock cycles with existing account/session/credential writers.
 */
export async function lockAssessmentAuthority(tx: Prisma.TransactionClient, binding: AssessmentBinding): Promise<void> {
  const { tenantId, websiteId, userId, sessionId, scanId } = binding;
  try {
    await tx.$queryRaw`SELECT id FROM scans WHERE id = ${scanId}::uuid AND tenant_id = ${tenantId}::uuid AND website_id = ${websiteId}::uuid FOR SHARE NOWAIT`;
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR SHARE NOWAIT`;
    await tx.$queryRaw`SELECT id FROM tenant_memberships WHERE tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid FOR SHARE NOWAIT`;
    await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${sessionId}::uuid AND tenant_id = ${tenantId}::uuid AND user_id = ${userId}::uuid FOR SHARE NOWAIT`;
    // Lock the independent vault row before the bridge, matching credential revocation.
    // A bridge changed between these statements fails the subsequent exact digest check.
    await tx.$queryRaw`SELECT c.id FROM care_credentials c JOIN website_access_credentials a ON a.vault_credential_id = c.id WHERE a.tenant_id = ${tenantId}::uuid AND a.website_id = ${websiteId}::uuid ORDER BY c.id FOR SHARE OF c NOWAIT`;
    await tx.$queryRaw`SELECT id FROM website_access_credentials WHERE tenant_id = ${tenantId}::uuid AND website_id = ${websiteId}::uuid FOR SHARE NOWAIT`;
    await tx.$queryRaw`SELECT ur.role_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN role_permissions rp ON rp.role_id = r.id JOIN permissions p ON p.id = rp.permission_id WHERE ur.tenant_id = ${tenantId}::uuid AND ur.user_id = ${userId}::uuid ORDER BY ur.role_id, rp.permission_id FOR SHARE OF ur, r, rp, p NOWAIT`;
  } catch (error) {
    const details = error && typeof error === 'object' ? error as { code?: unknown; meta?: { code?: unknown } } : null;
    const busy = details?.code === '55P03' || details?.meta?.code === '55P03';
    throw new ApiError(busy ? 409 : 503, busy ? 'ASSESSMENT_AUTHORITY_BUSY' : 'ASSESSMENT_AUTHORITY_UNAVAILABLE', busy ? 'Account or access authority is changing. The assessment update was not accepted; review saved progress before retrying.' : 'Current assessment authority could not be verified. The assessment update was not accepted.');
  }
  await assertActiveAssessment(tx, binding);
}
