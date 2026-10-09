import { describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { connectorEndpoint, connectionRequest, verifyConnector, type ConnectorInput } from './adapters.js';
import research from './research.json';

const credentials: Array<Pick<ConnectorInput, 'provider' | 'endpoint' | 'username' | 'secret'>> = [
  { provider: 'wordpress', endpoint: 'https://cms.customer.com/blog/', username: 'reader', secret: 'abcd efgh ijkl mnop qrst uvwx' },
  { provider: 'woocommerce', endpoint: 'https://cms.customer.com/', username: 'ck_' + 'a'.repeat(40), secret: 'cs_' + 'b'.repeat(40) },
  { provider: 'ghost', endpoint: 'https://cms.customer.com/', username: '', secret: 'a'.repeat(24) + ':' + 'b'.repeat(64) },
  { provider: 'directus', endpoint: 'https://cms.customer.com/', username: '', secret: 'synthetic-restricted-token' }
];
describe('connector target and research boundaries', () => {
  it('preserves installation subdirectory and restricts to the exact verified hostname', () => {
    expect(connectorEndpoint('https://cms.customer.com/blog', 'cms.customer.com')).toBe('https://cms.customer.com/blog/');
    expect(connectionRequest(credentials[0]!).url.pathname).toBe('/blog/wp-json/wp/v2/users/me');
  });
  it.each(['http://cms.customer.com', 'https://cms.customer.com:8443', 'https://reader:secret@cms.customer.com', 'https://cms.customer.com/?token=secret', 'https://cms.customer.com/#secret', 'https://other.customer.com', 'https://cms.customer.com/a%2fb', 'https://cms.customer.com/a.b'])('rejects unsafe or ambiguous installation root %s', input => {
    expect(() => connectorEndpoint(input, 'cms.customer.com')).toThrow();
  });
  it('rejects private hosts', () => { expect(() => connectorEndpoint('https://127.0.0.1/', '127.0.0.1')).toThrow(); });
  it('retains 150 unique research entries without treating them as executable adapters', () => {
    expect(research.platforms).toHaveLength(150); expect(new Set(research.platforms.map(item => item.id)).size).toBe(150);
    expect(research.scope).toContain('No connection');
    for (const platform of research.platforms) for (const source of platform.official_sources) expect(new URL(source).protocol).toBe('https:');
  });
});
describe.each(credentials)('$provider read-only verification', input => {
  const valid = input.provider === 'wordpress' ? { id: 2 } : input.provider === 'directus' ? { data: { id: 'synthetic-id' } } : input.provider === 'ghost' ? { posts: [] } : [];
  it('requires a denied anonymous read before authenticated success', async () => {
    const probe = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ status: 200, body: valid });
    await verifyConnector(input, probe);
    expect(probe).toHaveBeenCalledTimes(2); expect(probe.mock.calls[0]![1]).not.toHaveProperty('authorization'); expect(probe.mock.calls[1]![1]).toHaveProperty('authorization');
    expect(String(probe.mock.calls[1]![0])).not.toContain(input.secret);
  });
  it('does not send credentials when anonymous authentication is unproven', async () => {
    const probe = vi.fn().mockResolvedValue({ status: 200, body: valid });
    await expect(verifyConnector(input, probe)).rejects.toThrow('AUTHENTICATION_UNPROVEN'); expect(probe).toHaveBeenCalledTimes(1);
  });
  it.each([301, 302, 307, 404, 429, 500])('rejects unexpected anonymous status %s without forwarding a credential', async status => {
    const probe = vi.fn().mockResolvedValue({ status }); await expect(verifyConnector(input, probe)).rejects.toThrow(); expect(probe).toHaveBeenCalledTimes(1);
  });
  it('rejects incorrect credentials without returning the provider body', async () => {
    const probe = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ status: 403, body: { secret: input.secret } });
    await expect(verifyConnector(input, probe)).rejects.toThrow('AUTH_OR_PERMISSION_DENIED');
  });
  it('rejects success-shaped HTML or unrelated JSON', async () => {
    const probe = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ status: 200, body: { ok: true } });
    await expect(verifyConnector(input, probe)).rejects.toThrow('RESPONSE_INVALID');
  });
  it('rejects credential header injection', () => { expect(() => connectionRequest({ ...input, secret: input.secret + '\r\nHost: other.com' })).toThrow(); });
});
it('signs Ghost tokens server-side with hex-decoded secret, audience and one-minute expiry', () => {
  const { headers } = connectionRequest(credentials[2]!, 1000); const [header, payload, signature] = headers.authorization!.slice(6).split('.');
  expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT', kid: 'a'.repeat(24) });
  expect(JSON.parse(Buffer.from(payload!, 'base64url').toString())).toEqual({ iat: 1000, exp: 1060, aud: '/admin/' });
  expect(signature).toBe(createHmac('sha256', Buffer.from('b'.repeat(64), 'hex')).update(`${header}.${payload}`).digest('base64url'));
});
