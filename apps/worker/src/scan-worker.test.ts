import { describe, expect, it } from 'vitest';
import { integrityHash, sanitizeEvidence } from './scan-worker.js';
describe('scan evidence safety', () => {
  it('redacts secret-shaped metadata and bounds strings', () => {
    const sanitized = sanitizeEvidence({ authorization: 'Bearer secret', apiKey: 'key', header: 'content-security-policy', detail: 'a'.repeat(3000) });
    expect(sanitized.authorization).toBe('[REDACTED]'); expect(sanitized.apiKey).toBe('[REDACTED]'); expect(String(sanitized.detail)).toHaveLength(2048); expect(sanitized.header).toBe('content-security-policy');
  });
  it('binds integrity metadata deterministically', () => {
    const base = { engine: 'headers', version: '1', observedAt: new Date('2026-01-01T00:00:00Z'), summary: 'missing header', metadata: { status: 200, header: 'csp' } };
    expect(integrityHash(base)).toBe(integrityHash({ ...base, metadata: { header: 'csp', status: 200 } })); expect(integrityHash(base)).not.toBe(integrityHash({ ...base, summary: 'changed' }));
  });
});
