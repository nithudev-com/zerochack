import { createHmac } from 'node:crypto';
import { request } from 'node:https';
import { resolvePublicTarget, validateHostname } from '@zerochack/scanner';
import { z } from 'zod';

export const providers = ['wordpress', 'woocommerce', 'ghost', 'directus', 'shopify', 'joomla'] as const;
export type Provider = typeof providers[number];
export const connectorInput = z.object({
  provider: z.enum(providers), endpoint: z.string().url().max(2048),
  username: z.string().trim().max(120).default(''), secret: z.string().min(1).max(4096),
  revision: z.number().int().nonnegative(), authorizationConfirmed: z.literal(true)
}).strict();
export type ConnectorInput = z.infer<typeof connectorInput>;
export class ConnectorError extends Error {
  constructor(public readonly code: string) { super(code); }
}
export const connectorDefinitions = [
  { provider: 'wordpress', name: 'WordPress', researchId: 1, usernameLabel: 'WordPress username', secretLabel: 'Application Password', scope: 'Read the authenticated user ID. Use a dedicated least-privilege account and revocable Application Password, not your login password.' },
  { provider: 'woocommerce', name: 'WooCommerce', researchId: 87, usernameLabel: 'Consumer key', secretLabel: 'Consumer secret', scope: 'Read at most one product ID. Create a REST API key with Read permission only; no orders or customer details are requested.' },
  { provider: 'ghost', name: 'Ghost', researchId: 5, usernameLabel: null, secretLabel: 'Admin API key (id:secret)', scope: 'Read at most one post ID using a short-lived signed token. Ghost integration keys can permit writes: CodeBandage uses only GET and does not edit content.' },
  { provider: 'directus', name: 'Directus', researchId: 42, usernameLabel: null, secretLabel: 'Static access token', scope: 'Read the authenticated user ID. Use a dedicated restricted Directus user with access to its own ID.' },
  { provider: 'shopify', name: 'Shopify', researchId: 86, usernameLabel: 'Installed app client ID', secretLabel: 'Installed app client secret', scope: 'For an app and store owned by the same Shopify organization only. Install your app through the Dev Dashboard first. Each check exchanges its client credentials for a temporary token and reads shop ID and domains using GraphQL Admin API 2026-10. No products, orders, customer data or mutations are requested. Third-party merchant OAuth onboarding is not available.' },
  { provider: 'joomla', name: 'Joomla', researchId: 3, usernameLabel: null, secretLabel: 'Joomla API token', scope: 'Enable API Authentication – Web Services Joomla Token, User – Joomla API Token and Web Services – Content. Use a dedicated account with API login and article-read permissions, not Super User. Checks request at most one article; Joomla can return article content, which is discarded and never saved or sent to AI. Requires the Joomla web services API (supported Joomla 5/6 installations).' }
] as const;

// Installation root only. Never accept user-controlled paths to arbitrary API methods.
export function connectorEndpoint(input: string, websiteHost: string, provider?: Provider): string {
  const url = new URL(input);
  const hostAllowed = provider === 'shopify' ? /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/u.test(url.hostname) && url.pathname === '/' : url.hostname === websiteHost;
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || !hostAllowed || !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*\/?$/u.test(url.pathname)) throw new ConnectorError('ENDPOINT_INVALID');
  validateHostname(url.hostname);
  url.pathname = url.pathname.replace(/\/?$/u, '/');
  return url.toString();
}

