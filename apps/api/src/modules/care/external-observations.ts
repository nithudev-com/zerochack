import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkServerIdentity, connect, type TLSSocket } from 'node:tls';
import { isIP } from 'node:net';
import { normalizeWebsiteUrl, resolvePublicTarget, type DnsResolver } from '@zerochack/scanner';
import { coordinateKey, isDependencyCoordinate, type DependencyCoordinate } from '@zerochack/care';
import { ApiError } from '../../errors.js';

export const OSV_ENDPOINT = 'https://api.osv.dev/v1/querybatch';
export function observationTarget(input: string): URL {
  const url = new URL(normalizeWebsiteUrl(input));
  if (url.search || url.hash) throw new ApiError(400, 'TARGET_QUERY_UNSUPPORTED', 'Remove query parameters from the registered website URL before requesting an observation.');
  url.pathname = '/';
  return url;
}
const header = (headers: IncomingHttpHeaders, name: string) => {
  const value = headers[name]; return typeof value === 'string' ? value : '';
};
/** Never returns cookie, location, CSP report endpoints or arbitrary server headers. */
export function summarizeHeaders(status: number, headers: IncomingHttpHeaders, secure: boolean) {
  const presence = ['content-security-policy', 'strict-transport-security', 'x-content-type-options', 'x-frame-options', 'referrer-policy', 'permissions-policy'].map((name) => ({ name, present: Boolean(header(headers, name)) }));
  return { status, https: secure, redirectObserved: status >= 300 && status < 400, redirectFollowed: false, headers: presence,
    nosniff: header(headers, 'x-content-type-options').trim().toLowerCase() === 'nosniff',
    frameRestriction: /^(deny|sameorigin)$/i.test(header(headers, 'x-frame-options').trim()),
    limitation: 'One unauthenticated HEAD request to the registered website root. Header presence is not a security verdict. Redirects, page bodies, cookies, applications and other routes are not inspected.' };
}
async function resolveWithinDeadline(url: URL, signal: AbortSignal, resolver?: DnsResolver) {
  signal.throwIfAborted();
  return new Promise<Awaited<ReturnType<typeof resolvePublicTarget>>>((resolve, reject) => {
    const cancel = () => reject(new ApiError(504, 'OBSERVATION_TIMEOUT', 'The bounded observation timed out.'));
    signal.addEventListener('abort', cancel, { once: true });
    void resolvePublicTarget(url, resolver).then(resolve, () => reject(new ApiError(400, 'TARGET_NOT_PUBLIC', 'The target could not be safely resolved to public addresses.'))).finally(() => signal.removeEventListener('abort', cancel));
  });
}
export async function observeHttp(input: string, resolver?: DnsResolver) {
  const url = observationTarget(input); const signal = AbortSignal.timeout(10_000);
  const [selected] = await resolveWithinDeadline(url, signal, resolver);
  if (!selected) throw new ApiError(400, 'TARGET_NOT_PUBLIC', 'No approved address was resolved.');
  signal.throwIfAborted();
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise<ReturnType<typeof summarizeHeaders>>((resolve, reject) => {
    const secure = url.protocol === 'https:';
    const request = (secure ? httpsRequest : httpRequest)({ hostname: selected.address, family: selected.family, port: secure ? 443 : 80, path: '/', method: 'HEAD', agent: false,
      signal, maxHeaderSize: 16_384, headers: { host: url.host, 'user-agent': 'ZeroRoot-Authorized-Observation/1.0', accept: '*/*', connection: 'close' },
      ...(secure ? { rejectUnauthorized: true, servername: isIP(hostname) ? undefined : hostname, checkServerIdentity: (_: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(hostname, cert) } : {}) }, (response) => {
      const result = summarizeHeaders(response.statusCode ?? 0, response.headers, secure);
      response.on('error', () => undefined); response.destroy(); request.destroy(); resolve(result);
    });
    request.maxHeadersCount = 64;
    request.on('error', () => reject(new ApiError(502, signal.aborted ? 'OBSERVATION_TIMEOUT' : 'HTTP_OBSERVATION_FAILED', 'The website observation failed. No connection credentials were used.')));
    request.end();
  });
}
export async function observeTls(input: string, resolver?: DnsResolver) {
  const url = observationTarget(input);
  if (url.protocol !== 'https:') throw new ApiError(409, 'HTTPS_REQUIRED', 'TLS observation requires a registered HTTPS website.');
  const signal = AbortSignal.timeout(10_000); const [selected] = await resolveWithinDeadline(url, signal, resolver);
  if (!selected) throw new ApiError(400, 'TARGET_NOT_PUBLIC', 'No approved address was resolved.');
  signal.throwIfAborted(); const hostname = url.hostname.replace(/^\[|\]$/g, '');
  return new Promise<{ authorized: true; protocol: string | null; fingerprint256: string; validFrom: string; validTo: string; limitation: string }>((resolve, reject) => {
    let socket: TLSSocket;
    const cancel = () => socket?.destroy(new Error('deadline'));
    socket = connect({ host: selected.address, port: 443, rejectUnauthorized: true, minVersion: 'TLSv1.2',
      ...(isIP(hostname) ? {} : { servername: hostname }), checkServerIdentity: (_, cert) => checkServerIdentity(hostname, cert) }, () => {
      try {
        if (!socket.authorized) throw new Error('unauthorized');
        const cert = socket.getPeerCertificate();
        // Explicitly check the original hostname even when connecting to a literal pinned IP.
        if (checkServerIdentity(hostname, cert)) throw new Error('hostname');
        const result = { authorized: true as const, protocol: socket.getProtocol(), fingerprint256: cert.fingerprint256,
          validFrom: new Date(cert.valid_from).toISOString(), validTo: new Date(cert.valid_to).toISOString(),
          limitation: 'One certificate-validated TLS handshake to the registered host. No cipher enumeration, revocation-status check or application-security assessment.' };
        resolve(result);
      } catch { reject(new ApiError(502, 'TLS_OBSERVATION_FAILED', 'Certificate validation or metadata extraction failed.')); }
      finally { signal.removeEventListener('abort', cancel); socket.destroy(); }
    });
    signal.addEventListener('abort', cancel, { once: true });
    socket.on('error', () => { signal.removeEventListener('abort', cancel); socket.destroy(); reject(new ApiError(502, signal.aborted ? 'OBSERVATION_TIMEOUT' : 'TLS_OBSERVATION_FAILED', 'The certificate-validated TLS observation failed.')); });
    socket.on('close', () => { signal.removeEventListener('abort', cancel); reject(new ApiError(502, 'TLS_OBSERVATION_FAILED', 'The peer closed before a verified result was available.')); });
  });
}
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
export async function queryAdvisories(packages: DependencyCoordinate[], fetcher: typeof fetch = fetch) {
  if (!packages.length || packages.length > 50 || packages.some((p) => !isDependencyCoordinate(p)) || new Set(packages.map(coordinateKey)).size !== packages.length) throw new ApiError(400, 'PACKAGE_SELECTION_INVALID', 'Select 1–50 distinct exact package coordinates from the approved inventory.');
  const signal = AbortSignal.timeout(10_000);
  let response: Response;
  try { response = await fetcher(OSV_ENDPOINT, { method: 'POST', redirect: 'error', signal, headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ queries: packages.map(({ ecosystem, name, version }) => ({ package: { ecosystem, name }, version })) }) }); }
  catch { throw new ApiError(502, 'ADVISORY_UNAVAILABLE', 'The advisory service could not be reached. No result is claimed.'); }
  if (!response.ok) { await response.body?.cancel(); throw new ApiError(502, 'ADVISORY_UNAVAILABLE', 'The advisory service did not return a successful response.'); }
  const reader = response.body?.getReader(); if (!reader) throw new ApiError(502, 'ADVISORY_RESPONSE_INVALID', 'The advisory service returned no data.');
  let size = 0; const chunks: Uint8Array[] = [];
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 262144) throw new Error('limit'); chunks.push(next.value); }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!object(value) || !Array.isArray(value.results) || value.results.length !== packages.length) throw new Error('shape');
    let count = 0;
    const results = value.results.map((result: unknown, index: number) => {
      if (!object(result) || result.error || (result.vulns !== undefined && !Array.isArray(result.vulns)) || (result.next_page_token !== undefined && typeof result.next_page_token !== 'string')) throw new Error('shape');
      const vulnerabilities = (result.vulns ?? []) as unknown[];
      const matches = vulnerabilities.slice(0, 100).map((v: unknown) => {
        if (!object(v) || typeof v.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(v.id) || typeof v.modified !== 'string' || !Number.isFinite(Date.parse(v.modified))) throw new Error('shape');
        count++; if (count > 300) throw new Error('limit');
        return { id: v.id, modified: new Date(v.modified).toISOString() };
      });
      return { ...packages[index]!, matches, incomplete: Boolean(result.next_page_token) || vulnerabilities.length > 100 };
    });
    return { provider: 'OSV', endpoint: OSV_ENDPOINT, observedAt: new Date().toISOString(), results,
      state: results.some((r) => r.incomplete) ? 'INCOMPLETE' : count ? 'MATCHES_REPORTED' : 'NO_MATCHES_REPORTED',
      limitation: 'Snapshot-version advisory matches only, not proof of installed versions, runtime exploitability or a vulnerability-free website. First page only; pagination and result caps are reported as incomplete. No source text, credentials, hostnames or repository URLs were sent.' };
  } catch { await reader.cancel().catch(() => undefined); throw new ApiError(502, 'ADVISORY_RESPONSE_INVALID', 'The advisory response was malformed, oversized or incomplete at the transport layer. No passing result is claimed.'); }
  finally { reader.releaseLock(); }
}
export type ObservationAdapters = { http: typeof observeHttp; tls: typeof observeTls; advisories: typeof queryAdvisories };
export const observationAdapters: ObservationAdapters = { http: observeHttp, tls: observeTls, advisories: queryAdvisories };
