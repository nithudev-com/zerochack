import { describe, expect, it } from 'vitest';
import { connectionSummary } from './connection-summary.js';

const now = new Date('2026-10-10T12:00:00Z'); const checked = new Date('2026-10-10T11:00:00Z');
const access = { status: 'READY_FOR_SECURE_SESSION', lastCheckedAt: checked, lastErrorCode: null, vaultCredentialId: null, vaultCredential: null };
const connector = { provider: 'wordpress', status: 'AUTHENTICATED_READ', lastCheckedAt: checked, lastErrorCode: null, websiteUrl: 'https://example.test/', authorizationExpiresAt: new Date('2026-10-11T12:00:00Z') };
const site = { url: connector.websiteUrl, connectionStatus: 'VERIFIED', accessCredential: null, connectors: [] };
describe('website list connection evidence', () => {
  it('does not equate ownership verification with connection', () => expect(connectionSummary(site, now)).toEqual({ kind: 'NONE', providers: [], lastCheckedAt: null }));
  it('prefers checked SSH over checked API connectors', () => expect(connectionSummary({ ...site, accessCredential: access, connectors: [connector] }, now)).toEqual({ kind: 'SSH', providers: ['ssh'], lastCheckedAt: checked }));
  it('returns only website-bound read checks and latest recorded date', () => expect(connectionSummary({ ...site, connectors: [connector, { ...connector, provider: 'shopify', lastCheckedAt: now }] }, now)).toEqual({ kind: 'CONNECTOR', providers: ['wordpress', 'shopify'], lastCheckedAt: now }));
  for (const status of ['CONFIGURED', 'CHECKING', 'NEEDS_ATTENTION', 'REVOKED', 'AUTHENTICATED_ACCOUNT']) it(`does not call ${status} connected`, () => {
    expect(connectionSummary({ ...site, accessCredential: { ...access, status }, connectors: [{ ...connector, status }] }, now).kind).toBe('NONE');
  });
  it('requires dates and error-free checks', () => {
    for (const changes of [{ lastCheckedAt: null }, { lastErrorCode: 'AUTH_FAILED' }]) expect(connectionSummary({ ...site, accessCredential: { ...access, ...changes }, connectors: [{ ...connector, ...changes }] }, now).kind).toBe('NONE');
  });
  it('rejects expired or changed-site connector authorization', () => {
    for (const changes of [{ authorizationExpiresAt: now }, { websiteUrl: 'https://other.test/' }]) expect(connectionSummary({ ...site, connectors: [{ ...connector, ...changes }] }, now).kind).toBe('NONE');
  });
  it('requires re-verification after website URL changes', () => expect(connectionSummary({ ...site, connectionStatus: 'PENDING', accessCredential: access, connectors: [connector] }, now).kind).toBe('NONE'));
  it('honors vault revocation and expiry without disclosing the vault record', () => {
    for (const vaultCredential of [null, { status: 'REVOKED', authorizationExpiresAt: connector.authorizationExpiresAt }, { status: 'STORED', authorizationExpiresAt: now }]) expect(connectionSummary({ ...site, accessCredential: { ...access, vaultCredentialId: 'synthetic-id', vaultCredential } }, now).kind).toBe('NONE');
    expect(connectionSummary({ ...site, accessCredential: { ...access, vaultCredentialId: 'synthetic-id', vaultCredential: { status: 'STORED', authorizationExpiresAt: connector.authorizationExpiresAt } } }, now)).toEqual({ kind: 'SSH', providers: ['ssh'], lastCheckedAt: checked });
  });
});
