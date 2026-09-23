import { database } from '@zerochack/database';
import { hashPassword, normalizeEmail, validatePassword } from '@zerochack/auth';

const email = process.env.OWNER_EMAIL; const password = process.env.OWNER_PASSWORD; const displayName = process.env.OWNER_NAME; const tenantName = process.env.OWNER_TENANT_NAME ?? 'ZeroRoot';
if (!email || !password || !displayName) throw new Error('OWNER_EMAIL, OWNER_PASSWORD, and OWNER_NAME are required');
if (!validatePassword(password)) throw new Error('OWNER_PASSWORD must be 12-128 characters and include upper, lower, number, and symbol');

const normalizedEmail = normalizeEmail(email); const passwordHash = await hashPassword(password);
await database.$transaction(async (transaction) => {
  if (await transaction.user.findUnique({ where: { email: normalizedEmail } })) throw new Error('Owner email already exists');
  const role = await transaction.role.findFirst({ where: { name: 'Owner', tenantId: null } }); if (!role) throw new Error('Run database migrations before owner provisioning');
  const tenant = await transaction.tenant.create({ data: { name: tenantName, slug: `zerochack-owner-${crypto.randomUUID().slice(0, 8)}` } });
  const user = await transaction.user.create({ data: { email: normalizedEmail, passwordHash, displayName, status: 'APPROVED', emailVerifiedAt: new Date() } });
  await transaction.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: 'ACTIVE' } });
  await transaction.userRole.create({ data: { tenantId: tenant.id, userId: user.id, roleId: role.id } });
  await transaction.auditLog.create({ data: { tenantId: tenant.id, actorUserId: user.id, requestId: `owner-bootstrap-${crypto.randomUUID()}`, action: 'owner.provisioned', resourceType: 'user', resourceId: user.id } });
});
await database.$disconnect();
