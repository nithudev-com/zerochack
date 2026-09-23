import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { agentCatalogue, toolCatalogue, parseSecureCapture, sealSecret, openSecret, assertDisclosure, assertReleaseBinding, visibleAgentState, looksSensitive } from './index.js';
describe('secure conversational intake', () => {
  it('parses labelled mixed account blocks without AI', () => {
    const records = parseSecureCapture('Type: SSH\nHost: host.example.test\nUsername: deployment\nPassword: synthetic-value\n---\nType: CMS\nHost: cms.example.test\nUsername: editor\nPassword: synthetic-cms-value');
    expect(records).toHaveLength(2); expect(records[0]).toMatchObject({ kind: 'SSH', port: 22, authMethod: 'PASSWORD' });
  });
  it('rejects ambiguous lines, duplicate fields, malformed keys and unknown destinations without echoing input', () => {
    for (const input of ['super-sensitive-unknown-input', 'Host: host.example.test\nUsername: a\nPassword: secret\nPassword: other', 'Host: https://host.example.test/path\nUsername: a\nPassword: secret', 'Host: host.example.test\nUsername: a\nprivate key:\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----']) {
      try { parseSecureCapture(input); throw new Error('accepted'); } catch (error) { expect(error).toMatchObject({ code: 'SECRET_CAPTURE_AMBIGUOUS' }); expect((error as Error).message).not.toContain(input); }
    }
  });
  it('enforces batch limits and screens credential URLs outside capture mode', () => {
    expect(() => parseSecureCapture(JSON.stringify(Array.from({ length: 11 }, () => ({ host: 'host.example.test', username: 'a', secret: 'value' }))))).toThrow();
    expect(looksSensitive('postgres://user:password@host.example.test/db')).toBe(true);
  });
});
describe('context-bound vault and human grants', () => {
  const scope = { tenantId: 'tenant-a', websiteId: 'site-a', environment: 'PRODUCTION', id: 'credential-a', version: 1 };
  it('uses fresh nonces and rejects wrong tenant, website, environment, id, version and key', () => {
    const key = randomBytes(32).toString('base64'); const encrypted = sealSecret('synthetic-value', scope, key);
    expect(encrypted).not.toContain('synthetic-value'); expect(sealSecret('synthetic-value', scope, key)).not.toBe(encrypted);
    expect(openSecret(encrypted, scope, { v1: key })).toBe('synthetic-value');
    for (const changed of [{ tenantId: 'tenant-b' }, { websiteId: 'site-b' }, { environment: 'STAGING' }, { id: 'credential-b' }, { version: 2 }]) expect(() => openSecret(encrypted, { ...scope, ...changed }, { v1: key })).toThrow();
    expect(() => openSecret(encrypted, scope, { v1: randomBytes(32).toString('base64') })).toThrow();
  });
  it('requires the named assignment, exact version, fresh MFA, active credential and unexpired approval', () => {
    const now = new Date('2026-09-23T12:00:00Z');
    const good = { specialistId: 's', actorId: 's', assignedSpecialistId: 's', assignmentActive: true, status: 'APPROVED', expiresAt: new Date(now.getTime() + 60000), mfaVerifiedAt: now, credentialVersion: 1, approvedVersion: 1, credentialActive: true };
    expect(() => assertDisclosure(good, now)).not.toThrow();
    for (const denied of [{ actorId: 'owner' }, { assignedSpecialistId: null }, { assignmentActive: false }, { status: 'REVOKED' }, { status: 'PENDING' }, { credentialVersion: 2 }, { credentialActive: false }, { mfaVerifiedAt: new Date(now.getTime() - 301000) }, { expiresAt: now }]) expect(() => assertDisclosure({ ...good, ...denied }, now)).toThrow();
  });
});
describe('truthful activity and release policy', () => {
  it('turns an expired heartbeat stale without manufacturing completion', () => {
    expect(visibleAgentState('RUNNING', new Date(0), new Date(100000))).toBe('STALE');
    expect(visibleAgentState('COMPLETED', new Date(0), new Date(100000))).toBe('COMPLETED');
  });
  it('binds release approval to candidate, revision, environment, plan and expiry', () => {
    const binding = { digest: 'a'.repeat(64), sourceRevision: 'revision', environment: 'PRODUCTION', planVersion: 1 }; const now = new Date(); const expiry = new Date(now.getTime() + 60000);
    expect(() => assertReleaseBinding(binding, binding, expiry, now)).not.toThrow();
    for (const change of [{ digest: 'b'.repeat(64) }, { sourceRevision: 'new' }, { environment: 'STAGING' }, { planVersion: 2 }]) expect(() => assertReleaseBinding(binding, { ...binding, ...change }, expiry, now)).toThrow();
  });
  it('screens long plain text without unbounded URI-scheme backtracking', () => {
    expect(looksSensitive('a'.repeat(200000))).toBe(false);
    expect(looksSensitive('postgresql://user:synthetic-password@example.test/db')).toBe(true);
  });
  it('retains all planned roles and tool interfaces with explicit implemented modes', () => {
    expect(agentCatalogue).toHaveLength(24); expect(toolCatalogue).toHaveLength(67);
    expect(new Set(toolCatalogue.map((tool) => tool.id)).size).toBe(67);
    expect(agentCatalogue.filter((role) => role.enabled && role.sourceReview)).toHaveLength(24);
    expect(agentCatalogue.filter((role) => role.implementation !== 'SOURCE_REVIEW').map((role) => role.id)).toEqual(['A02','A08']);
    expect(toolCatalogue.filter((tool) => tool.enabled).map((tool) => tool.id)).toEqual(['T01','T02','T04','T09','T10','T11','T19','T21','T31','T32','T53','T59','T65','T66','T67']);
  });
});
