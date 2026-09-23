import type { Prisma, AuthTokenType } from '@prisma/client';
import { database } from '@zerochack/database';
import { generateOpaqueToken, hashOpaqueToken } from '@zerochack/auth';
import type { Environment } from '@zerochack/config';
import { ApiError } from '../../errors.js';

export const expiresFromNow = (minutes: number): Date => new Date(Date.now() + minutes * 60_000);

export async function issueAuthToken(userId: string, type: AuthTokenType, ttlMinutes: number, environment: Environment, metadata?: Prisma.InputJsonValue): Promise<string> {
  const token = generateOpaqueToken();
  await database.authToken.create({ data: { userId, type, tokenHash: hashOpaqueToken(token, environment.SESSION_SECRET), expiresAt: expiresFromNow(ttlMinutes), ...(metadata ? { metadata } : {}) } });
  return token;
}

export async function consumeAuthToken<T>(token: string, type: AuthTokenType, environment: Environment, action: (transaction: Prisma.TransactionClient, userId: string, metadata: Prisma.JsonValue | null) => Promise<T>): Promise<T> {
  const tokenHash = hashOpaqueToken(token, environment.SESSION_SECRET); const now = new Date();
  return database.$transaction(async (transaction) => {
    const record = await transaction.authToken.findUnique({ where: { tokenHash } });
    if (!record || record.type !== type || record.usedAt || record.expiresAt <= now) throw new ApiError(400, 'TOKEN_INVALID', 'Token is invalid, expired, or already used');
    const claimed = await transaction.authToken.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
    if (claimed.count !== 1) throw new ApiError(400, 'TOKEN_INVALID', 'Token is invalid, expired, or already used');
    return action(transaction, record.userId, record.metadata);
  });
}

export async function writeAudit(input: { tenantId?: string | undefined; actorUserId?: string | undefined; requestId: string; action: string; resourceType: string; resourceId?: string | undefined; metadata?: Prisma.InputJsonValue | undefined; ipAddress?: string | undefined }): Promise<void> {
  await database.auditLog.create({ data: { requestId: input.requestId, action: input.action, resourceType: input.resourceType, ...(input.tenantId ? { tenantId: input.tenantId } : {}), ...(input.actorUserId ? { actorUserId: input.actorUserId } : {}), ...(input.resourceId ? { resourceId: input.resourceId } : {}), ...(input.metadata ? { metadata: input.metadata } : {}), ...(input.ipAddress ? { ipAddress: input.ipAddress } : {}) } });
}

export async function createSession(userId: string, tenantId: string, environment: Environment, context: { ipAddress?: string | undefined; userAgent?: string | undefined; mfaVerified?: boolean | undefined }): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
  const token = generateOpaqueToken(); const expiresAt = new Date(Date.now() + environment.SESSION_TTL_HOURS * 3_600_000);
  const session = await database.session.create({ data: { userId, tenantId, tokenHash: hashOpaqueToken(token, environment.SESSION_SECRET), expiresAt, ...(context.ipAddress ? { ipAddress: context.ipAddress } : {}), ...(context.userAgent ? { userAgent: context.userAgent.slice(0, 500) } : {}), ...(context.mfaVerified ? { mfaVerifiedAt: new Date() } : {}) } });
  return { token, sessionId: session.id, expiresAt };
}
