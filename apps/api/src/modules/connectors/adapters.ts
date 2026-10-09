import { createHmac } from 'node:crypto';
import { request } from 'node:https';
import { resolvePublicTarget, validateHostname } from '@zerochack/scanner';
import { z } from 'zod';

export const providers = ['wordpress', 'woocommerce', 'ghost', 'directus'] as const;
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
  { provider: 'directus', name: 'Directus', researchId: 42, usernameLabel: null, secretLabel: 'Static access token', scope: 'Read the authenticated user ID. Use a dedicated restricted Directus user with access to its own ID.' }
] as const;

// Installation root only. Never accept user-controlled paths to arbitrary API methods.
export function connectorEndpoint(input: string, websiteHost: string): string {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.search || url.hash || url.hostname !== websiteHost || !/^\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]*\/?$/u.test(url.pathname)) throw new ConnectorError('ENDPOINT_INVALID');
  validateHostname(url.hostname);
  url.pathname = url.pathname.replace(/\/?$/u, '/');
  return url.toString();
}

export function connectionRequest(input: Pick<ConnectorInput, 'provider' | 'endpoint' | 'username' | 'secret'>, now = Math.floor(Date.now() / 1000)) {
  let path: string; const headers: Record<string, string> = {};
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
  }
  return { url: new URL(path, input.endpoint), headers };
}

export type Probe = (url: URL, headers: Record<string, string>) => Promise<{ status: number; body: unknown }>;
// Isolated credential transport: no cookies, redirects, proxy env, client-supplied
// headers, writes, raw response logging, or TLS overrides. DNS is pinned per GET.
export const probeHttps: Probe = async (url, headers) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const addresses = await Promise.race([
    resolvePublicTarget(url),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ConnectorError('CONNECTION_TIMEOUT')), 5000); })
  ]).finally(() => clearTimeout(timer));
  const selected = addresses[0]!;
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET', agent: false, headers: { accept: 'application/json', 'user-agent': 'CodeBandage-Connection-Check/1.0', ...headers }, lookup: (_host, options, callback) => {
      if (options.all) callback(null, [selected]); else callback(null, selected.address, selected.family);
    } }, res => {
      const status = res.statusCode ?? 0;
      if (status !== 200) { res.destroy(); resolve({ status, body: null }); return; }
      if (!/^application\/(?:[\w.-]+\+)?json(?:;|$)/iu.test(String(res.headers['content-type'] ?? ''))) { res.destroy(); reject(new ConnectorError('RESPONSE_INVALID')); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 65536) { res.destroy(); reject(new ConnectorError('RESPONSE_TOO_LARGE')); } else chunks.push(chunk); });
      res.on('error', () => reject(new ConnectorError('CONNECTION_FAILED')));
      res.on('end', () => { try { resolve({ status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }); } catch { reject(new ConnectorError('RESPONSE_INVALID')); } });
    });
    const deadline = setTimeout(() => req.destroy(new ConnectorError('CONNECTION_TIMEOUT')), 10000);
    req.on('close', () => clearTimeout(deadline));
    req.on('error', error => reject(error instanceof ConnectorError ? error : new ConnectorError('CONNECTION_FAILED')));
    req.end();
  });
};

export async function verifyConnector(input: Pick<ConnectorInput, 'provider' | 'endpoint' | 'username' | 'secret'>, probe: Probe = probeHttps): Promise<void> {
  const { url, headers } = connectionRequest(input);
  // A public resource returning 200 must never be mistaken for authenticated access.
  const anonymous = await probe(url, headers['accept-version'] ? { 'accept-version': headers['accept-version'] } : {});
  if (![401, 403].includes(anonymous.status)) throw new ConnectorError('AUTHENTICATION_UNPROVEN');
  const response = await probe(url, headers);
  if ([401, 403].includes(response.status)) throw new ConnectorError('AUTH_OR_PERMISSION_DENIED');
  if (response.status !== 200) throw new ConnectorError('PROVIDER_UNAVAILABLE');
  const id = z.union([z.number().int().positive(), z.string().min(1).max(128)]);
  const item = z.object({ id });
  const schema = input.provider === 'wordpress' ? item : input.provider === 'directus' ? z.object({ data: item }) : input.provider === 'ghost' ? z.object({ posts: z.array(item).max(1) }) : z.array(item).max(1);
  if (!schema.safeParse(response.body).success) throw new ConnectorError('RESPONSE_INVALID');
}
