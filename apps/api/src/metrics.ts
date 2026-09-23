import { timingSafeEqual } from 'node:crypto';

type Metric = { count: number; durationMs: number };
const requests = new Map<string, Metric>();

const safeLabel = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '');

export function observeRequest(method: string, route: string, statusCode: number, durationMs: number): void {
  const statusClass = `${Math.floor(statusCode / 100)}xx`; const key = JSON.stringify([method, route, statusClass]);
  const current = requests.get(key) ?? { count: 0, durationMs: 0 }; current.count += 1; current.durationMs += durationMs; requests.set(key, current);
}

export function authenticateMetricsToken(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(header.slice(7)); const target = Buffer.from(expected);
  return supplied.length === target.length && timingSafeEqual(supplied, target);
}

export function renderMetrics(): string {
  const lines = ['# HELP zerochack_http_requests_total Completed HTTP requests.', '# TYPE zerochack_http_requests_total counter', '# HELP zerochack_http_request_duration_milliseconds_total Cumulative request duration.', '# TYPE zerochack_http_request_duration_milliseconds_total counter'];
  for (const [key, metric] of requests) {
    const [method, route, statusClass] = JSON.parse(key) as string[]; const labels = `method="${safeLabel(method!)}",route="${safeLabel(route!)}",status_class="${safeLabel(statusClass!)}"`;
    lines.push(`zerochack_http_requests_total{${labels}} ${metric.count}`, `zerochack_http_request_duration_milliseconds_total{${labels}} ${metric.durationMs.toFixed(3)}`);
  }
  return `${lines.join('\n')}\n`;
}
