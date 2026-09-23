import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret, generateOpaqueToken, generateTotpSecret, hashOpaqueToken, totp, validatePassword, verifyTotp } from './index.js';

describe('authentication cryptography', () => {
  it('enforces password complexity', () => { expect(validatePassword('Correct-Horse9!')).toBe(true); expect(validatePassword('weakpassword')).toBe(false); });
  it('hashes opaque tokens without storing them', () => { const token = generateOpaqueToken(); expect(hashOpaqueToken(token, 'pepper')).toHaveLength(64); expect(hashOpaqueToken(token, 'pepper')).not.toContain(token); });
  it('encrypts MFA secrets', () => { const key = Buffer.alloc(32, 7).toString('base64'); expect(decryptSecret(encryptSecret('SECRET', key), key)).toBe('SECRET'); });
  it('verifies TOTP only in the allowed window', () => { const secret = generateTotpSecret(); const now = 1_700_000_000_000; expect(verifyTotp(secret, totp(secret, now), now)).toBe(true); expect(verifyTotp(secret, '000000', now + 300_000)).toBe(false); });
});
