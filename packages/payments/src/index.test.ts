import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { isWebhookFresh, PaymentProviderError, PaymentProviderRegistry, verifyHmacSha256 } from './index.js';

describe('payment security primitives', () => {
  it('verifies exact payload signatures and rejects changes', () => { const payload = '{"event":"paid"}'; const signature = createHmac('sha256', 'secret').update(payload).digest('hex'); expect(verifyHmacSha256(payload, signature, 'secret')).toBe(true); expect(verifyHmacSha256(`${payload} `, signature, 'secret')).toBe(false); });
  it('enforces webhook replay tolerance', () => { const now = new Date('2026-09-03T12:00:00Z'); expect(isWebhookFresh(new Date('2026-09-03T11:56:00Z'), now)).toBe(true); expect(isWebhookFresh(new Date('2026-09-03T11:54:00Z'), now)).toBe(false); });
  it('fails explicitly when an adapter is not installed', () => { expect(() => new PaymentProviderRegistry().get('missing')).toThrowError(PaymentProviderError); });
});
