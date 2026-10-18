import { describe, expect, it, vi } from 'vitest';
import { connectorEndpoint, connectionRequest, verifyConnector } from './adapters.js';

const input = { provider: 'shopify' as const, endpoint: 'https://synthetic-shop.myshopify.com/', username: 'synthetic-client-id', secret: 'synthetic-client-secret', websiteHost: 'cms.customer.com' };
const shop = { id: 'gid://shopify/Shop/123', myshopifyDomain: 'synthetic-shop.myshopify.com', primaryDomain: { host: 'cms.customer.com' } };
const response = { status: 200, apiVersion: '2026-10', body: { data: { shop } } };
const token = { status: 200, body: { access_token: 'synthetic-access-token', expires_in: 86399 } };
const probeFor = (result: unknown = response) => vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce(token).mockResolvedValueOnce(result);

describe('Shopify own-organization app connection', () => {
  it('allows only the canonical Shopify host, deferring verified storefront binding to the authenticated response', () => {
    expect(connectorEndpoint(input.endpoint, input.websiteHost, 'shopify')).toBe(input.endpoint);
    expect(() => connectorEndpoint(input.endpoint, input.websiteHost, 'wordpress')).toThrow();
  });
  it.each(['https://cms.customer.com/', 'https://myshopify.com/', 'https://shop.myshopify.com.evil.com/', 'https://a.b.myshopify.com/', 'https://shop.myshopify.com/admin', 'https://shop.myshopify.com/?secret=x', 'http://shop.myshopify.com/', 'https://shop.myshopify.com:8443/', 'https://user:pass@shop.myshopify.com/'])('rejects unapproved endpoint %s', endpoint => {
    expect(() => connectorEndpoint(endpoint, input.websiteHost, 'shopify')).toThrow('ENDPOINT_INVALID');
    expect(() => connectionRequest({ ...input, endpoint })).toThrow();
  });
  it('performs a bounded credential exchange and fixed GraphQL read without leaking the client secret into query URLs', async () => {
    const probe = probeFor(); await verifyConnector(input, probe); expect(probe).toHaveBeenCalledTimes(3);
    const [anonymous, exchange, authenticated] = probe.mock.calls;
    expect(anonymous![1]).not.toHaveProperty('x-shopify-access-token');
    expect(String(exchange![0])).toBe(input.endpoint + 'admin/oauth/access_token');
    expect(exchange![1]).toEqual({ 'content-type': 'application/x-www-form-urlencoded' });
    expect(Object.fromEntries(new URLSearchParams(exchange![2]))).toEqual({ grant_type: 'client_credentials', client_id: input.username, client_secret: input.secret });
    expect(authenticated![1]['x-shopify-access-token']).toBe('synthetic-access-token');
    expect(String(authenticated![0])).toBe(input.endpoint + 'admin/api/2026-10/graphql.json');
    expect(JSON.parse(authenticated![2]).query).toBe('query CodeBandageConnectionCheck { shop { id myshopifyDomain primaryDomain { host } } }');
    expect(authenticated![2]).toBe(anonymous![2]);
    for (const call of probe.mock.calls) expect(String(call[0])).not.toContain(input.secret);
  });
  it('also accepts a verified canonical storefront', async () => { await verifyConnector({ ...input, websiteHost: shop.myshopifyDomain }, probeFor()); });
  it('exchanges a fresh temporary token on each explicit check', async () => {
    for (let i = 0; i < 2; i++) { const probe = probeFor(); await verifyConnector(input, probe); expect(probe.mock.calls[1]![0].pathname).toBe('/admin/oauth/access_token'); }
  });
  it('requires a server-derived website binding before sending any request', async () => {
    const { provider, endpoint, username, secret } = input;
    const probe = probeFor(); await expect(verifyConnector({ provider, endpoint, username, secret }, probe)).rejects.toThrow('WEBSITE_BINDING_REQUIRED'); expect(probe).not.toHaveBeenCalled();
  });
  it.each([200, 301, 302, 404, 429, 500])('sends no client credentials after anonymous status %s', async status => {
    const probe = vi.fn().mockResolvedValue({ status }); await expect(verifyConnector(input, probe)).rejects.toThrow('AUTHENTICATION_UNPROVEN'); expect(probe).toHaveBeenCalledTimes(1);
  });
  it.each([400, 401, 403, 429, 500, 302])('rejects token exchange status %s without a GraphQL token request', async status => {
    const probe = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ status, body: { client_secret: input.secret } });
    await expect(verifyConnector(input, probe)).rejects.toThrow(status === 400 || status === 401 || status === 403 ? 'AUTH_OR_PERMISSION_DENIED' : 'PROVIDER_UNAVAILABLE'); expect(probe).toHaveBeenCalledTimes(2);
  });
  it.each([{ access_token: 'bad\r\nheader', expires_in: 86399 }, { access_token: 'synthetic-access-token', expires_in: 0 }, { access_token: 'synthetic-access-token' }])('rejects malformed or expired tokens', async body => {
    const probe = vi.fn().mockResolvedValueOnce({ status: 401 }).mockResolvedValueOnce({ status: 200, body });
    await expect(verifyConnector(input, probe)).rejects.toThrow('RESPONSE_INVALID'); expect(probe).toHaveBeenCalledTimes(2);
  });
  it.each(['2026-07', undefined])('rejects an unexpected or missing actual API version %s', async apiVersion => { await expect(verifyConnector(input, probeFor({ ...response, apiVersion }))).rejects.toThrow('API_VERSION_MISMATCH'); });
  it.each([{ errors: [{ message: 'Access denied' }], data: { shop } }, { data: { shop: null } }, { data: { shop: { ...shop, id: 'not-a-shop-id' } } }])('rejects GraphQL errors or malformed success responses', async body => { await expect(verifyConnector(input, probeFor({ ...response, body }))).rejects.toThrow('RESPONSE_INVALID'); });
  it.each([{ ...shop, myshopifyDomain: 'another-shop.myshopify.com' }, { ...shop, primaryDomain: { host: 'unrelated.customer.com' } }])('rejects credentials for a different verified website', async mismatchedShop => {
    await expect(verifyConnector(input, probeFor({ ...response, body: { data: { shop: mismatchedShop } } }))).rejects.toThrow('WEBSITE_MISMATCH');
  });
  it.each([401, 403, 302, 429])('rejects authenticated status %s', async status => { await expect(verifyConnector(input, probeFor({ ...response, status }))).rejects.toThrow(); });
});
