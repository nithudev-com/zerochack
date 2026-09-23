import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { database } from '@zerochack/database';
import type { EmailProvider } from '@zerochack/email';
import type { Environment } from '@zerochack/config';
import { generateOpaqueToken, hashOpaqueToken, hashPassword, normalizeEmail, publicRoleNames, verifyPassword } from '@zerochack/auth';
import { forgotPasswordSchema, loginSchema, registrationSchema, resetPasswordSchema, tokenSchema } from '@zerochack/validation';
import { ApiError } from '../../errors.js';
import { authenticate, clearSessionCookie, setSessionCookie } from './security.js';
import { consumeAuthToken, createSession, expiresFromNow, issueAuthToken, writeAudit } from './service.js';
import type { Queue } from 'bullmq';
import { publishTenantEvent } from '../communications/service.js';

const portalRoles = { customer: 'Customer', agency: 'Agency', affiliate: 'Affiliate', specialist: 'Cybersecurity Specialist', owner: 'Owner' } as const;

function parse<Output>(schema: { safeParse: (input: unknown) => { success: true; data: Output } | { success: false; error: { flatten: () => unknown } } }, input: unknown): Output {
  const result = schema.safeParse(input); if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Request validation failed', result.error.flatten()); return result.data;
}
const requestContext = (request: FastifyRequest) => ({ ipAddress: request.ip, userAgent: request.headers['user-agent'] });
const metadataPurpose = (metadata: Prisma.JsonValue | null): string | undefined => typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) && typeof metadata.purpose === 'string' ? metadata.purpose : undefined;
const metadataTenantId = (metadata: Prisma.JsonValue | null): string | undefined => typeof metadata === 'object' && metadata !== null && !Array.isArray(metadata) && typeof metadata.tenantId === 'string' ? metadata.tenantId : undefined;

