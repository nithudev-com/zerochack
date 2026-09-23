import { randomUUID } from 'node:crypto';
import type { AgencyClientPermission, AgencyClientRelationship, Prisma } from '@prisma/client';
import { database } from '@zerochack/database';
import type { Environment } from '@zerochack/config';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiError } from '../../errors.js';
import { authenticate, requireOwnerMfa, requirePermission } from '../auth/security.js';
import { parse } from '../auth/routes.js';
import { writeAudit } from '../auth/service.js';

const uuid = z.string().uuid();
const defaultGrant: AgencyClientPermission[] = ['CLIENT_READ', 'WEBSITES_READ', 'SECURITY_READ', 'TICKETS_READ', 'SUBSCRIPTIONS_READ', 'BILLING_READ', 'QUOTES_READ'];

function agency(request: FastifyRequest, permission: string): void {
  if (!request.roleNames?.includes('Agency')) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
  requirePermission(request, permission);
}

async function authorizedClient(request: FastifyRequest, clientTenantId: string, capability: AgencyClientPermission): Promise<AgencyClientRelationship> {
  const grant = await database.agencyClientRelationship.findUnique({ where: { agencyTenantId_clientTenantId: { agencyTenantId: request.tenantId!, clientTenantId } } });
  if (!grant || grant.status !== 'ACTIVE' || !grant.permissions.includes(capability)) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
  return grant;
}

const clientSelect = {
  id: true, name: true, slug: true,
  websites: { where: { lifecycle: 'ACTIVE' }, select: { id: true, name: true, url: true, connectionStatus: true, securityStatus: true, monitoringStatus: true, backupStatus: true, lastScanAt: true, _count: { select: { findings: { where: { status: { in: ['OPEN', 'REOPENED', 'IN_REMEDIATION'] } } }, tickets: { where: { status: { notIn: ['CLOSED', 'CANCELLED'] } } } } } } },
  subscriptions: { orderBy: { createdAt: 'desc' as const }, take: 1, select: { id: true, planName: true, status: true, currentPeriodEnd: true } },
} satisfies Prisma.TenantSelect;