export function connectionRequest(input: Pick<ConnectorInput, 'provider' | 'endpoint' | 'username' | 'secret'>, now = Math.floor(Date.now() / 1000)) {
  let path: string; let body: string | undefined; const headers: Record<string, string> = {};
  if (/[\r\n\0]/u.test(input.secret + input.username)) throw new ConnectorError('CREDENTIAL_FORMAT');
  switch (input.provider) {
    case 'wordpress':
      if (!input.username || input.username.includes(':') || !/^[a-zA-Z0-9 ]{24,40}$/u.test(input.secret) || input.secret.replaceAll(' ', '').length !== 24) throw new ConnectorError('CREDENTIAL_FORMAT');
      headers.authorization = `Basic ${Buffer.from(`${input.username}:${input.secret}`).toString('base64')}`;
      path = 'wp-json/wp/v2/users/me?context=edit&_fields=id'; break;
    case 'woocommerce':
      if (!/^ck_[a-f0-9]{40}$/u.test(input.username) || !/^cs_[a-f0-9]{40}$/u.test(input.secret)) throw new ConnectorError('CREDENTIAL_FORMAT');
      headers.authorization = `Basic ${Buffer.from(`${input.username}:${input.secret}`).toString('base64')}`;
      path = 'wp-json/wc/v3/products?per_page=1&_fields=id'; break;
    case 'ghost': {
      if (!/^[a-f0-9]{24}:[a-f0-9]{64}$/iu.test(input.secret)) throw new ConnectorError('CREDENTIAL_FORMAT');
      const [id, secret] = input.secret.split(':');
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      const body = `${encode({ alg: 'HS256', typ: 'JWT', kid: id })}.${encode({ iat: now, exp: now + 60, aud: '/admin/' })}`;
      headers.authorization = `Ghost ${body}.${createHmac('sha256', Buffer.from(secret!, 'hex')).update(body).digest('base64url')}`;
      headers['accept-version'] = 'v5.0'; path = 'ghost/api/admin/posts/?limit=1&fields=id'; break;
    }
    case 'directus':
      if (!/^[A-Za-z0-9._~-]{16,4096}$/u.test(input.secret)) throw new ConnectorError('CREDENTIAL_FORMAT');
      headers.authorization = `Bearer ${input.secret}`; path = 'users/me?fields=id'; break;
    case 'joomla':
      if (input.username || !/^[A-Za-z0-9+/=_-]{16,4096}$/u.test(input.secret)) throw new ConnectorError('CREDENTIAL_FORMAT');
      headers['x-joomla-token'] = input.secret; headers.accept = 'application/vnd.api+json';
      path = 'api/index.php/v1/content/articles?page[limit]=1'; break;
    case 'shopify':
      connectorEndpoint(input.endpoint, '', 'shopify');
      if (!/^[A-Za-z0-9_-]{16,120}$/u.test(input.username) || !/^[A-Za-z0-9_-]{16,256}$/u.test(input.secret)) throw new ConnectorError('CREDENTIAL_FORMAT');
      headers['content-type'] = 'application/json';
      path = 'admin/api/2026-10/graphql.json';
      body = JSON.stringify({ query: 'query CodeBandageConnectionCheck { shop { id myshopifyDomain primaryDomain { host } } }' }); break;
  }
  return { url: new URL(path, input.endpoint), headers, body };
}

export type Probe = (url: URL, headers: Record<string, string>, body?: string) => Promise<{ status: number; body: unknown; apiVersion?: string }>;
// Isolated credential transport: no cookies, redirects, proxy env, client-supplied
// headers, content writes, raw response logging, or TLS overrides. DNS is pinned
// per request. POST bodies are fixed OAuth exchanges or read-only GraphQL queries.
export const probeHttps: Probe = async (url, headers, body) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    resolvePublicTarget(url),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ConnectorError('CONNECTION_TIMEOUT')), 5000); })
  ]).finally(() => clearTimeout(timer));
  const selected = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(url, { method: body === undefined ? 'GET' : 'POST', agent: false, headers: { accept: 'application/json', 'user-agent': 'CodeBandage-Connection-Check/1.0', ...headers, ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }) }, lookup: (_host, options, callback) => {
      if (options.all) callback(null, [selected]); else callback(null, selected.address, selected.family);
    } }, res => {
      const status = res.statusCode ?? 0;
      if (status !== 200) { res.destroy(); resolve({ status, body: null }); return; }
      if (!/^application\/(?:[\w.-]+\+)?json(?:;|$)/iu.test(String(res.headers['content-type'] ?? ''))) { res.destroy(); reject(new ConnectorError('RESPONSE_INVALID')); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65536) { res.destroy(); reject(new ConnectorError('RESPONSE_TOO_LARGE')); } else chunks.push(chunk); });
      res.on('error', () => reject(new ConnectorError('CONNECTION_FAILED')));
      res.on('end', () => { try { resolve({ status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown, ...(typeof res.headers['x-shopify-api-version'] === 'string' ? { apiVersion: res.headers['x-shopify-api-version'] } : {}) }); } catch { reject(new ConnectorError('RESPONSE_INVALID')); } });
    });
    const deadline = setTimeout(() => req.destroy(new ConnectorError('CONNECTION_TIMEOUT')), 10000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', error => reject(error instanceof ConnectorError ? error : new ConnectorError('CONNECTION_FAILED')));
    req.end(body);
  });
};

