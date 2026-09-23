import { createHash } from 'node:crypto';
import type { SafeResponse } from './network.js';

export type EngineFinding = { fingerprint: string; title: string; description: string; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; confidence: number; affectedResource: string; recommendation: string; cwe?: string; cve?: string; owaspCategory?: string; remediationSupported: boolean; evidence: { summary: string; metadata: Record<string, string | number | boolean | null> } };
export type ScanContext = { targetUrl: string; response: SafeResponse; scannedAt: Date };
export interface SecurityEngine { readonly name: string; readonly version: string; scan(context: ScanContext): Promise<EngineFinding[]>; }
const fingerprint = (engine: string, rule: string, resource: string) => createHash('sha256').update(`${engine}\0${rule}\0${resource}`).digest('hex');
const missingHeader = (context: ScanContext, engine: string, header: string, title: string, severity: EngineFinding['severity'], recommendation: string, cwe: string, owaspCategory: string): EngineFinding | undefined => context.response.headers[header] ? undefined : ({ fingerprint: fingerprint(engine, `missing:${header}`, context.response.url), title, description: `The ${header} response header was not present.`, severity, confidence: 0.98, affectedResource: context.response.url, recommendation, cwe, owaspCategory, remediationSupported: false, evidence: { summary: `${header} was absent from the final HTTP response.`, metadata: { header, responseStatus: context.response.status, finalUrl: context.response.url } } });

export class HttpHeadersEngine implements SecurityEngine {
  readonly name = 'http-headers'; readonly version = '1.0.0';
  async scan(context: ScanContext): Promise<EngineFinding[]> {
    const checks = [context.response.url.startsWith('https:') ? missingHeader(context, this.name, 'strict-transport-security', 'HTTP Strict Transport Security is missing', 'MEDIUM', 'Set a carefully tested Strict-Transport-Security policy on HTTPS responses.', 'CWE-319', 'A02:2021') : undefined, missingHeader(context, this.name, 'content-security-policy', 'Content Security Policy is missing', 'MEDIUM', 'Deploy a restrictive, tested Content-Security-Policy response header.', 'CWE-693', 'A05:2021'), missingHeader(context, this.name, 'x-content-type-options', 'MIME sniffing protection is missing', 'LOW', 'Set X-Content-Type-Options to nosniff.', 'CWE-693', 'A05:2021'), missingHeader(context, this.name, 'referrer-policy', 'Referrer Policy is missing', 'LOW', 'Set an appropriate Referrer-Policy for the application.', 'CWE-200', 'A01:2021')];
    return checks.filter((item): item is EngineFinding => Boolean(item));
  }
}

export class InformationExposureEngine implements SecurityEngine {
  readonly name = 'http-information-exposure'; readonly version = '1.0.0';
  async scan(context: ScanContext): Promise<EngineFinding[]> {
    const findings: EngineFinding[] = [];
    for (const header of ['server', 'x-powered-by']) if (context.response.headers[header]) findings.push({ fingerprint: fingerprint(this.name, header, context.response.url), title: `${header} reveals implementation details`, description: `The ${header} header discloses server implementation information.`, severity: 'LOW', confidence: 0.95, affectedResource: context.response.url, recommendation: `Remove or minimize the ${header} response header.`, cwe: 'CWE-200', owaspCategory: 'A05:2021', remediationSupported: false, evidence: { summary: `${header} was present. Its value was intentionally not preserved.`, metadata: { header, present: true, responseStatus: context.response.status } } });
    return findings;
  }
}

export class BrowserHardeningEngine implements SecurityEngine {
  readonly name = 'browser-hardening'; readonly version = '1.0.0';
  async scan(context: ScanContext): Promise<EngineFinding[]> {
    const findings: EngineFinding[] = [];
    const csp = context.response.headers['content-security-policy']?.toLowerCase() ?? '';
    if (!context.response.headers['x-frame-options'] && !/(?:^|;)\s*frame-ancestors\b/u.test(csp)) findings.push({ fingerprint: fingerprint(this.name, 'clickjacking-protection', context.response.url), title: 'Clickjacking protection is missing', description: 'Neither X-Frame-Options nor a Content-Security-Policy frame-ancestors directive was observed.', severity: 'MEDIUM', confidence: 0.98, affectedResource: context.response.url, recommendation: "Set a restrictive CSP frame-ancestors directive (preferred) or a compatible X-Frame-Options policy.", cwe: 'CWE-1021', owaspCategory: 'A05:2021', remediationSupported: false, evidence: { summary: 'No response-level framing restriction was observed.', metadata: { xFrameOptionsPresent: false, cspFrameAncestorsPresent: false, responseStatus: context.response.status } } });
    if (!context.response.headers['permissions-policy']) findings.push({ fingerprint: fingerprint(this.name, 'permissions-policy', context.response.url), title: 'Browser feature permissions are not restricted', description: 'The Permissions-Policy response header was not present.', severity: 'LOW', confidence: 0.98, affectedResource: context.response.url, recommendation: 'Define a least-privilege Permissions-Policy for camera, microphone, geolocation, and other browser capabilities.', cwe: 'CWE-693', owaspCategory: 'A05:2021', remediationSupported: false, evidence: { summary: 'Permissions-Policy was absent from the final HTTP response.', metadata: { header: 'permissions-policy', responseStatus: context.response.status } } });
    const contentType = context.response.headers['content-type']?.toLowerCase() ?? '';
    if (context.response.url.startsWith('https:') && contentType.includes('text/html') && context.response.body.length) {
      const html = new TextDecoder().decode(context.response.body);
      const mixedReferences = html.match(/(?:src|href|action)\s*=\s*["']http:\/\/[^"']+["']/giu)?.length ?? 0;
      if (mixedReferences > 0) findings.push({ fingerprint: fingerprint(this.name, 'mixed-content', context.response.url), title: 'HTTPS page contains insecure HTTP resource references', description: 'The fetched HTML referenced one or more resources or form targets over unencrypted HTTP.', severity: 'MEDIUM', confidence: 0.95, affectedResource: context.response.url, recommendation: 'Serve every active resource and form endpoint over HTTPS, then deploy CSP upgrade-insecure-requests after compatibility testing.', cwe: 'CWE-319', owaspCategory: 'A02:2021', remediationSupported: false, evidence: { summary: `${mixedReferences} insecure HTTP reference(s) were counted; referenced URLs and page content were not stored.`, metadata: { mixedReferenceCount: mixedReferences, responseStatus: context.response.status, finalUrl: context.response.url } } });
    }
    return findings;
  }
}
export const implementedEngines = [new HttpHeadersEngine(), new InformationExposureEngine(), new BrowserHardeningEngine()] satisfies SecurityEngine[];
