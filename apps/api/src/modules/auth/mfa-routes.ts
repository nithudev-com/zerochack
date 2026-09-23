import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { database } from '@zerochack/database';
import type { Environment } from '@zerochack/config';
import { decryptSecret, encryptSecret, generateRecoveryCodes, generateTotpSecret, hashOpaqueToken, verifyTotp } from '@zerochack/auth';
import { mfaCodeSchema, tokenSchema } from '@zerochack/validation';
import { ApiError } from '../../errors.js';
import { authenticate, requireOwnerMfa, requireOwnerRole, setSessionCookie } from './security.js';
import { consumeAuthToken, createSession, writeAudit } from './service.js';
import { metadataPurpose, metadataTenantId, parse, requestContext } from './routes.js';

const recoveryHashes = (codes: string[], environment: Environment) => codes.map((code) => ({ codeHash: hashOpaqueToken(code, environment.SESSION_SECRET) }));

export const mfaRoutes: FastifyPluginAsync<{ environment: Environment }> = async (app, { environment }) => {
  app.post('/auth/mfa/enroll', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request) => {
    const { token } = parse(tokenSchema, request.body); const record = await database.authToken.findUnique({ where: { tokenHash: hashOpaqueToken(token, environment.SESSION_SECRET) }, include: { user: { include: { userRoles: { include: { role: true } } } } } });
    if (!record || record.type !== 'MFA_CHALLENGE' || record.usedAt || record.expiresAt <= new Date() || metadataPurpose(record.metadata) !== 'enrollment' || !record.user.userRoles.some((item) => item.role.name === 'Owner')) throw new ApiError(400, 'MFA_CHALLENGE_INVALID', 'MFA enrollment challenge is invalid');
    const secret = record.user.mfaSecretEncrypted ? decryptSecret(record.user.mfaSecretEncrypted, environment.MFA_ENCRYPTION_KEY) : generateTotpSecret();
    if (!record.user.mfaSecretEncrypted) await database.user.update({ where: { id: record.userId }, data: { mfaSecretEncrypted: encryptSecret(secret, environment.MFA_ENCRYPTION_KEY), mfaEnabledAt: null } });
    await writeAudit({ actorUserId: record.userId, requestId: request.id, action: 'auth.mfa_enrollment_started', resourceType: 'user', resourceId: record.userId, ipAddress: request.ip });
    return { secret, otpauthUri: `otpauth://totp/ZeroRoot:${encodeURIComponent(record.user.email)}?secret=${secret}&issuer=ZeroRoot&algorithm=SHA1&digits=6&period=30` };
  });

  app.post('/auth/mfa/confirm', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const input = parse(mfaCodeSchema, request.body); let tenantId = '';
    const result = await consumeAuthToken(input.challengeToken, 'MFA_CHALLENGE', environment, async (transaction, userId, metadata) => {
      const challengeTenantId = metadataTenantId(metadata); if (metadataPurpose(metadata) !== 'enrollment' || !challengeTenantId) throw new ApiError(400, 'MFA_CHALLENGE_INVALID', 'MFA enrollment challenge is invalid');
      const user = await transaction.user.findUniqueOrThrow({ where: { id: userId }, include: { memberships: true, userRoles: { include: { role: true } } } }); const owner = user.userRoles.find((item) => item.role.name === 'Owner' && item.tenantId === challengeTenantId);
      if (!owner || !user.memberships.some((item) => item.tenantId === challengeTenantId && item.status === 'ACTIVE') || !user.mfaSecretEncrypted) throw new ApiError(403, 'OWNER_REQUIRED', 'Owner authorization required'); tenantId = challengeTenantId;
      const secret = decryptSecret(user.mfaSecretEncrypted, environment.MFA_ENCRYPTION_KEY); if (!verifyTotp(secret, input.code)) throw new ApiError(401, 'MFA_CODE_INVALID', 'MFA code is invalid');
      const codes = generateRecoveryCodes(); await transaction.mfaRecoveryCode.deleteMany({ where: { userId } }); await transaction.mfaRecoveryCode.createMany({ data: recoveryHashes(codes, environment).map((item) => ({ userId, ...item })) });
      await transaction.user.update({ where: { id: userId }, data: { mfaEnabledAt: new Date() } }); return { userId, codes };
    });
    const session = await createSession(result.userId, tenantId, environment, { ...requestContext(request), mfaVerified: true }); setSessionCookie(reply, session.token, environment);
    await writeAudit({ tenantId, actorUserId: result.userId, requestId: request.id, action: 'auth.mfa_enrolled', resourceType: 'session', resourceId: session.sessionId, ipAddress: request.ip });
    return { recoveryCodes: result.codes, expiresAt: session.expiresAt };
  });

  app.post('/auth/mfa/verify', { config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request, reply) => {
    const input = parse(mfaCodeSchema, request.body); let tenantId = '';
    const userId = await consumeAuthToken(input.challengeToken, 'MFA_CHALLENGE', environment, async (transaction, id, metadata) => {
      const challengeTenantId = metadataTenantId(metadata); if (metadataPurpose(metadata) !== 'login' || !challengeTenantId) throw new ApiError(400, 'MFA_CHALLENGE_INVALID', 'MFA login challenge is invalid');
      const user = await transaction.user.findUniqueOrThrow({ where: { id }, include: { memberships: true, userRoles: { include: { role: true } } } }); const assignment = user.userRoles.find((item) => item.tenantId === challengeTenantId);
      if (!assignment || !user.memberships.some((item) => item.tenantId === challengeTenantId && item.status === 'ACTIVE') || !user.mfaSecretEncrypted || !user.mfaEnabledAt || user.status !== 'APPROVED') throw new ApiError(403, 'MFA_REQUIRED', 'Account MFA is unavailable'); tenantId = challengeTenantId;
      const secret = decryptSecret(user.mfaSecretEncrypted, environment.MFA_ENCRYPTION_KEY); let valid = verifyTotp(secret, input.code);
      if (!valid) { const codeHash = hashOpaqueToken(input.code.toLowerCase(), environment.SESSION_SECRET); const used = await transaction.mfaRecoveryCode.updateMany({ where: { userId: id, codeHash, usedAt: null }, data: { usedAt: new Date() } }); valid = used.count === 1; }
      if (!valid) throw new ApiError(401, 'MFA_CODE_INVALID', 'MFA code or recovery code is invalid'); return id;
    });
    const session = await createSession(userId, tenantId, environment, { ...requestContext(request), mfaVerified: true }); setSessionCookie(reply, session.token, environment);
    await writeAudit({ tenantId, actorUserId: userId, requestId: request.id, action: 'auth.mfa_verified', resourceType: 'session', resourceId: session.sessionId, ipAddress: request.ip }); return { expiresAt: session.expiresAt };
  });

  app.get('/auth/mfa/status', { preHandler: (request) => authenticate(request, environment) }, async (request) => {
    const user = await database.user.findUniqueOrThrow({ where: { id: request.userId! }, select: { mfaEnabledAt: true } });
    return { enabled: Boolean(user.mfaEnabledAt), enabledAt: user.mfaEnabledAt, required: (request.roleNames ?? []).includes('Owner') };
  });

  app.post('/auth/mfa/setup', { preHandler: (request) => authenticate(request, environment) }, async (request) => {
    if ((request.roleNames ?? []).includes('Owner')) throw new ApiError(403, 'OWNER_MFA_REQUIRED', 'Owner MFA is managed during sign in');
    if (!(request.roleNames ?? []).some((role) => ['Customer', 'Agency', 'Affiliate', 'Cybersecurity Specialist'].includes(role))) throw new ApiError(403, 'MFA_NOT_AVAILABLE', 'Optional MFA is unavailable for this role');
    const user = await database.user.findUniqueOrThrow({ where: { id: request.userId! }, select: { email: true, mfaEnabledAt: true } });
    if (user.mfaEnabledAt) throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'Authenticator MFA is already enabled');
    const secret = generateTotpSecret(); await database.user.update({ where: { id: request.userId! }, data: { mfaSecretEncrypted: encryptSecret(secret, environment.MFA_ENCRYPTION_KEY) } });
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'auth.optional_mfa_setup_started', resourceType: 'user', resourceId: request.userId, ipAddress: request.ip });
    return { secret, otpauthUri: `otpauth://totp/ZeroRoot:${encodeURIComponent(user.email)}?secret=${secret}&issuer=ZeroRoot&algorithm=SHA1&digits=6&period=30` };
  });

  app.post('/auth/mfa/enable', { preHandler: (request) => authenticate(request, environment) }, async (request) => {
    if ((request.roleNames ?? []).includes('Owner')) throw new ApiError(403, 'OWNER_MFA_REQUIRED', 'Owner MFA is managed during sign in');
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/u) }), request.body); const user = await database.user.findUniqueOrThrow({ where: { id: request.userId! } });
    if (!user.mfaSecretEncrypted || !verifyTotp(decryptSecret(user.mfaSecretEncrypted, environment.MFA_ENCRYPTION_KEY), code)) throw new ApiError(401, 'MFA_CODE_INVALID', 'MFA code is invalid');
    const codes = generateRecoveryCodes(); await database.$transaction(async (tx) => { await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }); await tx.mfaRecoveryCode.createMany({ data: recoveryHashes(codes, environment).map((item) => ({ userId: user.id, ...item })) }); await tx.user.update({ where: { id: user.id }, data: { mfaEnabledAt: new Date() } }); });
    await writeAudit({ tenantId: request.tenantId, actorUserId: user.id, requestId: request.id, action: 'auth.optional_mfa_enabled', resourceType: 'user', resourceId: user.id, ipAddress: request.ip }); return { enabled: true, recoveryCodes: codes };
  });

  app.post('/auth/mfa/disable', { preHandler: (request) => authenticate(request, environment) }, async (request) => {
    if ((request.roleNames ?? []).includes('Owner')) throw new ApiError(403, 'OWNER_MFA_REQUIRED', 'Owner MFA cannot be disabled');
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/u) }), request.body); const user = await database.user.findUniqueOrThrow({ where: { id: request.userId! } });
    if (!user.mfaSecretEncrypted || !user.mfaEnabledAt || !verifyTotp(decryptSecret(user.mfaSecretEncrypted, environment.MFA_ENCRYPTION_KEY), code)) throw new ApiError(401, 'MFA_CODE_INVALID', 'MFA code is invalid');
    await database.$transaction(async (tx) => { await tx.mfaRecoveryCode.deleteMany({ where: { userId: user.id } }); await tx.user.update({ where: { id: user.id }, data: { mfaSecretEncrypted: null, mfaEnabledAt: null } }); });
    await writeAudit({ tenantId: request.tenantId, actorUserId: user.id, requestId: request.id, action: 'auth.optional_mfa_disabled', resourceType: 'user', resourceId: user.id, ipAddress: request.ip }); return { enabled: false };
  });

  app.post('/auth/mfa/step-up', { preHandler: (request) => authenticate(request, environment), config: { rateLimit: { max: 5, timeWindow: '5 minutes' } } }, async (request) => {
    if (!(request.roleNames ?? []).includes('Cybersecurity Specialist')) requireOwnerRole(request); const body = parse({ safeParse: (input: unknown) => typeof input === 'object' && input !== null && 'code' in input && typeof input.code === 'string' ? { success: true as const, data: { code: input.code } } : { success: false as const, error: { flatten: () => ({ fieldErrors: { code: ['Required'] } }) } } }, request.body);
    const user = await database.user.findUniqueOrThrow({ where: { id: request.userId! } }); if (!user.mfaEnabledAt || !user.mfaSecretEncrypted || !verifyTotp(decryptSecret(user.mfaSecretEncrypted, environment.MFA_ENCRYPTION_KEY), body.code)) throw new ApiError(401, 'MFA_CODE_INVALID', 'MFA code is invalid');
    await database.session.update({ where: { id: request.sessionId! }, data: { mfaVerifiedAt: new Date() } }); await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'auth.mfa_step_up', resourceType: 'session', resourceId: request.sessionId, ipAddress: request.ip }); return { status: 'VERIFIED' };
  });

  app.post('/auth/mfa/recovery-codes', { preHandler: (request) => authenticate(request, environment) }, async (request) => {
    requireOwnerMfa(request); const codes = generateRecoveryCodes(); await database.$transaction(async (transaction) => { await transaction.mfaRecoveryCode.deleteMany({ where: { userId: request.userId! } }); await transaction.mfaRecoveryCode.createMany({ data: recoveryHashes(codes, environment).map((item) => ({ userId: request.userId!, ...item })) }); });
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'auth.mfa_recovery_regenerated', resourceType: 'user', resourceId: request.userId, ipAddress: request.ip }); return { recoveryCodes: codes };
  });
};