export const agencyRoutes: FastifyPluginAsync<{ environment: Environment }> = async (app, { environment }) => {
  app.addHook('onSend', async (_request, reply) => { void reply.header('cache-control', 'private, no-store'); });
  app.addHook('preHandler', (request) => authenticate(request, environment));

  app.get('/agency/overview', async (request) => {
    agency(request, 'agency.clients.read');
    const relationships = await database.agencyClientRelationship.findMany({ where: { agencyTenantId: request.tenantId!, status: 'ACTIVE', permissions: { has: 'CLIENT_READ' } }, select: { clientTenantId: true, permissions: true } });
    const clientIds = relationships.map((item) => item.clientTenantId); const websiteClientIds = relationships.filter((item) => item.permissions.includes('WEBSITES_READ')).map((item) => item.clientTenantId); const ticketClientIds = relationships.filter((item) => item.permissions.includes('TICKETS_READ')).map((item) => item.clientTenantId); const subscriptionClientIds = relationships.filter((item) => item.permissions.includes('SUBSCRIPTIONS_READ')).map((item) => item.clientTenantId);
    const [websites, tickets, subscriptions, notifications] = await Promise.all([
      database.website.count({ where: { tenantId: { in: websiteClientIds }, lifecycle: 'ACTIVE' } }),
      database.ticket.count({ where: { tenantId: { in: ticketClientIds }, status: { notIn: ['CLOSED', 'CANCELLED'] } } }),
      database.subscription.count({ where: { tenantId: { in: subscriptionClientIds }, status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED'] } } }),
      database.notification.count({ where: { tenantId: request.tenantId!, readAt: null } })
    ]);
    return { clients: clientIds.length, websites, openTickets: tickets, subscriptions, unreadNotifications: notifications };
  });

  app.get('/agency/clients', async (request) => {
    agency(request, 'agency.clients.read');
    const relationships = await database.agencyClientRelationship.findMany({ where: { agencyTenantId: request.tenantId!, status: 'ACTIVE', permissions: { has: 'CLIENT_READ' } }, include: { clientTenant: { select: clientSelect } }, orderBy: { activatedAt: 'desc' } });
    return { clients: relationships.map(({ clientTenant, ...grant }) => ({ ...clientTenant, websites: grant.permissions.includes('WEBSITES_READ') ? clientTenant.websites : [], subscriptions: grant.permissions.includes('SUBSCRIPTIONS_READ') ? clientTenant.subscriptions : [], grant: { id: grant.id, permissions: grant.permissions, activatedAt: grant.activatedAt } })) };
  });

  app.get<{ Params: { clientTenantId: string } }>('/agency/clients/:clientTenantId', async (request) => {
    agency(request, 'agency.clients.read'); const clientTenantId = parse(uuid, request.params.clientTenantId); const grant = await authorizedClient(request, clientTenantId, 'CLIENT_READ');
    const client = await database.tenant.findUnique({ where: { id: clientTenantId }, select: clientSelect });
    if (!client) throw new ApiError(404, 'RESOURCE_NOT_FOUND', 'Resource not found');
    return { ...client, websites: grant.permissions.includes('WEBSITES_READ') ? client.websites : [], subscriptions: grant.permissions.includes('SUBSCRIPTIONS_READ') ? client.subscriptions : [], grant: { id: grant.id, permissions: grant.permissions, activatedAt: grant.activatedAt } };
  });

  app.delete<{ Params: { clientTenantId: string } }>('/agency/clients/:clientTenantId', async (request, reply) => {
    agency(request, 'agency.clients.read'); const clientTenantId = parse(uuid, request.params.clientTenantId); const grant = await authorizedClient(request, clientTenantId, 'CLIENT_READ');
    await database.agencyClientRelationship.update({ where: { id: grant.id }, data: { status: 'REVOKED', revokedAt: new Date(), permissions: [] } });
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'agency.client_access_relinquished', resourceType: 'agency_client_relationship', resourceId: grant.id, ipAddress: request.ip, metadata: { clientTenantId } });
    return reply.code(204).send();
  });

  app.get('/agency/websites', async (request) => {
    agency(request, 'agency.websites.read');
    const grants = await database.agencyClientRelationship.findMany({ where: { agencyTenantId: request.tenantId!, status: 'ACTIVE', permissions: { has: 'WEBSITES_READ' } }, select: { clientTenantId: true } });
    return { websites: await database.website.findMany({ where: { tenantId: { in: grants.map((item) => item.clientTenantId) }, lifecycle: 'ACTIVE' }, select: { id: true, tenantId: true, name: true, url: true, connectionStatus: true, securityStatus: true, monitoringStatus: true, backupStatus: true, lastScanAt: true, tenant: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }) };
  });

  app.get<{ Params: { clientTenantId: string } }>('/agency/clients/:clientTenantId/security', async (request) => {
    agency(request, 'agency.security.read'); const clientTenantId = parse(uuid, request.params.clientTenantId); await authorizedClient(request, clientTenantId, 'SECURITY_READ');
    const [findings, tickets] = await Promise.all([database.securityFinding.groupBy({ by: ['severity'], where: { tenantId: clientTenantId, status: { in: ['OPEN', 'REOPENED', 'IN_REMEDIATION'] } }, _count: true }), database.ticket.findMany({ where: { tenantId: clientTenantId, status: { notIn: ['CLOSED', 'CANCELLED'] } }, select: { id: true, websiteId: true, title: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 100 })]);
    return { findings, tickets };
  });

  app.get<{ Params: { clientTenantId: string } }>('/agency/clients/:clientTenantId/billing', async (request) => {
    agency(request, 'agency.commerce.read'); const clientTenantId = parse(uuid, request.params.clientTenantId); const grant = await authorizedClient(request, clientTenantId, 'BILLING_READ');
    const [subscriptions, invoices, transactions] = await Promise.all([database.subscription.findMany({ where: { tenantId: clientTenantId }, orderBy: { createdAt: 'desc' }, take: 100 }), database.invoice.findMany({ where: { tenantId: clientTenantId }, orderBy: { issuedAt: 'desc' }, take: 100 }), database.paymentTransaction.findMany({ where: { tenantId: clientTenantId }, orderBy: { createdAt: 'desc' }, take: 100, select: { id: true, amountMinor: true, currency: true, status: true, failureCode: true, createdAt: true, completedAt: true } })]);
    return { relationshipId: grant.id, subscriptions, invoices, transactions };
  });

  app.get('/agency/commerce', async (request) => {
    agency(request, 'agency.commerce.read');
    const policy = await database.agencyCommercePolicy.findUnique({ where: { agencyTenantId: request.tenantId! } });
    const packages = await database.agencyPackageEntitlement.findMany({ where: { agencyTenantId: request.tenantId!, enabled: true }, include: { packageVersion: true }, orderBy: { createdAt: 'desc' } });
    return { configured: Boolean(policy), policy, packages: packages.map((item) => item.packageVersion) };
  });

  app.get('/agency/subscriptions', async (request) => {
    agency(request, 'agency.commerce.read'); const grants = await database.agencyClientRelationship.findMany({ where: { agencyTenantId: request.tenantId!, status: 'ACTIVE', permissions: { has: 'SUBSCRIPTIONS_READ' } }, select: { clientTenantId: true } });
    return { subscriptions: await database.subscription.findMany({ where: { tenantId: { in: grants.map((item) => item.clientTenantId) } }, include: { tenant: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }) };
  });

  app.get('/agency/billing', async (request) => {
    agency(request, 'agency.commerce.read'); const grants = await database.agencyClientRelationship.findMany({ where: { agencyTenantId: request.tenantId!, status: 'ACTIVE', permissions: { has: 'BILLING_READ' } }, select: { clientTenantId: true } }); const tenantIds = grants.map((item) => item.clientTenantId);
    const [invoices, transactions] = await Promise.all([database.invoice.findMany({ where: { tenantId: { in: tenantIds } }, include: { tenant: { select: { name: true } } }, orderBy: { issuedAt: 'desc' }, take: 200 }), database.paymentTransaction.findMany({ where: { tenantId: { in: tenantIds } }, include: { tenant: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 200 })]); return { invoices, transactions };
  });

  app.get('/agency/notifications', async (request) => { agency(request, 'profile.read'); return { notifications: await database.notification.findMany({ where: { tenantId: request.tenantId!,OR:[{recipientUserId:request.userId!},{recipientUserId:null}] }, orderBy: { createdAt: 'desc' }, take: 100 }) }; });

  app.get('/agency/quotes', async (request) => {
    agency(request, 'agency.commerce.read');
    return { quotes: await database.quote.findMany({ where: { agencyTenantId: request.tenantId!, relationship: { status: 'ACTIVE', permissions: { has: 'QUOTES_READ' } } }, include: { tenant: { select: { id: true, name: true } }, lineItems: true }, orderBy: { createdAt: 'desc' } }) };
  });

  app.post('/agency/quotes', async (request, reply) => {
    agency(request, 'agency.quotes.manage');
    const input = parse(z.object({ clientTenantId: uuid, packageVersionId: uuid, discountMinor: z.number().int().min(0).default(0), validUntil: z.coerce.date() }), request.body);
    if (input.validUntil <= new Date()) throw new ApiError(400, 'QUOTE_EXPIRY_INVALID', 'Quote expiry must be in the future');
    const grant = await authorizedClient(request, input.clientTenantId, 'QUOTES_MANAGE');
    const [policy, entitlement] = await Promise.all([database.agencyCommercePolicy.findUnique({ where: { agencyTenantId: request.tenantId! } }), database.agencyPackageEntitlement.findUnique({ where: { agencyTenantId_packageVersionId: { agencyTenantId: request.tenantId!, packageVersionId: input.packageVersionId } }, include: { packageVersion: true } })]);
    if (!policy) throw new ApiError(503, 'AGENCY_COMMERCE_UNCONFIGURED', 'Owner configuration is required before creating quotes');
    if (!entitlement?.enabled) throw new ApiError(403, 'PACKAGE_NOT_ENTITLED', 'This package is not enabled for the agency');
    const markupMinor = Math.floor(entitlement.packageVersion.priceMinor * policy.markupBasisPoints / 10_000); const subtotalMinor = entitlement.packageVersion.priceMinor + markupMinor; const maximumDiscount = Math.floor(subtotalMinor * policy.maxDiscountBasisPoints / 10_000);
    if (input.discountMinor > maximumDiscount) throw new ApiError(400, 'DISCOUNT_EXCEEDS_POLICY', 'Discount exceeds the owner-configured agency limit');
    const totalMinor = subtotalMinor - input.discountMinor;
    const quote = await database.quote.create({ data: { tenantId: input.clientTenantId, agencyTenantId: request.tenantId!, relationshipId: grant.id, packageVersionId: entitlement.packageVersion.id, quoteNumber: `AQ-${randomUUID()}`, currency: entitlement.packageVersion.currency, subtotalMinor, discountMinor: input.discountMinor, totalMinor, taxMinor: 0, validUntil: input.validUntil, createdByUserId: request.userId!, termsSnapshot: { packageVersionId: entitlement.packageVersion.id, packageVersion: entitlement.packageVersion.version, basePriceMinor: entitlement.packageVersion.priceMinor, markupBasisPoints: policy.markupBasisPoints, markupMinor, maxDiscountBasisPoints: policy.maxDiscountBasisPoints, revenueShareBasisPoints: policy.revenueShareBasisPoints }, lineItems: { create: [{ description: entitlement.packageVersion.name, quantity: 1, unitMinor: subtotalMinor, totalMinor: subtotalMinor }] } }, include: { lineItems: true } });
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'agency.quote_created', resourceType: 'quote', resourceId: quote.id, ipAddress: request.ip, metadata: { clientTenantId: input.clientTenantId, relationshipId: grant.id } });
    return reply.code(201).send(quote);
  });

  app.patch<{ Params: { quoteId: string } }>('/agency/quotes/:quoteId/status', async (request) => {
    agency(request, 'agency.quotes.manage'); const quoteId = parse(uuid, request.params.quoteId); const { status } = parse(z.object({ status: z.enum(['SENT', 'REJECTED', 'CANCELLED']) }), request.body);
    const quote = await database.quote.findFirst({ where: { id: quoteId, agencyTenantId: request.tenantId! } });
    if (!quote?.relationshipId) throw new ApiError(404, 'QUOTE_NOT_FOUND', 'Quote was not found');
    await authorizedClient(request, quote.tenantId, 'QUOTES_MANAGE');
    const valid = (quote.status === 'DRAFT' && status === 'SENT') || (['SENT', 'VIEWED'].includes(quote.status) && ['REJECTED', 'CANCELLED'].includes(status));
    if (!valid) throw new ApiError(409, 'QUOTE_TRANSITION_INVALID', `Cannot transition quote from ${quote.status} to ${status}`);
    const updated = await database.quote.update({ where: { id: quoteId }, data: { status, ...(status === 'SENT' ? { sentAt: new Date() } : {}) } });
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'agency.quote_status_changed', resourceType: 'quote', resourceId: quoteId, ipAddress: request.ip, metadata: { from: quote.status, to: status } }); return updated;
  });

  app.put<{ Params: { agencyTenantId: string } }>('/owner/agencies/:agencyTenantId/commerce', async (request) => {
    requireOwnerMfa(request); requirePermission(request, 'commercial.manage'); const agencyTenantId = parse(uuid, request.params.agencyTenantId); const input = parse(z.object({ markupBasisPoints: z.number().int().min(0).max(10_000), maxDiscountBasisPoints: z.number().int().min(0).max(10_000), revenueShareBasisPoints: z.number().int().min(0).max(10_000) }), request.body);
    const exists = await database.userRole.count({ where: { tenantId: agencyTenantId, role: { name: 'Agency' } } }); if (!exists) throw new ApiError(404, 'AGENCY_NOT_FOUND', 'Agency was not found');
    const policy = await database.agencyCommercePolicy.upsert({ where: { agencyTenantId }, create: { agencyTenantId, ...input }, update: input });
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'agency.commerce_policy_updated', resourceType: 'agency_commerce_policy', resourceId: policy.id, ipAddress: request.ip, metadata: input }); return policy;
  });

  app.put<{ Params: { agencyTenantId: string; packageVersionId: string } }>('/owner/agencies/:agencyTenantId/packages/:packageVersionId', async (request) => {
    requireOwnerMfa(request); requirePermission(request, 'commercial.manage'); const agencyTenantId = parse(uuid, request.params.agencyTenantId); const packageVersionId = parse(uuid, request.params.packageVersionId); const { enabled } = parse(z.object({ enabled: z.boolean() }), request.body);
    const [agencyExists, packageExists] = await Promise.all([database.userRole.count({ where: { tenantId: agencyTenantId, role: { name: 'Agency' } } }), database.packageVersion.count({ where: { id: packageVersionId } })]); if (!agencyExists || !packageExists) throw new ApiError(404, 'CONFIGURATION_TARGET_NOT_FOUND', 'Agency or package was not found');
    const entitlement = await database.agencyPackageEntitlement.upsert({ where: { agencyTenantId_packageVersionId: { agencyTenantId, packageVersionId } }, create: { agencyTenantId, packageVersionId, enabled }, update: { enabled } });
    await writeAudit({ tenantId: request.tenantId, actorUserId: request.userId, requestId: request.id, action: 'agency.package_entitlement_updated', resourceType: 'agency_package_entitlement', resourceId: entitlement.id, ipAddress: request.ip, metadata: { agencyTenantId, packageVersionId, enabled } }); return entitlement;
  });
};

export { authorizedClient, defaultGrant };
