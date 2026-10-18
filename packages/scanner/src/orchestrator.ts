import { safeHttpRequest, TargetSecurityError, type DnsResolver, type SafeResponse } from './network.js';
import { implementedEngines, type EngineFinding, type SecurityEngine } from './engines.js';
export type ScanRunResult = { targetUrl: string; response: Pick<SafeResponse, 'url' | 'status' | 'resolvedAddress' | 'redirects'>; findings: Array<EngineFinding & { engine: string; engineVersion: string; observedAt: Date }>; engineCount: number };
export const scanQueuePolicy = { attempts: 3, backoff: { type: 'exponential' as const, delay: 5_000 } };
export async function runSecurityScan(targetUrl: string, options: { engines?: SecurityEngine[]; resolver?: DnsResolver; timeoutMs?: number; maxRedirects?: number; maxBytes?: number; signal?: AbortSignal; onEngineComplete?: (completed: number, total: number) => Promise<void> | void } = {}): Promise<ScanRunResult> {
  const guard = () => { if (options.signal?.aborted) throw new TargetSecurityError('REQUEST_ABORTED', 'The website request was cancelled'); };
  guard();
  const response = await safeHttpRequest(targetUrl, { allowedHostname: new URL(targetUrl).hostname, ...(options.resolver ? { resolver: options.resolver } : {}), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}), ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}), ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}), ...(options.signal ? { signal: options.signal } : {}) });
  const engines = options.engines ?? implementedEngines; const scannedAt = new Date(); const findings: ScanRunResult['findings'] = [];
  for (const [index, engine] of engines.entries()) { guard(); const results = await engine.scan({ targetUrl, response, scannedAt }); guard(); findings.push(...results.map((finding) => ({ ...finding, engine: engine.name, engineVersion: engine.version, observedAt: scannedAt }))); await options.onEngineComplete?.(index + 1, engines.length); guard(); }
  return { targetUrl, response: { url: response.url, status: response.status, resolvedAddress: response.resolvedAddress, redirects: response.redirects }, findings, engineCount: engines.length };
}