export const authRoutes: FastifyPluginAsync<{ environment: Environment; email: EmailProvider; notificationsQueue?: Queue }> = async (app, options) => {
  const { environment, email } = options;

  app.post('/auth/register', { config: { rateLimit: { max: environment.NODE_ENV === 'test' ? 100 : 5, timeWindow: '1 hour' } } }, async (request, reply) => {
    const input = parse(registrationSchema, request.body); const normalizedEmail = normalizeEmail(input.email);
    if (!publicRoleNames.includes(input.role)) throw new ApiError(403, 'ROLE_NOT_PUBLIC', 'This role cannot be registered publicly');
    const existing = await database.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) throw new ApiError(409, 'ACCOUNT_EXISTS', 'An account with this email already exists');
    const passwordHash = await hashPassword(input.password); const slugBase = input.organizationName.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 60) || 'tenant';
    const token = await database.$transaction(async (transaction) => {
      const role = await transaction.role.findFirst({ where: { name: input.role, tenantId: null } }); if (!role) throw new ApiError(500, 'RBAC_NOT_INITIALIZED', 'RBAC roles are not initialized');
      const tenant = await transaction.tenant.create({ data: { name: input.organizationName, slug: `${slugBase}-${crypto.randomUUID().slice(0, 8)}` } });
      const user = await transaction.user.create({ data: { email: normalizedEmail, passwordHash, displayName: input.displayName } });
      await transaction.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: 'INVITED' } });
      await transaction.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
      const rawToken = generateOpaqueToken();
      await transaction.authToken.create({ data: { userId: user.id, type: 'EMAIL_VERIFICATION', tokenHash: hashOpaqueToken(rawToken, environment.SESSION_SECRET), expiresAt: expiresFromNow(environment.EMAIL_TOKEN_TTL_MINUTES) } });
      await transaction.auditLog.create({ data: { tenantId: tenant.id, actorUserId: user.id, requestId: request.id, action: 'auth.registration', resourceType: 'user', resourceId: user.id, ipAddress: request.ip, metadata: { role: input.role } } });
      return { rawToken, userId: user.id, tenantId: tenant.id };
    });
    try { await email.send({ to: normalizedEmail, subject: 'Verify your ZeroRoot email', text: `Verify your account: ${environment.APP_URL}/verify-email?token=${encodeURIComponent(token.rawToken)}\nThis link expires in ${environment.EMAIL_TOKEN_TTL_MINUTES} minutes.` }); }
    catch (error) { request.log.error({ err: error, errorCode: 'EMAIL_DELIVERY_FAILED', userId: token.userId }, 'email.verification.failed'); throw new ApiError(503, 'EMAIL_DELIVERY_FAILED', 'Account created, but verification email could not be delivered. Request a new link.'); }
    await publishTenantEvent({ tenantId: token.tenantId, recipientId: token.userId, eventType: 'REGISTRATION', deduplicationKey: `registration:${token.userId}`, title: 'Registration received', message: 'Your ZeroRoot account was registered. Verify your email to continue.', actionUrl: '/verify-email' }, options.notificationsQueue);
    return reply.code(202).send({ status: 'VERIFICATION_REQUIRED' });
  });

  app.post('/auth/resend-verification', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (request, reply) => {
    const { email: address } = parse(forgotPasswordSchema, request.body); const user = await database.user.findUnique({ where: { email: normalizeEmail(address) } });
    if (user && !user.emailVerifiedAt && user.status === 'REGISTERED') {
      await database.authToken.updateMany({ where: { userId: user.id, type: 'EMAIL_VERIFICATION', usedAt: null }, data: { usedAt: new Date() } });
      const token = await issueAuthToken(user.id, 'EMAIL_VERIFICATION', environment.EMAIL_TOKEN_TTL_MINUTES, environment);
      await email.send({ to: user.email, subject: 'Verify your ZeroRoot email', text: `Verify your account: ${environment.APP_URL}/verify-email?token=${encodeURIComponent(token)}` });
    }
    return reply.code(202).send({ status: 'ACCEPTED' });
  });

  app.post('/auth/verify-email', async (request) => {
    const { token } = parse(tokenSchema, request.body); let tenantId: string | undefined;
    const userId = await consumeAuthToken(token, 'EMAIL_VERIFICATION', environment, async (transaction, id) => {
      const assignment = await transaction.userRole.findFirst({ where: { userId: id }, include: { role: true } }); if (!assignment) throw new ApiError(400, 'ACCOUNT_INVALID', 'Account role is missing');
      tenantId = assignment.tenantId; const requiresApproval = ['Agency', 'Affiliate', 'Cybersecurity Specialist'].includes(assignment.role.name);
      await transaction.user.update({ where: { id }, data: { emailVerifiedAt: new Date(), status: requiresApproval ? 'PENDING_APPROVAL' : 'APPROVED' } });
      if (!requiresApproval) await transaction.tenantMembership.update({ where: { tenantId_userId: { tenantId: assignment.tenantId, userId: id } }, data: { status: 'ACTIVE' } });
      return id;
    });
    await writeAudit({ tenantId, actorUserId: userId, requestId: request.id, action: 'auth.email_verified', resourceType: 'user', resourceId: userId, ipAddress: request.ip });
    const user = await database.user.findUniqueOrThrow({ where: { id: userId }, select: { status: true } }); if(tenantId)await publishTenantEvent({tenantId,recipientId:userId,eventType:'EMAIL_VERIFICATION',deduplicationKey:`email-verified:${userId}`,title:'Email verified',message:user.status==='PENDING_APPROVAL'?'Your email is verified and your account is awaiting approval.':'Your email is verified and your account is active.',actionUrl:user.status==='PENDING_APPROVAL'?'/approval-pending':'/account'},options.notificationsQueue);return { status: user.status };
  });

  app.post<{ Params: { portal: string } }>('/auth/:portal/login', { config: { rateLimit: { max: environment.NODE_ENV === 'test' ? 100 : 10, timeWindow: '15 minutes' } } }, async (request, reply) => {
    const expectedRole = portalRoles[request.params.portal as keyof typeof portalRoles]; if (!expectedRole) throw new ApiError(404, 'PORTAL_NOT_FOUND', 'Login portal not found');
    const input = parse(loginSchema, request.body); const normalizedEmail = normalizeEmail(input.email);
    const user = await database.user.findUnique({ where: { email: normalizedEmail }, include: { memberships: true, userRoles: { include: { role: true, tenant: true } } } });
    let passwordValid = false; if (user?.passwordHash) passwordValid = await verifyPassword(user.passwordHash, input.password); else await hashPassword(input.password);
    const assignment = user?.userRoles.find((item) => item.role.name === expectedRole && user.memberships.some((membership) => membership.tenantId === item.tenantId && membership.status === 'ACTIVE')) ?? user?.userRoles.find((item) => item.role.name === expectedRole);
    if (!user || !passwordValid || !assignment) {
      if (user) { const attempts = user.failedLoginAttempts + 1; await database.user.update({ where: { id: user.id }, data: { failedLoginAttempts: attempts, ...(attempts >= 5 ? { lockedUntil: new Date(Date.now() + 15 * 60_000) } : {}) } }); }
      await writeAudit({ tenantId: assignment?.tenantId, actorUserId: user?.id, requestId: request.id, action: 'auth.login_failed', resourceType: 'user', resourceId: user?.id, ipAddress: request.ip, metadata: { emailFingerprint: hashOpaqueToken(normalizedEmail, environment.SESSION_SECRET), portal: request.params.portal } });
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
    }
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new ApiError(429, 'ACCOUNT_LOCKED', 'Account temporarily locked');
    if (!user.emailVerifiedAt) throw new ApiError(403, 'EMAIL_VERIFICATION_REQUIRED', 'Email verification is required');
    if (user.status === 'PENDING_APPROVAL') throw new ApiError(403, 'APPROVAL_PENDING', 'Account approval is pending');
    if (user.status === 'REJECTED') throw new ApiError(403, 'ACCOUNT_REJECTED', 'Account registration was rejected');
    if (user.status === 'SUSPENDED') throw new ApiError(403, 'ACCOUNT_SUSPENDED', 'Account is suspended');
    if (user.status === 'DEACTIVATED') throw new ApiError(403, 'ACCOUNT_DEACTIVATED', 'Account is deactivated');
    if (user.status !== 'APPROVED') throw new ApiError(403, 'ACCOUNT_INACTIVE', 'Account is not active');
    if (!user.memberships.some((item) => item.tenantId === assignment.tenantId && item.status === 'ACTIVE')) throw new ApiError(403, 'TENANT_ACCESS_DENIED', 'Tenant membership is not active');
    await database.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0, lockedUntil: null } });
    if (expectedRole === 'Owner' || user.mfaEnabledAt) {
      const purpose = expectedRole === 'Owner' && !user.mfaEnabledAt ? 'enrollment' : 'login'; const enrollmentPending = purpose === 'enrollment' && Boolean(user.mfaSecretEncrypted); const challengeToken = await issueAuthToken(user.id, 'MFA_CHALLENGE', environment.MFA_CHALLENGE_TTL_MINUTES, environment, { purpose, tenantId: assignment.tenantId });
      await writeAudit({ tenantId: assignment.tenantId, actorUserId: user.id, requestId: request.id, action: 'auth.mfa_challenge', resourceType: 'user', resourceId: user.id, ipAddress: request.ip });
      return reply.code(202).send({ mfaRequired: true, enrollmentRequired: purpose === 'enrollment' && !enrollmentPending, enrollmentPending, challengeToken });
    }
    const session = await createSession(user.id, assignment.tenantId, environment, requestContext(request)); setSessionCookie(reply, session.token, environment);
    await writeAudit({ tenantId: assignment.tenantId, actorUserId: user.id, requestId: request.id, action: 'auth.login', resourceType: 'session', resourceId: session.sessionId, ipAddress: request.ip });
    return { user: { id: user.id, displayName: user.displayName, role: expectedRole, tenantId: assignment.tenantId }, expiresAt: session.expiresAt };
  });

  app.post('/auth/forgot-password', { config: { rateLimit: { max: 3, timeWindow: '1 hour' } } }, async (request, reply) => {
    const input = parse(forgotPasswordSchema, request.body); const user = await database.user.findUnique({ where: { email: normalizeEmail(input.email) } });
    if (user?.emailVerifiedAt && !['SUSPENDED', 'DEACTIVATED'].includes(user.status)) {
      await database.authToken.updateMany({ where: { userId: user.id, type: 'PASSWORD_RESET', usedAt: null }, data: { usedAt: new Date() } });
      const token = await issueAuthToken(user.id, 'PASSWORD_RESET', environment.RESET_TOKEN_TTL_MINUTES, environment);
      await email.send({ to: user.email, subject: 'Reset your ZeroRoot password', text: `Reset your password: ${environment.APP_URL}/reset-password?token=${encodeURIComponent(token)}\nThis link expires in ${environment.RESET_TOKEN_TTL_MINUTES} minutes.` });
      await writeAudit({ actorUserId: user.id, requestId: request.id, action: 'auth.password_reset_requested', resourceType: 'user', resourceId: user.id, ipAddress: request.ip });
    }
    return reply.code(202).send({ status: 'ACCEPTED' });
  });

  app.post('/auth/reset-password', async (request) => {
    const input = parse(resetPasswordSchema, request.body); const passwordHash = await hashPassword(input.password); let tenantId: string | undefined;
    const userId = await consumeAuthToken(input.token, 'PASSWORD_RESET', environment, async (transaction, id) => {
      const membership = await transaction.tenantMembership.findFirst({ where: { userId: id } }); tenantId = membership?.tenantId;
      await transaction.user.update({ where: { id }, data: { passwordHash, failedLoginAttempts: 0, lockedUntil: null } });
      await transaction.session.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'password_reset' } }); return id;
    });
    await writeAudit({ tenantId, actorUserId: userId, requestId: request.id, action: 'auth.password_reset', resourceType: 'user', resourceId: userId, ipAddress: request.ip }); return { status: 'PASSWORD_RESET' };
  });

  app.post('/auth/logout', { preHandler: (request) => authenticate(request, environment) }, async (request, reply) => {
    await database.session.update({ where: { id: request.sessionId! }, data: { revokedAt: new Date(), revokedReason: 'logout' } }); clearSessionCookie(reply, environment);
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'auth.logout', resourceType: 'session', resourceId: request.sessionId, ipAddress: request.ip }); return reply.code(204).send();
  });

  app.get('/auth/sessions', { preHandler: (request) => authenticate(request, environment) }, async (request) => ({ sessions: await database.session.findMany({ where: { userId: request.userId!, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true, createdAt: true, lastSeenAt: true, expiresAt: true, ipAddress: true, userAgent: true, mfaVerifiedAt: true }, orderBy: { lastSeenAt: 'desc' } }) }));

  app.delete<{ Params: { id: string } }>('/auth/sessions/:id', { preHandler: (request) => authenticate(request, environment) }, async (request, reply) => {
    const result = await database.session.updateMany({ where: { id: request.params.id, userId: request.userId!, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'user_revoked' } }); if (!result.count) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found');
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'auth.session_revoked', resourceType: 'session', resourceId: request.params.id, ipAddress: request.ip }); if (request.params.id === request.sessionId) clearSessionCookie(reply, environment); return reply.code(204).send();
  });

  app.delete('/auth/sessions', { preHandler: (request) => authenticate(request, environment) }, async (request, reply) => {
    await database.session.updateMany({ where: { userId: request.userId!, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: 'logout_all' } }); clearSessionCookie(reply, environment);
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'auth.sessions_revoked_all', resourceType: 'user', resourceId: request.userId, ipAddress: request.ip }); return reply.code(204).send();
  });

  app.get('/auth/me', { preHandler: (request) => authenticate(request, environment) }, async (request) => {
    const [user, tenant] = await Promise.all([
      database.user.findUniqueOrThrow({ where: { id: request.userId! }, select: { id: true, email: true, displayName: true, emailVerifiedAt: true, createdAt: true } }),
      database.tenant.findUniqueOrThrow({ where: { id: request.tenantId! }, select: { id: true, name: true, slug: true } })
    ]);
    return { user, tenant, roles: request.roleNames, permissions: request.permissions, mfaVerified: Boolean(request.mfaVerifiedAt) };
  });
};

export { metadataPurpose, metadataTenantId, parse, requestContext };
