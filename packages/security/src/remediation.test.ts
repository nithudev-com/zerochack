import { describe, expect, it } from 'vitest';
import { assertRemediationGate } from './remediation.js';
const now = new Date('2026-09-03T12:00:00Z');
const gate = { tenantId: 't', websiteId: 'w', ticketId: 'k', specialistId: 's', authorization: { tenantId: 't', websiteId: 'w', ticketId: 'k', scope: ['headers.write'], expiresAt: new Date('2026-09-04T12:00:00Z'), revokedAt: null }, backup: { tenantId: 't', websiteId: 'w', ticketId: 'k', status: 'SUCCEEDED', verifiedAt: now }, session: { tenantId: 't', websiteId: 'w', ticketId: 'k', specialistId: 's', scope: ['headers.write'], expiresAt: new Date('2026-09-03T13:00:00Z'), revokedAt: null, status: 'ACTIVE' }, requiredScopes: ['headers.write'] };
describe('remediation gate', () => {
  it('accepts fully bound authorized work with verified backup', () => expect(() => assertRemediationGate(gate, now)).not.toThrow());
  it.each([
    ['expired authorization', { authorization: { ...gate.authorization, expiresAt: now } }, 'AUTHORIZATION_EXPIRED'],
    ['wrong website', { backup: { ...gate.backup, websiteId: 'other' } }, 'REMEDIATION_BINDING_MISMATCH'],
    ['wrong ticket', { authorization: { ...gate.authorization, ticketId: 'other' } }, 'REMEDIATION_BINDING_MISMATCH'],
    ['backup failure', { backup: { ...gate.backup, status: 'FAILED', verifiedAt: null } }, 'BACKUP_NOT_VERIFIED'],
    ['session expiry', { session: { ...gate.session!, expiresAt: now } }, 'REMEDIATION_SESSION_INVALID'],
    ['session revocation', { session: { ...gate.session!, revokedAt: now, status: 'REVOKED' } }, 'REMEDIATION_SESSION_INVALID']
  ])('rejects %s', (_label, change, code) => expect(() => assertRemediationGate({ ...gate, ...change }, now)).toThrow(expect.objectContaining({ code })));
});