export async function verifyConnector(input: Pick<ConnectorInput, 'provider' | 'endpoint' | 'username' | 'secret'> & { websiteHost?: string }, probe: Probe = probeHttps): Promise<void> {
  const { url, headers, body } = connectionRequest(input);
  if (input.provider === 'shopify' && !input.websiteHost) throw new ConnectorError('WEBSITE_BINDING_REQUIRED');
  // A public resource returning 200 must never be mistaken for authenticated access.
  const anonymousHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => ['accept-version', 'accept', 'content-type'].includes(key)));
  const anonymous = await probe(url, anonymousHeaders, body);
  if (![401, 403].includes(anonymous.status)) throw new ConnectorError('AUTHENTICATION_UNPROVEN');
  if (input.provider === 'shopify') {
    const tokenResponse = await probe(new URL('admin/oauth/access_token', input.endpoint), { 'content-type': 'application/x-www-form-urlencoded' }, new URLSearchParams({ grant_type: 'client_credentials', client_id: input.username, client_secret: input.secret }).toString());
    if ([400, 401, 403].includes(tokenResponse.status)) throw new ConnectorError('AUTH_OR_PERMISSION_DENIED');
    if (tokenResponse.status !== 200) throw new ConnectorError('PROVIDER_UNAVAILABLE');
    const token = z.object({ access_token: z.string().regex(/^[A-Za-z0-9._~-]{16,4096}$/u), expires_in: z.number().int().positive().max(86400) }).safeParse(tokenResponse.body);
    if (!token.success) throw new ConnectorError('RESPONSE_INVALID');
    headers['x-shopify-access-token'] = token.data.access_token;
  }
  const response = await probe(url, headers, body);
  if ([401, 403].includes(response.status)) throw new ConnectorError('AUTH_OR_PERMISSION_DENIED');
  if (response.status !== 200) throw new ConnectorError('PROVIDER_UNAVAILABLE');
  if (input.provider === 'shopify') {
    if (response.apiVersion !== '2026-10') throw new ConnectorError('API_VERSION_MISMATCH');
    const result = z.object({ errors: z.undefined().optional(), data: z.object({ shop: z.object({ id: z.string().regex(/^gid:\/\/shopify\/Shop\/\d+$/u), myshopifyDomain: z.string(), primaryDomain: z.object({ host: z.string() }) }) }) }).safeParse(response.body);
    if (!result.success) throw new ConnectorError('RESPONSE_INVALID');
    const shop = result.data.data.shop;
    if (shop.myshopifyDomain !== url.hostname || ![shop.myshopifyDomain, shop.primaryDomain.host].includes(input.websiteHost!)) throw new ConnectorError('WEBSITE_MISMATCH');
    return;
  }
  const id = z.union([z.number().int().positive(), z.string().min(1).max(128)]);
  const item = z.object({ id });
  const schema = input.provider === 'joomla' ? z.object({ errors: z.undefined().optional(), data: z.array(z.object({ type: z.literal('articles'), id })).max(1) }) : input.provider === 'wordpress' ? item : input.provider === 'directus' ? z.object({ data: item }) : input.provider === 'ghost' ? z.object({ posts: z.array(item).max(1) }) : z.array(item).max(1);
  if (!schema.safeParse(response.body).success) throw new ConnectorError('RESPONSE_INVALID');
}
