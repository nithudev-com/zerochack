import { describe, expect, it } from 'vitest';
import { isPublicAddress, normalizeWebsiteUrl, resolvePublicTarget, TargetSecurityError, validateHostname, validateRedirectDestination } from './network.js';
describe('scanner target security', () => {
  it.each(['127.0.0.1', '10.0.0.1', '172.16.2.3', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '[::1]', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1', '::ffff:7f00:1'])('blocks non-public address %s', (address) => expect(isPublicAddress(address)).toBe(false));
  it.each(['localhost', 'api.internal', 'router.local', 'metadata.google.internal'])('blocks internal hostname %s', (hostname) => expect(() => validateHostname(hostname)).toThrow(TargetSecurityError));
  it('normalizes supported URLs and blocks protocols, credentials, alternate loopback forms, and dangerous ports', () => { expect(normalizeWebsiteUrl(' HTTPS://Example.COM:443/path#fragment ')).toBe('https://example.com/path'); for (const url of ['file:///etc/passwd', 'gopher://example.org', 'http://user:pass@example.com', 'https://example.com:8443']) expect(() => normalizeWebsiteUrl(url)).toThrow(TargetSecurityError); for (const value of ['http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1', 'http://[::ffff:127.0.0.1]']) expect(() => validateHostname(new URL(normalizeWebsiteUrl(value)).hostname)).toThrow(TargetSecurityError); });
  it('rejects mixed public and private DNS answers to resist rebinding', async () => { await expect(resolvePublicTarget(new URL('https://safe.example.org'), async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }])).rejects.toMatchObject({ code: 'DNS_UNSAFE' }); });
  it('blocks redirects to metadata, private DNS, and a different ownership scope', async () => {
    const resolver = async (hostname: string) => [{ address: hostname === 'safe.example.org' ? '93.184.216.34' : '169.254.169.254', family: 4 as const }];
    await expect(validateRedirectDestination('http://169.254.169.254/latest/meta-data', new URL('https://safe.example.org'), resolver)).rejects.toBeInstanceOf(TargetSecurityError);
    await expect(validateRedirectDestination('https://other.example.org', new URL('https://safe.example.org'), resolver)).rejects.toMatchObject({ code: 'REDIRECT_SCOPE_BLOCKED' });
    await expect(validateRedirectDestination('http://safe.example.org', new URL('https://safe.example.org'), resolver)).rejects.toMatchObject({ code: 'REDIRECT_DOWNGRADE_BLOCKED' });
  });
});
