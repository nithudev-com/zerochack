import type { FastifyReply, FastifyRequest } from 'fastify';
import { database } from '@zerochack/database';
import { hashOpaqueToken } from '@zerochack/auth';
import type { Environment } from '@zerochack/config';
import { ApiError } from '../../errors.js';

export const sessionCookieName = (environment: Environment): string => environment.NODE_ENV === 'production' ? '__Host-zerochack_session' : 'zerochack_session';

export async function authenticate(request: FastifyRequest, environment: Environment): Promise<void> {
  const rawToken = request.cookies[sessionCookieName(environment)];
  if (!rawToken) throw new ApiError(401, 'UNAUTHENTICATED', 'Authentication required');
  const session = await database.session.findUnique({
    where: { tokenHash: hashOpaqueToken(rawToken, environment.SESSION_SECRET) },
    include: { user: true, tenant: true }
  });
  const now = new Date();
  if (!session || session.revokedAt || session.expiresAt <= now) throw new ApiError(401, 'SESSION_INVALID', 'Session is expired or revoked');
  if (session.user.status !== 'APPROVED') throw new ApiError(403, 'ACCOUNT_INACTIVE', 'Account is not active');
  const membership = await database.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId: session.tenantId, userId: session.userId } } });
  if (!membership || membership.status !== 'ACTIVE') throw new ApiError(403, 'TENANT_ACCESS_DENIED', 'Tenant membership is not active');
  const assignments = await database.userRole.findMany({ where: { userId: session.userId, tenantId: session.tenantId }, include: { role: { include: { permissions: { include: { permission: true } } } } } });
  request.userId = session.userId; request.tenantId = session.tenantId; request.sessionId = session.id;
  request.roleNames = assignments.map((assignment) => assignment.role.name);
  request.permissions = [...new Set(assignments.flatMap((assignment) => assignment.role.permissions.map((item) => item.permission.key)))];
  if (session.mfaVerifiedAt) request.mfaVerifiedAt = session.mfaVerifiedAt;
  void database.session.update({ where: { id: session.id }, data: { lastSeenAt: now } }).catch(() => undefined);
}

export function requirePermission(request: FastifyRequest, permission: string): void {
  if (!request.permissions?.includes(permission)) throw new ApiError(403, 'FORBIDDEN', 'Insufficient permissions');
}

export function requireOwnerRole(request: FastifyRequest): void {
  if (!request.roleNames?.includes('Owner')) throw new ApiError(403, 'OWNER_REQUIRED', 'Owner authorization required');
}

export function requireOwnerMfa(request: FastifyRequest, maxAgeMinutes = 15): void {
  requireOwnerRole(request);
  if (!request.mfaVerifiedAt || request.mfaVerifiedAt.getTime() < Date.now() - maxAgeMinutes * 60_000) throw new ApiError(403, 'MFA_REQUIRED', 'Recent multi-factor authentication is required');
}

export function setSessionCookie(reply: FastifyReply, token: string, environment: Environment): void {
  void reply.setCookie(sessionCookieName(environment), token, { httpOnly: true, secure: environment.NODE_ENV === 'production', sameSite: 'strict', path: '/', maxAge: environment.SESSION_TTL_HOURS * 3600 });
}

export function clearSessionCookie(reply: FastifyReply, environment: Environment): void {
  void reply.clearCookie(sessionCookieName(environment), { httpOnly: true, secure: environment.NODE_ENV === 'production', sameSite: 'strict', path: '/' });
}
