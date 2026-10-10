import { describe, expect, it, vi } from 'vitest';
import { connectorEndpoint, connectorInput, connectionRequest, verifyConnector, type Probe } from './adapters.js';
import { restDefinitions, restProviders } from './rest-platforms.js';

const secret = 'synthetic-test-api-token-00000000';
const cases = [
  { provider: 'payload', endpoint: 'https://cms.customer.com/', username: 'users', secret, path: '/api/users/me', body: { user: { id: 'reader' } }, status: 'AUTHENTICATED_READ', authorization: `users API-Key ${secret}` },
  { provider: 'strapi', endpoint: 'https://cms.customer.com/', username: 'articles', secret, path: '/api/articles', body: { data: [{ id: 1, documentId: 'synthetic-document-id' }] }, status: 'AUTHENTICATED_READ', authorization: `Bearer ${secret}` },
  { provider: 'prestashop', endpoint: 'https://cms.customer.com/', username: '', secret: 'a'.repeat(32), path: '/api/shops/', body: { shops: [{ id: 1 }] }, status: 'AUTHENTICATED_READ', authorization: `Basic ${Buffer.from('a'.repeat(32) + ':').toString('base64')}` },
  { provider: 'cscart', endpoint: 'https://cms.customer.com/', username: 'reader@example.test', secret, path: '/api/products/', body: { products: [{ product_id: '1' }] }, status: 'AUTHENTICATED_READ', authorization: `Basic ${Buffer.from(`reader@example.test:${secret}`).toString('base64')}` },
  { provider: 'medusa', endpoint: 'https://cms.customer.com/', username: '', secret, path: '/admin/products', body: { products: [{ id: 'prod_fixture' }] }, status: 'AUTHENTICATED_READ', authorization: `Basic ${secret}` },
  { provider: 'contentful', endpoint: 'https://api.contentful.com/', username: 'space-fixture', secret, path: '/spaces/space-fixture', body: { sys: { id: 'space-fixture', type: 'Space' } }, status: 'AUTHENTICATED_ACCOUNT', authorization: `Bearer ${secret}` },
  { provider: 'datocms', endpoint: 'https://site-api.datocms.com/', username: '', secret, path: '/site', body: { data: { id: '1', type: 'site', attributes: { name: 'Fixture' } } }, status: 'AUTHENTICATED_ACCOUNT', authorization: `Bearer ${secret}` },
  { provider: 'webflow', endpoint: 'https://api.webflow.com/', username: 'a'.repeat(24), secret, path: '/v2/sites/' + 'a'.repeat(24), body: { id: 'a'.repeat(24), shortName: 'fixture-site', customDomains: [{ url: 'cms.customer.com' }] }, status: 'AUTHENTICATED_READ', authorization: `Bearer ${secret}` }
] as const;
for (const fixture of cases) describe(fixture.provider, () => {
  const input = { ...fixture, websiteHost: 'cms.customer.com' };
  it('uses a fixed reviewed HTTPS GET with no secret URL or body', () => {
    const result = connectionRequest(input);
    expect(result.url.protocol).toBe('https:'); expect(result.url.pathname).toBe(fixture.path);
    expect(result.url.toString()).not.toContain(fixture.secret); expect(result.body).toBeUndefined();
    expect(result.headers.authorization).toBe(fixture.authorization);
    expect(connectorInput.safeParse({ provider: input.provider, endpoint: input.endpoint, username: input.username, secret: input.secret, revision: 0, authorizationConfirmed: true }).success).toBe(true);
    expect(restDefinitions.find(row => row.provider === fixture.provider)).toBeDefined();
    expect(connectorEndpoint(input.endpoint, input.websiteHost, input.provider)).toBe(input.endpoint);
  });
  it('requires denied anonymous access before sending the credential', async () => {
    const probe = vi.fn<Probe>().mockResolvedValueOnce({ status: 401, body: null }).mockResolvedValueOnce({ status: 200, body: fixture.body });
    await expect(verifyConnector(input, probe)).resolves.toBe(fixture.status);
    expect(probe).toHaveBeenCalledTimes(2); expect(probe.mock.calls[0]![1].authorization).toBeUndefined();
    expect(probe.mock.calls[1]![1].authorization).toBe(fixture.authorization);
  });
  it.each([200, 301, 404, 429, 500])('does not send credentials after anonymous status %i', async status => {
    const probe = vi.fn<Probe>().mockResolvedValue({ status, body: fixture.body });
    await expect(verifyConnector(input, probe)).rejects.toThrow('AUTHENTICATION_UNPROVEN'); expect(probe).toHaveBeenCalledTimes(1);
  });
  it.each([401, 403, 429, 500])('does not report authenticated after credential status %i', async status => {
    const probe = vi.fn<Probe>().mockResolvedValueOnce({ status: 401, body: null }).mockResolvedValueOnce({ status, body: fixture.body });
    await expect(verifyConnector(input, probe)).rejects.toThrow([401, 403].includes(status) ? 'AUTH_OR_PERMISSION_DENIED' : 'PROVIDER_UNAVAILABLE');
  });
  it.each([null, {}, { error: 'denied' }, '<html>login</html>'])('rejects malformed successful response %#', async body => {
    const probe = vi.fn<Probe>().mockResolvedValueOnce({ status: 401, body: null }).mockResolvedValueOnce({ status: 200, body });
    await expect(verifyConnector(input, probe)).rejects.toThrow('RESPONSE_INVALID');
  });
  it.each(['\r\nInjected: x', '\0invalid', ''])('rejects malformed credentials %# without a request', async secret => {
    const probe = vi.fn<Probe>(); await expect(verifyConnector({ ...input, secret }, probe)).rejects.toThrow('CREDENTIAL_FORMAT'); expect(probe).not.toHaveBeenCalled();
  });
});
it('has one unique definition for every reviewed REST provider', () => {
  expect(new Set(restDefinitions.map(row => row.researchId)).size).toBe(restProviders.length);
  expect(restDefinitions.map(row => row.provider)).toEqual(restProviders);
});
it('uses sparse DatoCMS fields and pinned version without requesting credential metadata', () => {
  const request = connectionRequest(cases[6]); expect(request.url.searchParams.get('fields[site]')).toBe('name'); expect(request.headers['x-api-version']).toBe('3');
});
it('limits collection queries and retains the PrestaShop JSON format for anonymous checks', async () => {
  expect(connectionRequest(cases[1]).url.searchParams.get('pagination[pageSize]')).toBe('1');
  expect(connectionRequest(cases[2]).url.searchParams.get('display')).toBe('[id]');
  expect(connectionRequest(cases[3]).url.searchParams.get('items_per_page')).toBe('1');
  expect(connectionRequest(cases[4]).url.searchParams.get('fields')).toBe('id');
  const probe = vi.fn<Probe>().mockResolvedValueOnce({ status: 401, body: null }).mockResolvedValueOnce({ status: 200, body: cases[2].body });
  await verifyConnector(cases[2], probe); expect(probe.mock.calls[0]![1]).toEqual({ 'output-format': 'JSON' });
});
it('accepts Payload anonymous null, never an anonymous authenticated user or missing field', async () => {
  const probe = vi.fn<Probe>().mockResolvedValueOnce({ status: 200, body: { user: null } }).mockResolvedValueOnce({ status: 200, body: cases[0].body });
  await expect(verifyConnector(cases[0], probe)).resolves.toBe('AUTHENTICATED_READ');
  for (const body of [{}, { user: cases[0].body.user }]) {
    const denied = vi.fn<Probe>().mockResolvedValue({ status: 200, body });
    await expect(verifyConnector(cases[0], denied)).rejects.toThrow('AUTHENTICATION_UNPROVEN'); expect(denied).toHaveBeenCalledTimes(1);
  }
});
it.each(['payload', 'strapi'] as const)('rejects arbitrary collection paths for %s', provider => {
  for (const username of ['../admin', 'users?fields=secret', 'https://other.com', 'a/b', 'admin', 'upload']) expect(() => connectionRequest({ ...cases[0], provider, username })).toThrow('CREDENTIAL_FORMAT');
});
for (const fixture of cases.filter(row => ['contentful', 'datocms', 'webflow'].includes(row.provider))) it(`${fixture.provider} credentials cannot leave the exact vendor root`, () => {
  for (const endpoint of ['http://api.contentful.com/', 'https://cms.customer.com/', 'https://api.contentful.com.evil.com/', fixture.endpoint + 'other/', fixture.endpoint + '?token=secret', fixture.endpoint + '#a', fixture.endpoint.replace('https://', 'https://user:pass@')]) expect(() => connectorEndpoint(endpoint, 'cms.customer.com', fixture.provider)).toThrow('ENDPOINT_INVALID');
});
it('accepts only the documented EU Contentful alternative', () => {
  expect(connectorEndpoint('https://api.eu.contentful.com/', 'cms.customer.com', 'contentful')).toBe('https://api.eu.contentful.com/');
});
it('fails on a different Contentful space ID even with a successful HTTP status', async () => {
  const probe = vi.fn<Probe>().mockResolvedValueOnce({ status: 401, body: null }).mockResolvedValueOnce({ status: 200, body: { sys: { id: 'other-space', type: 'Space' } } });
  await expect(verifyConnector(cases[5], probe)).rejects.toThrow('RESPONSE_INVALID');
});
it.each(['different.com', 'cms.customer.com.evil.com', 'https://cms.customer.com'])('Webflow does not accept an unrelated returned domain %s', async url => {
  const probe = vi.fn<Probe>().mockResolvedValueOnce({ status: 401, body: null }).mockResolvedValueOnce({ status: 200, body: { ...cases[7].body, customDomains: [{ url }] } });
  await expect(verifyConnector({ ...cases[7], websiteHost: 'cms.customer.com' }, probe)).rejects.toThrow('WEBSITE_MISMATCH');
});
it('Webflow supports its exact canonical domain but requires a server-derived website host', async () => {
  const probe: Probe = async (_url, headers) => headers.authorization ? { status: 200, body: cases[7].body } : { status: 401, body: null };
  await expect(verifyConnector({ ...cases[7], websiteHost: 'fixture-site.webflow.io' }, probe)).resolves.toBe('AUTHENTICATED_READ');
  await expect(verifyConnector(cases[7], probe)).rejects.toThrow('WEBSITE_BINDING_REQUIRED');
});
it.each(cases.filter(row => ['contentful', 'datocms', 'webflow'].includes(row.provider)))('blocks $provider credential transport to a caller-selected host', async input => {
  const probe = vi.fn<Probe>();
  await expect(verifyConnector({ ...input, endpoint: 'https://other.customer.com/' }, probe)).rejects.toThrow('ENDPOINT_INVALID'); expect(probe).not.toHaveBeenCalled();
});
it.each(cases.filter(row => ['strapi', 'prestashop', 'cscart', 'medusa'].includes(row.provider)))('rejects $provider responses that ignore the one-item limit', async input => {
  const key = input.provider === 'strapi' ? 'data' : input.provider === 'prestashop' ? 'shops' : 'products';
  const properties: Record<string, unknown> = input.body;
  const values = properties[key];
  if (!Array.isArray(values)) throw new Error('Expected a list fixture');
  const probe = vi.fn<Probe>().mockResolvedValueOnce({ status: 401, body: null }).mockResolvedValueOnce({ status: 200, body: { [key]: [...values, ...values] } });
  await expect(verifyConnector(input, probe)).rejects.toThrow('RESPONSE_INVALID');
});
