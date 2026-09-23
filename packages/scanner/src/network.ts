import { isIP } from 'node:net';
import { resolve4, resolve6 } from 'node:dns/promises';
import { Agent, fetch, type Dispatcher } from 'undici';

export class TargetSecurityError extends Error {
  constructor(public readonly code: string, message: string, cause?: unknown) { super(message, { cause }); this.name = 'TargetSecurityError'; }
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type DnsResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type SafeResponse = { url: string; status: number; headers: Record<string, string>; body: Uint8Array; resolvedAddress: string; redirects: string[] };
const blockedNames = ['localhost', 'localhost.localdomain', 'metadata.google.internal'];
const blockedSuffixes = ['.localhost', '.local', '.internal', '.home', '.lan', '.corp', '.test', '.invalid', '.example'];
const unbracket = (value: string): string => value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;

export function normalizeWebsiteUrl(input: string): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new TargetSecurityError('URL_INVALID', 'Enter a valid absolute website URL'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new TargetSecurityError('PROTOCOL_BLOCKED', 'Only HTTP and HTTPS websites are supported');
  if (url.username || url.password) throw new TargetSecurityError('URL_CREDENTIALS_BLOCKED', 'Website URLs cannot contain credentials');
  if (!url.hostname || url.hostname.length > 253 || input.length > 2048) throw new TargetSecurityError('URL_INVALID', 'Website URL is invalid or too long');
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if ((url.protocol === 'https:' && port !== 443) || (url.protocol === 'http:' && port !== 80)) throw new TargetSecurityError('PORT_BLOCKED', 'Only standard web ports 80 and 443 are supported');
  url.hostname = url.hostname.toLowerCase().replace(/\.$/u, ''); url.hash = '';
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  if (!url.pathname) url.pathname = '/';
  return url.toString();
}

function ipv4Number(address: string): number { return address.split('.').reduce((value, part) => (value * 256) + Number(part), 0) >>> 0; }
function inV4Range(value: number, base: string, prefix: number): boolean { const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0; return (value & mask) === (ipv4Number(base) & mask); }

export function isPublicAddress(address: string): boolean {
  address = unbracket(address);
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    const denied: Array<[string, number]> = [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]];
    return !denied.some(([base, prefix]) => inV4Range(value, base, prefix));
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice(7); if (mapped.includes('.')) return isPublicAddress(mapped);
      const groups = mapped.split(':'); if (groups.length === 2) { const high = Number.parseInt(groups[0]!, 16); const low = Number.parseInt(groups[1]!, 16); return isPublicAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`); }
      return false;
    }
    const globallyRoutable = normalized.startsWith('2') || normalized.startsWith('3');
    return globallyRoutable && !normalized.startsWith('2001:db8:');
  }
  return false;
}

export function validateHostname(hostname: string): void {
  const value = unbracket(hostname.toLowerCase().replace(/\.$/u, ''));
  if (blockedNames.includes(value) || blockedSuffixes.some((suffix) => value.endsWith(suffix)) || (!value.includes('.') && isIP(value) === 0)) throw new TargetSecurityError('HOST_BLOCKED', 'Local and internal hostnames are not allowed');
  if (isIP(value) && !isPublicAddress(value)) throw new TargetSecurityError('ADDRESS_BLOCKED', 'Private, local, reserved, and metadata addresses are not allowed');
}

export const systemResolver: DnsResolver = async (hostname) => {
  hostname = unbracket(hostname);
  if (isIP(hostname)) return [{ address: hostname, family: isIP(hostname) as 4 | 6 }];
  const [v4, v6] = await Promise.all([resolve4(hostname).catch(() => []), resolve6(hostname).catch(() => [])]);
  return [...v4.map((address) => ({ address, family: 4 as const })), ...v6.map((address) => ({ address, family: 6 as const }))];
};

export async function resolvePublicTarget(url: URL, resolver: DnsResolver = systemResolver): Promise<ResolvedAddress[]> {
  validateHostname(url.hostname); const addresses = await resolver(url.hostname);
  if (addresses.length === 0) throw new TargetSecurityError('DNS_UNRESOLVED', 'Website hostname did not resolve');
  if (addresses.some(({ address }) => !isPublicAddress(address))) throw new TargetSecurityError('DNS_UNSAFE', 'Hostname resolves to a non-public address');
  return addresses;
}

export async function validateRedirectDestination(location: string, current: URL, resolver: DnsResolver = systemResolver, allowedHostname = current.hostname): Promise<URL> {
  const destination = new URL(normalizeWebsiteUrl(new URL(location, current).toString()));
  if (destination.hostname !== allowedHostname) throw new TargetSecurityError('REDIRECT_SCOPE_BLOCKED', 'Redirect leaves the verified website hostname');
  if (current.protocol === 'https:' && destination.protocol !== 'https:') throw new TargetSecurityError('REDIRECT_DOWNGRADE_BLOCKED', 'Redirect cannot downgrade a verified HTTPS destination');
  await resolvePublicTarget(destination, resolver); return destination;
}

async function readLimited(response: Awaited<ReturnType<typeof fetch>>, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > limit) throw new TargetSecurityError('RESPONSE_TOO_LARGE', 'Website response exceeded the scanner limit');
  if (!response.body) return new Uint8Array(); const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > limit) { await reader.cancel(); throw new TargetSecurityError('RESPONSE_TOO_LARGE', 'Website response exceeded the scanner limit'); } chunks.push(result.value); }
  const body = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; } return body;
}

export async function safeHttpRequest(input: string, options: { resolver?: DnsResolver; timeoutMs?: number; maxRedirects?: number; maxBytes?: number; method?: 'GET' | 'HEAD'; allowedHostname?: string } = {}): Promise<SafeResponse> {
  const resolver = options.resolver ?? systemResolver; const timeoutMs = options.timeoutMs ?? 10_000; const maxRedirects = options.maxRedirects ?? 5; const maxBytes = options.maxBytes ?? 1_048_576;
  let current = new URL(normalizeWebsiteUrl(input)); const redirects: string[] = []; const allowedHostname = options.allowedHostname ?? current.hostname;
  if (current.hostname !== allowedHostname) throw new TargetSecurityError('TARGET_SCOPE_BLOCKED', 'Target is outside the verified website hostname');
  for (let index = 0; index <= maxRedirects; index += 1) {
    const addresses = await resolvePublicTarget(current, resolver); const selected = addresses[0]!;
    const dispatcher: Dispatcher = new Agent({ connect: { lookup: (_hostname, lookupOptions, callback) => {
      if (lookupOptions.all) (callback as unknown as (error: NodeJS.ErrnoException | null, addresses: ResolvedAddress[]) => void)(null, [selected]);
      else callback(null, selected.address, selected.family);
    } } });
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(current, { dispatcher, redirect: 'manual', signal: controller.signal, method: options.method ?? 'GET', headers: { 'user-agent': 'ZeroRoot-ReadOnly-Scanner/1.0', accept: 'text/html,application/xhtml+xml,*/*;q=0.1' } });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location'); if (!location) throw new TargetSecurityError('REDIRECT_INVALID', 'Redirect did not provide a destination');
        if (index === maxRedirects) throw new TargetSecurityError('REDIRECT_LIMIT', 'Website exceeded the redirect limit');
        current = await validateRedirectDestination(location, current, resolver, allowedHostname); redirects.push(current.toString()); continue;
      }
      const headers = Object.fromEntries(response.headers.entries()); const body = options.method === 'HEAD' ? new Uint8Array() : await readLimited(response, maxBytes);
      return { url: current.toString(), status: response.status, headers, body, resolvedAddress: selected.address, redirects };
    } catch (error) {
      if (error instanceof TargetSecurityError) throw error;
      if (controller.signal.aborted) throw new TargetSecurityError('CONNECTION_TIMEOUT', 'Website connection timed out');
      throw new TargetSecurityError('CONNECTION_FAILED', 'Website connection failed safely', error);
    } finally { clearTimeout(timeout); await dispatcher.close(); }
  }
  throw new TargetSecurityError('REDIRECT_LIMIT', 'Website exceeded the redirect limit');
}
