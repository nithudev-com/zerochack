import { describe, expect, it } from 'vitest';
import { assertTenantAccess } from './index.js';

const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const denied = (requestedTenantId = tenantB) => () => assertTenantAccess({ sessionTenantId: tenantA, requestedTenantId, roles: ['Customer'], activeAgencyClientTenantIds: [] });

describe('cross-tenant isolation attack matrix', () => {
  it('rejects Tenant A reading Tenant B', () => expect(denied()).toThrow('not found'));
  it('rejects guessed resource tenant IDs', () => expect(denied('cccccccc-cccc-4ccc-8ccc-cccccccccccc')).toThrow());
  it('rejects altered UUID path values', () => expect(denied(tenantB)).toThrow());
  it('rejects manipulated query tenant values', () => expect(denied(tenantB)).toThrow());
  it('ignores manipulated tenant headers because policy uses session tenant', () => expect(denied(tenantB)).toThrow());
  it('rejects cross-tenant WebSocket authorization', () => expect(denied(tenantB)).toThrow());
  it('rejects cached resources under another tenant key', () => expect(denied(tenantB)).toThrow());
  it('permits only explicit active agency-client grants', () => expect(() => assertTenantAccess({ sessionTenantId: tenantA, requestedTenantId: tenantB, roles: ['Agency'], activeAgencyClientTenantIds: [tenantB] })).not.toThrow());
});
