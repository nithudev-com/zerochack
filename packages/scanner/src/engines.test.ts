import { describe, expect, it } from 'vitest';
import { BrowserHardeningEngine, HttpHeadersEngine, InformationExposureEngine } from './engines.js';
import { scanQueuePolicy } from './orchestrator.js';
const context = { targetUrl: 'https://example.com/', scannedAt: new Date('2026-01-01T00:00:00Z'), response: { url: 'https://example.com/', status: 200, headers: { server: 'hidden-value' }, body: new Uint8Array(), resolvedAddress: '93.184.216.34', redirects: [] } };
describe('implemented read-only engines', () => {
  it('normalizes missing security headers without storing present header values', async () => {
    const findings = await new HttpHeadersEngine().scan(context); expect(findings.map((item) => item.title)).toContain('Content Security Policy is missing'); expect(findings.every((item) => item.remediationSupported === false)).toBe(true);
    const exposure = await new InformationExposureEngine().scan(context); expect(exposure[0]?.evidence.metadata).toEqual({ header: 'server', present: true, responseStatus: 200 }); expect(JSON.stringify(exposure)).not.toContain('hidden-value');
  });
  it('defines bounded exponential queue retries', () => { expect(scanQueuePolicy).toEqual({ attempts: 3, backoff: { type: 'exponential', delay: 5000 } }); });
  it('detects missing framing controls and counts mixed content without retaining URLs', async () => {
    const body = new TextEncoder().encode('<script src="http://unsafe.example/app.js"></script><form action="http://unsafe.example/login"></form>');
    const findings = await new BrowserHardeningEngine().scan({ ...context, response: { ...context.response, headers: { 'content-type': 'text/html' }, body } });
    expect(findings.map((item) => item.title)).toEqual(expect.arrayContaining(['Clickjacking protection is missing', 'Browser feature permissions are not restricted', 'HTTPS page contains insecure HTTP resource references']));
    expect(findings.find((item) => item.title.includes('insecure HTTP'))?.evidence.metadata).toMatchObject({ mixedReferenceCount: 2 });
    expect(JSON.stringify(findings)).not.toContain('unsafe.example');
  });
});
