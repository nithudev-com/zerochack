import { describe, expect, it } from 'vitest';
import { summarizeUptime, uptimeCheck } from './uptime';
const now = new Date('2026-10-11T12:00:00Z');
const row = (status: string, http: number | null, errorCode: string | null = null) => ({ id: 'check', status, snapshot: http === null ? null : { status: http, available: true }, errorCode, responseTimeMs: 120, startedAt: now, completedAt: now });
describe('observed uptime, not invented continuous availability', () => {
  it.each([200, 204, 302])('HTTP %s is UP', http => expect(uptimeCheck(row('SUCCEEDED', http)).state).toBe('UP'));
  it.each([401, 404, 429, 500, 503])('HTTP %s is DOWN even with an old available=true snapshot', http => expect(uptimeCheck(row('SUCCEEDED', http)).state).toBe('DOWN'));
  it.each(['CONNECTION_TIMEOUT', 'CONNECTION_FAILED', 'DNS_UNRESOLVED'])('probe failure %s is DOWN', code => expect(uptimeCheck(row('FAILED', null, code)).state).toBe('DOWN'));
  it.each(['DNS_UNSAFE', 'REDIRECT_SCOPE_BLOCKED', 'RESPONSE_TOO_LARGE', 'MONITORING_CHECK_FAILED'])('safety/runtime refusal %s is UNKNOWN', code => expect(uptimeCheck(row('FAILED', null, code)).state).toBe('UNKNOWN'));
  it('never turns missing/unfinished checks into uptime or reveals snapshot details', () => {
    expect(uptimeCheck(row('RUNNING', null)).state).toBe('UNKNOWN');
    expect(Object.keys(uptimeCheck(row('SUCCEEDED', 200))).sort()).toEqual(['errorCode', 'httpStatus', 'id', 'observedAt', 'responseTimeMs', 'state']);
    const result = summarizeUptime([], { now, days: 7, enabled: true, eligible: true, intervalMinutes: 5, emailAlerts: true, last: null, truncated: false });
    expect(result.state).toBe('PENDING'); expect(result.passedPercent).toBeNull(); expect(result.days.every(day => day.up === 0)).toBe(true);
  });
  it('counts known samples only and distinguishes stale, paused and cap-limited history', () => {
    const rows = [row('SUCCEEDED', 200), row('SUCCEEDED', 503), row('FAILED', null, 'DNS_UNSAFE')];
    const options = { now, days: 7, enabled: true, eligible: true, intervalMinutes: 5, emailAlerts: false, last: rows[0]!, truncated: true };
    expect(summarizeUptime(rows, options)).toMatchObject({ passedPercent: 50, sampleCount: 3, unknownCount: 1, truncated: true, state: 'UP' });
    expect(summarizeUptime(rows, { ...options, now: new Date(now.getTime() + 16 * 60000) }).state).toBe('STALE');
    expect(summarizeUptime(rows, { ...options, enabled: false }).state).toBe('PAUSED');
  });
});
