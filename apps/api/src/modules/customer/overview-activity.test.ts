import { describe, expect, it } from 'vitest';
import { websiteNavigationLabels } from '@zerochack/types';
import { navigationActivity, navigationClickInput } from './overview-activity.js';
describe('minimal overview click receipts', () => {
  it('accepts every public tool and workplace option and only those options', () => {
    for (const [section, labels] of Object.entries(websiteNavigationLabels)) for (const option of Object.keys(labels)) expect(navigationClickInput.safeParse({ section, option }).success).toBe(true);
    for (const payload of [{ section: 'TOOLS', option: 'development' }, { section: 'WORKPLACE', option: 'marketing' }, { section: 'EXECUTE', option: 'security' }, { section: 'TOOLS', option: 'seo', content: 'private work text' }, { section: 'TOOLS', option: 'seo', websiteId: 'foreign' }, { section: 'TOOLS', option: 'seo', timestamp: 'invented' }]) expect(navigationClickInput.safeParse(payload).success).toBe(false);
  });
  it('projects only known click data; never exposes arbitrary audit contents', () => {
    const row = { id: 'fixture', createdAt: new Date('2026-10-11T01:00:00Z'), metadata: { section: 'TOOLS', option: 'seo' }, ipAddress: '192.0.2.1', actorUserId: 'hidden', requestId: 'hidden' };
    expect(navigationActivity(row)).toEqual({ id: row.id, createdAt: row.createdAt, section: 'TOOLS', option: 'seo' });
    expect(navigationActivity({ ...row, metadata: { content: 'not a navigation click' } })).toBeNull();
  });
});
