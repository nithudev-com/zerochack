import { z } from 'zod';
import { ConnectorError } from './errors.js';

// Reviewed operations, not a user-programmable HTTP client. No arbitrary paths,
// headers, methods, queries or credential-bearing URLs are accepted.
export const restProviders = ['payload', 'strapi', 'prestashop', 'cscart', 'medusa', 'contentful', 'datocms', 'webflow'] as const;
export type RestProvider = typeof restProviders[number];
export const isRestProvider = (provider: string): provider is RestProvider => (restProviders as readonly string[]).includes(provider);
export const restDefinitions = [
  { provider: 'payload', name: 'Payload', researchId: 43, usernameLabel: 'API-key enabled auth collection slug', secretLabel: 'User API key', scope: 'Payload REST API at its default /api prefix. Enable useAPIKey on a dedicated auth collection. Reads the authenticated user; Payload may also return email and a token, which are discarded. Restrict this user using collection access controls. No browser login or content writes.' },
  { provider: 'strapi', name: 'Strapi', researchId: 41, usernameLabel: 'Protected collection plural API ID', secretLabel: 'Read-only API token', scope: 'Strapi 5 default /api prefix. Use a read-only token and an existing protected collection (for example articles); anonymous find access must be disabled for this collection. Reads at most one document without populated relations. Returned document content is discarded. Public collections cannot prove token authentication.' },
  { provider: 'prestashop', name: 'PrestaShop', researchId: 90, usernameLabel: null, secretLabel: 'Webservice key', scope: 'Enable the legacy Webservice and create a dedicated key with GET permission on shops only. Reads at most one shop ID in JSON format. Requires HTTPS and the standard /api path; this is not PrestaShop 9 Admin API OAuth.' },
  { provider: 'cscart', name: 'CS-Cart', researchId: 95, usernameLabel: 'API-enabled administrator email', secretLabel: 'Administrator API key', scope: 'Enable API access for a dedicated restricted administrator. Uses CS-Cart API 1.0 at /api and reads at most one product. Returned product metadata is discarded. The upstream key may allow writes: restrict user-group permissions; CodeBandage does not write.' },
  { provider: 'medusa', name: 'Medusa', researchId: 103, usernameLabel: null, secretLabel: 'Secret Admin API key', scope: 'Medusa v2 Admin API. Reads at most one product ID. Use a dedicated Secret API key, not a Store publishable key. The upstream key acts as an admin user and may permit writes; CodeBandage only performs this read.' },
  { provider: 'contentful', name: 'Contentful', researchId: 44, usernameLabel: 'Space ID', secretLabel: 'Content Management API token', endpointKind: 'service', defaultEndpoint: 'https://api.contentful.com/', scope: 'Reads the selected space metadata using CMA v1. US and EU API roots are supported. Limit the token to the intended space and minimum role. This checks space access, NOT which frontend website uses it; site binding and editing remain unavailable.' },
  { provider: 'datocms', name: 'DatoCMS', researchId: 50, usernameLabel: null, secretLabel: 'Content Management API token', endpointKind: 'service', defaultEndpoint: 'https://site-api.datocms.com/', scope: 'Reads only site name/ID using CMA v3 sparse fields. Use a custom read-only role without token-management permissions. This checks the token’s CMS project, NOT its frontend website; site binding and editing remain unavailable.' },
  { provider: 'webflow', name: 'Webflow', researchId: 128, usernameLabel: 'Site ID', secretLabel: 'Site token (sites:read)', endpointKind: 'service', defaultEndpoint: 'https://api.webflow.com/', scope: 'Webflow Data API v2. Create a site-scoped token with sites:read only. Reads site metadata and requires the returned Site ID and a custom domain (or shortName.webflow.io) to match your verified website. No CMS writes, publishing or designer access.' }
] as const;
export const serviceHosts: Partial<Record<RestProvider, readonly string[]>> = {
  contentful: ['api.contentful.com', 'api.eu.contentful.com'],
  datocms: ['site-api.datocms.com'], webflow: ['api.webflow.com']
};
type Credential = { provider: RestProvider; endpoint: string; username: string; secret: string };
const id = z.union([z.number().int().positive(), z.string().min(1).max(128)]);
const item = z.object({ id });
export function restRequest(input: Credential) {
  const { provider, username, secret } = input;
  if (!/^[A-Za-z0-9._~+/=-]{16,4096}$/u.test(secret)) throw new ConnectorError('CREDENTIAL_FORMAT');
  const headers: Record<string, string> = {};
  let path: string;
  switch (provider) {
    case 'payload':
    case 'strapi':
      if (!/^[a-z][a-z0-9-]{0,63}$/u.test(username) || ['auth', 'admin', 'upload', 'connect'].includes(username)) throw new ConnectorError('CREDENTIAL_FORMAT');
      headers.authorization = provider === 'payload' ? `${username} API-Key ${secret}` : `Bearer ${secret}`;
      path = provider === 'payload' ? `api/${username}/me` : `api/${username}?pagination[page]=1&pagination[pageSize]=1`; break;
    case 'prestashop':
      if (username || !/^[A-Za-z0-9]{32}$/u.test(secret)) throw new ConnectorError('CREDENTIAL_FORMAT');
      headers.authorization = `Basic ${Buffer.from(`${secret}:`).toString('base64')}`;
      headers['output-format'] = 'JSON'; path = 'api/shops/?display=[id]&limit=0,1'; break;
    case 'cscart':
      if (!z.string().email().max(120).safeParse(username).success || username.includes(':')) throw new ConnectorError('CREDENTIAL_FORMAT');
      headers.authorization = `Basic ${Buffer.from(`${username}:${secret}`).toString('base64')}`;
      path = 'api/products/?items_per_page=1'; break;
    case 'medusa':
      if (username) throw new ConnectorError('CREDENTIAL_FORMAT');
      // Medusa v2 documents a raw secret key after Basic, NOT a base64 user:pass.
      headers.authorization = `Basic ${secret}`; path = 'admin/products?limit=1&fields=id'; break;
    case 'contentful':
      if (!/^[A-Za-z0-9_-]{1,64}$/u.test(username)) throw new ConnectorError('CREDENTIAL_FORMAT');
      headers.authorization = `Bearer ${secret}`; headers['content-type'] = 'application/vnd.contentful.management.v1+json';
      path = `spaces/${username}`; break;
    case 'datocms':
      if (username) throw new ConnectorError('CREDENTIAL_FORMAT');
      headers.authorization = `Bearer ${secret}`; headers['x-api-version'] = '3'; path = 'site?fields[site]=name'; break;
    case 'webflow':
      if (!/^[a-f0-9]{24}$/u.test(username)) throw new ConnectorError('CREDENTIAL_FORMAT');
      headers.authorization = `Bearer ${secret}`; path = `v2/sites/${username}`; break;
  }
  return { url: new URL(path, input.endpoint), headers, body: undefined };
}
// Payload /me deliberately returns 200 with a null user when anonymous. Accept
// only that exact absence, never a public authenticated-looking result.
export function restAnonymousDenied(provider: RestProvider, response: { status: number; body: unknown }) {
  return [401, 403].includes(response.status) || (provider === 'payload' && response.status === 200 && z.object({ user: z.null() }).safeParse(response.body).success);
}
export function restResult(input: Credential & { websiteHost?: string }, body: unknown): 'AUTHENTICATED_READ' | 'AUTHENTICATED_ACCOUNT' {
  const { provider } = input;
  const schema = provider === 'payload' ? z.object({ user: item }) :
    provider === 'strapi' ? z.object({ error: z.undefined().optional(), data: z.array(item.extend({ documentId: z.string().min(1).max(128) })).max(1) }) :
    provider === 'prestashop' ? z.object({ shops: z.array(item).max(1) }) :
    provider === 'cscart' ? z.object({ products: z.array(z.object({ product_id: id })).max(1) }) :
    provider === 'medusa' ? z.object({ products: z.array(item).max(1) }) :
    provider === 'contentful' ? z.object({ sys: z.object({ id: z.literal(input.username), type: z.literal('Space') }) }) :
    provider === 'datocms' ? z.object({ data: z.object({ id, type: z.literal('site'), attributes: z.object({ name: z.string().max(1000) }) }) }) :
    z.object({ id: z.literal(input.username), shortName: z.string().regex(/^[a-z0-9-]{1,100}$/u), customDomains: z.array(z.object({ url: z.string().max(253) })).max(100).optional() });
  if (!schema.safeParse(body).success) throw new ConnectorError('RESPONSE_INVALID');
  if (provider === 'webflow') {
    if (!input.websiteHost) throw new ConnectorError('WEBSITE_BINDING_REQUIRED');
    const site = body as { shortName: string; customDomains?: { url: string }[] };
    if (![`${site.shortName}.webflow.io`, ...site.customDomains?.map(domain => domain.url) ?? []].includes(input.websiteHost)) throw new ConnectorError('WEBSITE_MISMATCH');
  }
  return provider === 'contentful' || provider === 'datocms' ? 'AUTHENTICATED_ACCOUNT' : 'AUTHENTICATED_READ';
}
