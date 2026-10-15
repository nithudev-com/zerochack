import { database } from '@zerochack/database';
import type { Prisma, WebsiteAccessCredential } from '@prisma/client';
import { ApiError } from '../../errors.js';

type Target = { tenantId: string; websiteId: string; host: string; port: number };
export async function trustedSshHost(tx: Prisma.TransactionClient, target: Target): Promise<string | null> {
  const saved = await tx.auditLog.findFirst({ where: { tenantId: target.tenantId, action: 'website.ssh_host_trusted', resourceType: 'website', resourceId: target.websiteId, AND: [{ metadata: { path: ['host'], equals: target.host.toLowerCase() } }, { metadata: { path: ['port'], equals: target.port } }] }, orderBy: { createdAt: 'asc' }, select: { metadata: true } });
  if (!saved) return null;
  const metadata = saved.metadata as { fingerprint?: unknown } | null;
  if (typeof metadata?.fingerprint !== 'string' || !/^SHA256:[A-Za-z0-9+/]{43}=$/u.test(metadata.fingerprint)) throw new ApiError(409, 'HOST_IDENTITY_REQUIRED', 'Saved server identity needs support review.');
  return metadata.fingerprint;
}

// Caller holds the website row lock. Append-only audit anchors survive credential
// expiry, password rotation, target switching and revocation; never auto-replace.
export async function rememberSshHost(tx: Prisma.TransactionClient, target: Target, fingerprint: string, actorUserId: string, source: 'PREVERIFIED' | 'FIRST_CONNECTION', requestId: string) {
  const normalized = fingerprint.endsWith('=') ? fingerprint : fingerprint + '=';
  const known = await trustedSshHost(tx, target);
  if (known && known !== normalized) return false;
  if (!known) await tx.auditLog.create({ data: { tenantId: target.tenantId, actorUserId, requestId, action: 'website.ssh_host_trusted', resourceType: 'website', resourceId: target.websiteId, metadata: { host: target.host.toLowerCase(), port: target.port, fingerprint: normalized, source } } });
  return true;
}

export function verifySshHost(access: WebsiteAccessCredential, actorUserId: string, requestId: string) {
  return (observed: string) => database.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM websites WHERE id = ${access.websiteId}::uuid FOR UPDATE`;
    const current = await tx.websiteAccessCredential.findFirst({ where: { id: access.id, tenantId: access.tenantId, websiteId: access.websiteId, updatedAt: access.updatedAt, vaultCredentialId: access.vaultCredentialId, website: { is: { lifecycle: 'ACTIVE', tenantId: access.tenantId } } } });
    if (!current) throw new ApiError(409, 'SSH_ACCESS_CHANGED', 'Saved access changed during the connection check.');
    if (current.vaultCredentialId && !await tx.careCredential.findFirst({ where: { id: current.vaultCredentialId, tenantId: access.tenantId, websiteId: access.websiteId, kind: 'SSH', environment: 'PRODUCTION', status: 'STORED', authorizationExpiresAt: { gt: new Date() } }, select: { id: true } })) throw new ApiError(409, 'AUTHORIZATION_REQUIRED', 'SSH authorization expired or was revoked.');
    const known = await trustedSshHost(tx, access);
    if (known) return known === observed;
    if (access.hostKeyFingerprint) return rememberSshHost(tx, access, access.hostKeyFingerprint, actorUserId, 'PREVERIFIED', requestId).then(ok => ok && access.hostKeyFingerprint === observed);
    const consent = current.vaultCredentialId && await tx.auditLog.findFirst({ where: { tenantId: access.tenantId, action: 'care.ssh_first_connection_authorized', resourceType: 'care_credential', resourceId: current.vaultCredentialId }, select: { id: true } });
    if (!consent) throw new ApiError(409, 'HOST_IDENTITY_REQUIRED', 'Save access using the connection form and confirm first-connection trust.');
    return rememberSshHost(tx, access, observed, actorUserId, 'FIRST_CONNECTION', requestId);
  });
}
