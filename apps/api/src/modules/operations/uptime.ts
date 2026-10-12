import type { UptimeCheck, UptimeSummary } from '@zerochack/types';

type Check = { id: string; status: string; snapshot: unknown; errorCode: string | null; responseTimeMs: number | null; startedAt: Date; completedAt: Date | null };
export function uptimeCheck(check: Check): UptimeCheck {
  const snapshot = check.snapshot && typeof check.snapshot === 'object' && !Array.isArray(check.snapshot) ? check.snapshot as Record<string, unknown> : {};
  const httpStatus = typeof snapshot.status === 'number' && snapshot.status >= 100 && snapshot.status <= 599 ? snapshot.status : null;
  // A completed probe is not necessarily a healthy website. Ignore old available
  // booleans which used to mark HTTP 404 as healthy. Safety refusals are UNKNOWN.
  const state = check.status === 'SUCCEEDED' && httpStatus !== null ? httpStatus >= 200 && httpStatus < 400 ? 'UP' : 'DOWN'
    : check.status === 'FAILED' && ['CONNECTION_FAILED', 'CONNECTION_TIMEOUT', 'DNS_UNRESOLVED'].includes(check.errorCode ?? '') ? 'DOWN' : 'UNKNOWN';
  return { id: check.id, observedAt: (check.completedAt ?? check.startedAt).toISOString(), state, httpStatus, responseTimeMs: check.responseTimeMs, errorCode: check.errorCode };
}

export function summarizeUptime(checks: Check[], options: { now: Date; days: number; enabled: boolean; eligible: boolean; intervalMinutes: number; emailAlerts: boolean; last: Check | null; truncated: boolean }): Omit<UptimeSummary, 'incidents' | 'emailHistory' | 'emailTemplateEnabled'> {
  const rows = checks.map(uptimeCheck); const upCount = rows.filter(check => check.state === 'UP').length; const downCount = rows.filter(check => check.state === 'DOWN').length;
  const times = rows.filter(check => check.state === 'UP' && check.responseTimeMs !== null).map(check => check.responseTimeMs!);
  const lastCheck = options.last ? uptimeCheck(options.last) : null;
  const stale = lastCheck && options.now.getTime() - Date.parse(lastCheck.observedAt) > Math.max(10 * 60_000, options.intervalMinutes * 2.5 * 60_000);
  const dayMap = new Map<string, { day: string; up: number; down: number; unknown: number }>();
  for (let offset = options.days - 1; offset >= 0; offset--) { const day = new Date(options.now.getTime() - offset * 86400000).toISOString().slice(0, 10); dayMap.set(day, { day, up: 0, down: 0, unknown: 0 }); }
  for (const row of rows) { const day = dayMap.get(row.observedAt.slice(0, 10)); if (day) day[row.state === 'UP' ? 'up' : row.state === 'DOWN' ? 'down' : 'unknown']++; }
  return { observedAt: options.now.toISOString(), enabled: options.enabled, eligible: options.eligible, intervalMinutes: options.intervalMinutes, emailAlerts: options.emailAlerts,
    state: !options.enabled ? 'PAUSED' : !options.eligible ? 'UNKNOWN' : !lastCheck ? 'PENDING' : stale ? 'STALE' : lastCheck.state, lastCheck,
    windowDays: options.days, sampleCount: rows.length, knownCount: upCount + downCount, upCount, downCount, unknownCount: rows.length - upCount - downCount,
    passedPercent: upCount + downCount ? Math.round(upCount / (upCount + downCount) * 10000) / 100 : null,
    averageResponseMs: times.length ? Math.round(times.reduce((sum, value) => sum + value, 0) / times.length) : null,
    truncated: options.truncated, days: [...dayMap.values()] };
}
