import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolvePublicTarget } from '@zerochack/scanner';
import { probeHttps } from './adapters.js';

const trust = vi.hoisted(() => ({ ca: '' }));
// Test-only local TLS endpoint. Production always uses the public-address resolver
// and Node's trust store; no localhost or custom-CA switches are exposed by routes.
vi.mock('@zerochack/scanner', async original => ({ ...await original<typeof import('@zerochack/scanner')>(), resolvePublicTarget: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]) }));
vi.mock('node:https', async original => {
  const https = await original<typeof import('node:https')>();
  return { ...https, request: (url: URL, options: import('node:https').RequestOptions, callback: Parameters<typeof https.request>[2]) => {
    expect(options.rejectUnauthorized).not.toBe(false); expect(options.method).toBe('GET'); expect(options.agent).toBe(false);
    return https.request(url, { ...options, ca: trust.ca }, callback);
  } };
});
let server: Server; let origin: string; let certificate: string; let otherCertificate: string;
const requests: Array<{ url: string; authorization: string | undefined }> = [];
beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codebandage-connector-tls-'));
  for (const name of ['trusted', 'other']) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=cms.customer.com', '-addext', 'subjectAltName=DNS:cms.customer.com', '-keyout', join(dir, name + '.key'), '-out', join(dir, name + '.crt')], { stdio: 'ignore' });
  certificate = readFileSync(join(dir, 'trusted.crt'), 'utf8'); otherCertificate = readFileSync(join(dir, 'other.crt'), 'utf8'); trust.ca = certificate;
  server = createServer({ key: readFileSync(join(dir, 'trusted.key')), cert: certificate }, (req, res) => {
    requests.push({ url: req.url!, authorization: req.headers.authorization });
    if (req.url === '/redirect') { res.writeHead(302, { location: '/credentials-must-not-follow' }); res.end(); return; }
    if (req.url === '/denied') { res.writeHead(401); res.end('never return this provider body'); return; }
    res.setHeader('content-type', req.url === '/html' ? 'text/html' : 'application/json');
    res.end(req.url === '/large' ? 'x'.repeat(70000) : req.url === '/malformed' ? '{' : JSON.stringify({ id: 2 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No fixture port'); origin = `https://cms.customer.com:${address.port}`;
}, 15000);
afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
it('performs an actual verified TLS GET through a DNS-pinned socket', async () => {
  trust.ca = certificate; expect(await probeHttps(new URL('/', origin), { authorization: 'Bearer synthetic-test-only' })).toEqual({ status: 200, body: { id: 2 } });
  expect(requests.at(-1)).toEqual({ url: '/', authorization: 'Bearer synthetic-test-only' });
});
it('rejects an untrusted certificate chain', async () => {
  trust.ca = otherCertificate; const count = requests.length;
  await expect(probeHttps(new URL('/', origin), {})).rejects.toThrow('CONNECTION_FAILED'); expect(requests).toHaveLength(count); trust.ca = certificate;
});
it('rejects the wrong certificate hostname even when the CA is trusted', async () => {
  const url = new URL('/', origin); url.hostname = 'wrong.customer.com';
  await expect(probeHttps(url, {})).rejects.toThrow('CONNECTION_FAILED');
});
it('does not follow a redirect or forward credentials', async () => {
  const count = requests.length; expect(await probeHttps(new URL('/redirect', origin), { authorization: 'Bearer synthetic' })).toEqual({ status: 302, body: null }); expect(requests).toHaveLength(count + 1);
});
it('discards provider error bodies', async () => { expect(await probeHttps(new URL('/denied', origin), {})).toEqual({ status: 401, body: null }); });
it.each(['/html', '/malformed', '/large'])('rejects unexpected or oversized response %s', async path => { await expect(probeHttps(new URL(path, origin), {})).rejects.toThrow(); });
it('opens no socket if the public-address resolver rejects the target', async () => {
  const count = requests.length; vi.mocked(resolvePublicTarget).mockRejectedValueOnce(new Error('DNS_UNSAFE'));
  await expect(probeHttps(new URL('/', origin), {})).rejects.toThrow('DNS_UNSAFE'); expect(requests).toHaveLength(count);
});
