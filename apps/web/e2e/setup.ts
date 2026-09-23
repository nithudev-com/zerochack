import { database } from '@zerochack/database';
import { encryptSecret, hashPassword } from '@zerochack/auth';

export default async function setup() {
  const email = 'customer-e2e@zerochack.test'; const passwordHash = await hashPassword('Customer-E2E-Password9!');
  const previous = await database.user.findUnique({ where: { email } });
  if (previous) await database.user.delete({ where: { id: previous.id } });
  const tenant = await database.tenant.upsert({ where: { slug: 'customer-e2e' }, update: { name: 'Customer E2E' }, create: { name: 'Customer E2E', slug: 'customer-e2e' } });
  await database.restoreOperation.deleteMany({ where: { tenantId: tenant.id } });
  await database.restoreAuthorization.deleteMany({ where: { tenantId: tenant.id } });
  await database.website.deleteMany({ where: { tenantId: tenant.id } });
  const user = await database.user.create({ data: { email, displayName: 'E2E Customer', passwordHash, status: 'APPROVED', emailVerifiedAt: new Date() } });
  const role = await database.role.findFirstOrThrow({ where: { name: 'Customer', tenantId: null } });
  await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: 'ACTIVE' } });
  await database.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
  const agencyEmail = 'agency-e2e@zerochack.test';
  const previousAgency = await database.user.findUnique({ where: { email: agencyEmail } });
  if (previousAgency) await database.user.delete({ where: { id: previousAgency.id } });
  const agencyTenant = await database.tenant.upsert({ where: { slug: 'agency-e2e' }, update: { name: 'Agency E2E' }, create: { name: 'Agency E2E', slug: 'agency-e2e' } });
  const agencyUser = await database.user.create({ data: { email: agencyEmail, displayName: 'E2E Agency', passwordHash, status: 'APPROVED', emailVerifiedAt: new Date() } });
  const agencyRole = await database.role.findFirstOrThrow({ where: { name: 'Agency', tenantId: null } });
  await database.tenantMembership.create({ data: { tenantId: agencyTenant.id, userId: agencyUser.id, status: 'ACTIVE' } });
  await database.userRole.create({ data: { tenantId: agencyTenant.id, userId: agencyUser.id, roleId: agencyRole.id } });
  await database.agencyClientRelationship.upsert({ where: { agencyTenantId_clientTenantId: { agencyTenantId: agencyTenant.id, clientTenantId: tenant.id } }, create: { agencyTenantId: agencyTenant.id, clientTenantId: tenant.id, status: 'ACTIVE', activatedAt: new Date(), permissions: ['CLIENT_READ', 'WEBSITES_READ', 'SECURITY_READ', 'TICKETS_READ', 'SUBSCRIPTIONS_READ', 'BILLING_READ', 'QUOTES_READ'] }, update: { status: 'ACTIVE', revokedAt: null, permissions: ['CLIENT_READ', 'WEBSITES_READ', 'SECURITY_READ', 'TICKETS_READ', 'SUBSCRIPTIONS_READ', 'BILLING_READ', 'QUOTES_READ'] } });
  const affiliateEmail = 'affiliate-e2e@zerochack.test';
  const previousAffiliate = await database.user.findUnique({ where: { email: affiliateEmail } });
  if (previousAffiliate) { await database.affiliateProfile.deleteMany({ where: { userId: previousAffiliate.id } }); await database.user.delete({ where: { id: previousAffiliate.id } }); }
  const affiliateTenant = await database.tenant.upsert({ where: { slug: 'affiliate-e2e' }, update: { name: 'Affiliate E2E' }, create: { name: 'Affiliate E2E', slug: 'affiliate-e2e' } });
  const affiliateUser = await database.user.create({ data: { email: affiliateEmail, displayName: 'E2E Affiliate', passwordHash, status: 'APPROVED', emailVerifiedAt: new Date() } });
  const affiliateRole = await database.role.findFirstOrThrow({ where: { name: 'Affiliate', tenantId: null } });
  await database.tenantMembership.create({ data: { tenantId: affiliateTenant.id, userId: affiliateUser.id, status: 'ACTIVE' } });
  await database.userRole.create({ data: { tenantId: affiliateTenant.id, userId: affiliateUser.id, roleId: affiliateRole.id } });
  await database.affiliateProfile.create({ data: { tenantId: affiliateTenant.id, userId: affiliateUser.id, code: 'ZCE2EAFFILIATE' } });
  const ownerEmail = 'owner-e2e@zerochack.test'; const previousOwner = await database.user.findUnique({ where: { email: ownerEmail } }); if (previousOwner) await database.user.delete({ where: { id: previousOwner.id } });
  const ownerTenant = await database.tenant.upsert({ where: { slug: 'owner-e2e' }, update: { name: 'Owner E2E' }, create: { name: 'Owner E2E', slug: 'owner-e2e' } }); const ownerSecret = Buffer.alloc(20, 7).toString('base64');
  const ownerUser = await database.user.create({ data: { email: ownerEmail, displayName: 'E2E Owner', passwordHash, status: 'APPROVED', emailVerifiedAt: new Date(), mfaSecretEncrypted: encryptSecret(ownerSecret, 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='), mfaEnabledAt: new Date() } }); const ownerRole = await database.role.findFirstOrThrow({ where: { name: 'Owner', tenantId: null } });
  await database.tenantMembership.create({ data: { tenantId: ownerTenant.id, userId: ownerUser.id, status: 'ACTIVE' } }); await database.userRole.create({ data: { tenantId: ownerTenant.id, userId: ownerUser.id, roleId: ownerRole.id } });
  await database.$disconnect();
}
