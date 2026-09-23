import { describe, expect, it } from 'vitest';
import { assertTenantContext } from './index.js';

describe('tenant authorization', () => {
  it('rejects cross-tenant access', () => expect(() => assertTenantContext({ requestId: 'r', tenantId: 'a' }, 'b')).toThrow());
});
