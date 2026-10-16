import { describe, expect, it } from 'vitest';
import { orderedOverviewWebsites, overviewWebsite, type OverviewWebsite } from './overview-websites';
const site = (id: string, createdAt: string, connected = false): OverviewWebsite => ({ id, name: id, url: `https://${id}.example/`, createdAt, connectionSummary: connected ? { kind: 'SSH', providers: ['ssh'], lastCheckedAt: '2026-10-11T01:00:00Z' } : { kind: 'NONE', providers: [], lastCheckedAt: null } });
describe('website-specific overview selection', () => {
  const newest = site('new', '2026-10-11', true); const first = site('first', '2026-10-01', true); const unconnected = site('added', '2026-09-01');
  it('defaults to earliest-added currently checked connection, not latest list order or ownership alone', () => expect(overviewWebsite([newest, unconnected, first])?.id).toBe('first'));
  it('honors only an accessible requested website, including one needing connection', () => { expect(overviewWebsite([newest, unconnected, first], 'added')?.id).toBe('added'); expect(overviewWebsite([newest, first], 'foreign')?.id).toBe('first'); });
  it('falls back to the first added website when none is connected, and handles no websites', () => { expect(overviewWebsite([site('later', '2026-10-10'), unconnected])?.id).toBe('added'); expect(overviewWebsite([])).toBeUndefined(); });
  it('never mutates query data when sorting dropdown choices', () => { const rows = [newest, first]; expect(orderedOverviewWebsites(rows).map(row => row.id)).toEqual(['first', 'new']); expect(rows[0]?.id).toBe('new'); });
  it('does not default to unchecked or invalid connector evidence', () => {
    for (const summary of [{ kind: 'SSH' as const, providers: ['ssh'], lastCheckedAt: null }, { kind: 'CONNECTOR' as const, providers: [], lastCheckedAt: '2026-10-11' }, { kind: 'SSH' as const, providers: ['ssh'], lastCheckedAt: 'invalid' }]) expect(overviewWebsite([{ ...unconnected, connectionSummary: summary }, first])?.id).toBe('first');
  });
});
