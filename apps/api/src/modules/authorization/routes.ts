import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { database } from '@zerochack/database';
import type { Environment } from '@zerochack/config';
import { approvalSchema, uuidSchema } from '@zerochack/validation';
import { ApiError } from '../../errors.js';
import { authenticate, requireOwnerMfa, requirePermission } from '../auth/security.js';
import { parse } from '../auth/routes.js';
import { writeAudit } from '../auth/service.js';
import { randomBytes } from 'node:crypto';
import type { Queue } from 'bullmq';
import { publishTenantEvent } from '../communications/service.js';

async function authorizeTenant(request: FastifyRequest, requestedTenantId: string): Promise<void> {
  if (requestedTenantId === request.tenantId) return;
  if (!request.roleNames?.includes('Agency')) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
  const grant = await database.agencyClientRelationship.findUnique({ where: { agencyTenantId_clientTenantId: { agencyTenantId: request.tenantId!, clientTenantId: requestedTenantId } } });
  if (!grant || grant.status !== 'ACTIVE') throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
}

export const authorizationRoutes: FastifyPluginAsync<{ environment: Environment; notificationsQueue?: Queue }> = async (app, { environment, notificationsQueue }) => {
  app.addHook('onSend', async (_request, reply) => { void reply.header('cache-control', 'private, no-store'); });

  app.get('/owner/approvals', { preHandler: (request) => authenticate(request, environment) }, async (request) => {
    requireOwnerMfa(request); requirePermission(request, 'users.read');
    return { users: await database.user.findMany({ where: { status: 'PENDING_APPROVAL' }, select: { id: true, email: true, displayName: true, status: true, emailVerifiedAt: true, createdAt: true, userRoles: { select: { tenantId: true, role: { select: { name: true } } } } }, orderBy: { createdAt: 'asc' } }) };
  });

  app.patch<{ Params: { userId: string } }>('/owner/users/:userId/status', { preHandler: (request) => authenticate(request, environment) }, async (request) => {
    requireOwnerMfa(request); const userId = parse(uuidSchema, request.params.userId); const input = parse(approvalSchema, request.body); requirePermission(request, ['APPROVED', 'REJECTED'].includes(input.status) ? 'users.approve' : 'users.suspend');
    if (userId === request.userId) throw new ApiError(400, 'SELF_STATUS_CHANGE_FORBIDDEN', 'Owners cannot change their own account status');
    const target = await database.user.findUnique({ where: { id: userId }, include: { memberships: true, userRoles: { include: { role: true } } } }); if (!target || target.userRoles.some((item) => item.role.name === 'Owner')) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
    if (input.status === 'APPROVED' && !target.emailVerifiedAt) throw new ApiError(409, 'EMAIL_NOT_VERIFIED', 'Email must be verified before approval');
    await database.$transaction(async (transaction) => {
      await transaction.user.update({ where: { id: userId }, data: { status: input.status } });
      await transaction.tenantMembership.updateMany({ where: { userId }, data: { status: input.status === 'APPROVED' ? 'ACTIVE' : 'SUSPENDED' } });
      if (input.status === 'APPROVED' && target.userRoles.some((item) => item.role.name === 'Affiliate') && target.memberships[0]) await transaction.affiliateProfile.upsert({ where: { userId }, create: { userId, tenantId: target.memberships[0].tenantId, code: `ZC${randomBytes(8).toString('hex').toUpperCase()}` }, update: { active: true } });
      if (input.status !== 'APPROVED') await transaction.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date(), revokedReason: `account_${input.status.toLowerCase()}` } });
    });
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: `user.${input.status.toLowerCase()}`, resourceType: 'user', resourceId: userId, ipAddress: request.ip, metadata: input.reason ? { reason: input.reason } : undefined });const recipientTenant=target.memberships[0]?.tenantId;if(recipientTenant&&(input.status==='APPROVED'||input.status==='SUSPENDED'))await publishTenantEvent({tenantId:recipientTenant,recipientId:userId,eventType:input.status==='APPROVED'?'APPROVAL':'SUSPENSION',deduplicationKey:`account-${input.status.toLowerCase()}:${userId}`,title:input.status==='APPROVED'?'Account approved':'Account suspended',message:input.status==='APPROVED'?'Your ZeroRoot account has been approved.':'Your ZeroRoot account has been suspended. Contact support if you believe this is an error.',actionUrl:input.status==='APPROVED'?'/account':'/suspended'},notificationsQueue);return { status: input.status };
  });

  app.post<{ Params: { userId: string }; Body: { role: string; tenantId: string } }>('/owner/users/:userId/roles', { preHandler: (request) => authenticate(request, environment) }, async (request, reply) => {
    requireOwnerMfa(request); requirePermission(request, 'roles.manage'); const userId = parse(uuidSchema, request.params.userId); const tenantId = parse(uuidSchema, request.body?.tenantId);
    if (request.body?.role === 'Owner') throw new ApiError(403, 'OWNER_ROLE_PROTECTED', 'Owner role cannot be assigned through the API');
    const role = await database.role.findFirst({ where: { name: request.body?.role, tenantId: null } }); const membership = await database.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId, userId } } }); if (!role || !membership) throw new ApiError(404, 'ASSIGNMENT_TARGET_NOT_FOUND', 'Role or membership not found');
    await database.userRole.upsert({ where: { tenantId_userId_roleId: { tenantId, userId, roleId: role.id } }, create: { tenantId, userId, roleId: role.id }, update: {} });
    await writeAudit({ tenantId, actorUserId: request.userId, requestId: request.id, action: 'rbac.role_assigned', resourceType: 'user', resourceId: userId, ipAddress: request.ip, metadata: { role: role.name } }); return reply.code(201).send({ assigned: true });
  });

  app.post<{ Body: { agencyTenantId: string; clientTenantId: string; permissions?: Array<'CLIENT_READ' | 'WEBSITES_READ' | 'SECURITY_READ' | 'TICKETS_READ' | 'SUBSCRIPTIONS_READ' | 'BILLING_READ' | 'QUOTES_READ' | 'QUOTES_MANAGE'> } }>('/owner/agency-clients', { preHandler: (request) => authenticate(request, environment) }, async (request, reply) => {
    requireOwnerMfa(request); requirePermission(request, 'tenants.manage'); const agencyTenantId = parse(uuidSchema, request.body?.agencyTenantId); const clientTenantId = parse(uuidSchema, request.body?.clientTenantId);
    if (agencyTenantId === clientTenantId) throw new ApiError(400, 'SELF_RELATIONSHIP_FORBIDDEN', 'Agency and client tenants must differ');
    const permissions = request.body?.permissions ?? ['CLIENT_READ', 'WEBSITES_READ', 'SECURITY_READ', 'TICKETS_READ', 'SUBSCRIPTIONS_READ', 'BILLING_READ', 'QUOTES_READ'];
    const [agencyRoleCount, customerRoleCount] = await Promise.all([
      database.userRole.count({ where: { tenantId: agencyTenantId, role: { name: 'Agency' } } }),
      database.userRole.count({ where: { tenantId: clientTenantId, role: { name: 'Customer' } } })
    ]);
    if (!agencyRoleCount || !customerRoleCount) throw new ApiError(409, 'INVALID_AGENCY_CLIENT_PAIR', 'Relationship requires an Agency tenant and Customer tenant');
    const relationship = await database.agencyClientRelationship.upsert({ where: { agencyTenantId_clientTenantId: { agencyTenantId, clientTenantId } }, create: { agencyTenantId, clientTenantId, status: 'ACTIVE', permissions, activatedAt: new Date() }, update: { status: 'ACTIVE', permissions, activatedAt: new Date(), revokedAt: null } });
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'tenant.agency_access_granted', resourceType: 'agency_client_relationship', resourceId: relationship.id, ipAddress: request.ip, metadata: { agencyTenantId, clientTenantId, permissions } }); return reply.code(201).send({ id: relationship.id, status: relationship.status, permissions: relationship.permissions });
  });

  app.patch<{ Params: { relationshipId: string }; Body: { status: 'ACTIVE' | 'REVOKED'; permissions?: Array<'CLIENT_READ' | 'WEBSITES_READ' | 'SECURITY_READ' | 'TICKETS_READ' | 'SUBSCRIPTIONS_READ' | 'BILLING_READ' | 'QUOTES_READ' | 'QUOTES_MANAGE'> } }>('/owner/agency-clients/:relationshipId', { preHandler: (request) => authenticate(request, environment) }, async (request) => {
    requireOwnerMfa(request); requirePermission(request, 'tenants.manage'); const id = parse(uuidSchema, request.params.relationshipId); const relationship = await database.agencyClientRelationship.findUnique({ where: { id } }); if (!relationship) throw new ApiError(404, 'RELATIONSHIP_NOT_FOUND', 'Agency client relationship was not found');
    const status = request.body?.status; if (!['ACTIVE', 'REVOKED'].includes(status)) throw new ApiError(400, 'VALIDATION_ERROR', 'Status must be ACTIVE or REVOKED'); const permissions = request.body.permissions ?? relationship.permissions;
    const updated = await database.agencyClientRelationship.update({ where: { id }, data: { status, permissions: status === 'REVOKED' ? [] : permissions, ...(status === 'ACTIVE' ? { activatedAt: new Date(), revokedAt: null } : { revokedAt: new Date() }) } });
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: status === 'ACTIVE' ? 'tenant.agency_access_updated' : 'tenant.agency_access_revoked', resourceType: 'agency_client_relationship', resourceId: id, ipAddress: request.ip, metadata: { agencyTenantId: relationship.agencyTenantId, clientTenantId: relationship.clientTenantId, permissions: updated.permissions } }); return { id: updated.id, status: updated.status, permissions: updated.permissions };
  });

  app.get<{ Params: { tenantId: string } }>('/tenants/:tenantId/access-check', { preHandler: (request) => authenticate(request, environment) }, async (request) => { const tenantId = parse(uuidSchema, request.params.tenantId); await authorizeTenant(request, tenantId); return { tenantId, authorized: true }; });
};

export { authorizeTenant };
