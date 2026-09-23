import type { RequestContext } from '@zerochack/types';

export const secureCookie = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict' as const,
  path: '/'
};

export class AuthorizationError extends Error {
  readonly code = 'FORBIDDEN';
  constructor(message = 'Insufficient permissions') { super(message); this.name = 'AuthorizationError'; }
}

export function assertTenantContext(context: RequestContext, expectedTenantId: string): void {
  if (!context.tenantId || context.tenantId !== expectedTenantId) throw new AuthorizationError();
}

export interface TenantAccessPolicy {
  sessionTenantId: string;
  requestedTenantId: string;
  roles: readonly string[];
  activeAgencyClientTenantIds: readonly string[];
}

export function assertTenantAccess(policy: TenantAccessPolicy): void {
  if (policy.sessionTenantId === policy.requestedTenantId) return;
  if (policy.roles.includes('Agency') && policy.activeAgencyClientTenantIds.includes(policy.requestedTenantId)) return;
  throw new AuthorizationError('Tenant resource was not found');
}

export * from './remediation.js';
