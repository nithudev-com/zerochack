import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
const transport = vi.hoisted(() => ({ httpOptions: null as Record<string, unknown> | null, tlsOptions: null as Record<string, unknown> | null, httpCalls: 0, tlsCalls: 0, tlsFail: false }));
vi.mock('node:https', () => ({ request: (options: Record<string, unknown>, callback: (response: unknown) => void) => {
  transport.httpOptions = options; transport.httpCalls++;
  const req = Object.assign(new EventEmitter(), { maxHeadersCount: 0, destroy() {}, end() { queueMicrotask(() => callback(Object.assign(new EventEmitter(), { statusCode: 302, headers: { 'set-cookie': 'secret-cookie', location: 'https://unapproved.example.org/', 'x-content-type-options': 'nosniff' }, destroy() {} }))); } });
  return req;
} }));
vi.mock('node:tls', async (original) => {
  const actual = await original<typeof import('node:tls')>();
  return { ...actual, connect: (options: Record<string, unknown>, callback: () => void) => {
    transport.tlsOptions = options; transport.tlsCalls++;
    const socket = Object.assign(new EventEmitter(), { authorized: true, destroy() {}, getProtocol: () => 'TLSv1.3', getPeerCertificate: () => ({ subject: { CN: 'example.org' }, subjectaltname: 'DNS:example.org', fingerprint256: 'AA:BB', valid_from: 'Jan 1 00:00:00 2026 GMT', valid_to: 'Jan 1 00:00:00 2027 GMT' }) });
    queueMicrotask(() => transport.tlsFail ? socket.emit('error', new Error('sensitive certificate diagnostics')) : callback()); return socket;
  } };
});
import { observeHttp, observeTls, observationTarget, OSV_ENDPOINT, queryAdvisories, summarizeHeaders } from './external-observations.js';
const packages = [{ ecosystem: 'npm' as const, name: 'sample', version: '1.2.3' }];
const fetchResult = (value: unknown) => vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(value), { status: 200 }));
afterEach(() => { transport.httpCalls = 0; transport.tlsCalls = 0; transport.tlsFail = false; });
describe('OSV matching contract with explicit exact coordinates', () => {
  it('sends only selected coordinates to the fixed endpoint and preserves matches with provenance', async () => {
    const fetcher = fetchResult({ results: [{ vulns: [{ id: 'GHSA-test-1234', modified: '2026-01-01T00:00:00Z' }] }] });
    const result = await queryAdvisories(packages, fetcher);
    expect(fetcher.mock.calls[0]?.[0]).toBe(OSV_ENDPOINT);
    const init = fetcher.mock.calls[0]?.[1]; expect(init?.redirect).toBe('error');
    expect(JSON.parse(String(init?.body))).toEqual({ queries: [{ package: { ecosystem: 'npm', name: 'sample' }, version: '1.2.3' }] });
    expect(result.state).toBe('MATCHES_REPORTED'); expect(result.results[0]?.matches[0]?.id).toBe('GHSA-test-1234');
  });
  it('does not treat paginated empty matches as a complete clean result', async () => {
    expect((await queryAdvisories(packages, fetchResult({ results: [{ next_page_token: 'opaque' }] }))).state).toBe('INCOMPLETE');
  });
  it('reports no matches without claiming the deployed application is secure', async () => {
    const result = await queryAdvisories(packages, fetchResult({ results: [{}] }));
    expect(result.state).toBe('NO_MATCHES_REPORTED'); expect(result.limitation).toContain('not proof');
  });
  it.each([{ results: [] }, { results: [{ error: 'upstream failure' }] }, { results: [{ vulns: [{ id: '<script>', modified: 'yesterday' }] }] }, { results: [null] }])('rejects malformed or incomplete results: %j', async (value) => {
    await expect(queryAdvisories(packages, fetchResult(value))).rejects.toMatchObject({ code: 'ADVISORY_RESPONSE_INVALID' });
  });
  it('fails explicitly on transport, HTTP and response-size errors', async () => {
    await expect(queryAdvisories(packages, vi.fn<typeof fetch>().mockRejectedValue(new Error('private-key-detail')))).rejects.toMatchObject({ code: 'ADVISORY_UNAVAILABLE' });
    await expect(queryAdvisories(packages, vi.fn<typeof fetch>().mockResolvedValue(new Response('quota', { status: 429 })))).rejects.toMatchObject({ code: 'ADVISORY_UNAVAILABLE' });
    await expect(queryAdvisories(packages, vi.fn<typeof fetch>().mockResolvedValue(new Response('a'.repeat(262145))))).rejects.toMatchObject({ code: 'ADVISORY_RESPONSE_INVALID' });
  });
  it('rejects empty, duplicate, range and oversized selections before making a request', async () => {
    const fetcher = fetchResult({ results: [] });
    for (const value of [[], [...packages, ...packages], [{ ...packages[0]!, version: '^1.2.0' }], Array.from({ length: 51 }, (_, i) => ({ ...packages[0]!, name: `p${i}` }))]) await expect(queryAdvisories(value, fetcher)).rejects.toMatchObject({ code: 'PACKAGE_SELECTION_INVALID' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
describe('website-bound, credential-free observation transports', () => {
  it('uses only the root and rejects query parameters and non-web ports', () => {
    expect(observationTarget('https://example.org/allowed/path').toString()).toBe('https://example.org/');
    expect(() => observationTarget('https://example.org/?credential=opaque')).toThrow();
    expect(() => observationTarget('https://example.org:9443/')).toThrow();
  });
  it('does not expose cookies, redirects or arbitrary header contents', () => {
    const result = summarizeHeaders(200, { 'set-cookie': ['private'], 'content-security-policy': 'report-uri https://private.example.org/', 'x-content-type-options': 'nosniff' }, true);
    expect(result.nosniff).toBe(true); expect(JSON.stringify(result)).not.toContain('private');
  });
  it('pins the public address, original hostname and HEAD method without following redirects', async () => {
    const result = await observeHttp('https://example.org/', async () => [{ address: '8.8.8.8', family: 4 }]);
    expect(transport.httpCalls).toBe(1); expect(transport.httpOptions).toMatchObject({ hostname: '8.8.8.8', servername: 'example.org', method: 'HEAD', path: '/', rejectUnauthorized: true, agent: false });
    expect(result.redirectObserved).toBe(true); expect(result.redirectFollowed).toBe(false); expect(JSON.stringify(result)).not.toMatch(/secret-cookie|unapproved/);
  });
  it('rejects unsafe and mixed DNS answers before opening a socket', async () => {
    for (const addresses of [[{ address: '127.0.0.1', family: 4 as const }], [{ address: '8.8.8.8', family: 4 as const }, { address: '10.0.0.1', family: 4 as const }]]) await expect(observeHttp('https://example.org/', async () => addresses)).rejects.toMatchObject({ code: 'TARGET_NOT_PUBLIC' });
    expect(transport.httpCalls).toBe(0);
  });
  it('does one hostname-validated TLS handshake with certificate verification enabled', async () => {
    const result = await observeTls('https://example.org/', async () => [{ address: '8.8.8.8', family: 4 }]);
    expect(transport.tlsCalls).toBe(1); expect(transport.tlsOptions).toMatchObject({ host: '8.8.8.8', servername: 'example.org', port: 443, rejectUnauthorized: true, minVersion: 'TLSv1.2' });
    expect(result.authorized).toBe(true); expect(result.validTo).toBe('2027-01-01T00:00:00.000Z');
  });
  it('rejects a certificate for another hostname and suppresses raw transport errors', async () => {
    await expect(observeTls('https://other.org/', async () => [{ address: '8.8.8.8', family: 4 }])).rejects.toMatchObject({ code: 'TLS_OBSERVATION_FAILED' });
    transport.tlsFail = true;
    await expect(observeTls('https://example.org/', async () => [{ address: '8.8.8.8', family: 4 }])).rejects.toThrow('The certificate-validated TLS observation failed.');
  });
  it('never attempts TLS for an HTTP-only registration', async () => {
    await expect(observeTls('http://example.org/')).rejects.toMatchObject({ code: 'HTTPS_REQUIRED' }); expect(transport.tlsCalls).toBe(0);
  });
});
