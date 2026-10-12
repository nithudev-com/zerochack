import { describe, expect, it } from 'vitest';
import { monitoringEmailData, renderMonitoringEmail } from './index';
const fixture = { state: 'DOWN', websiteId: 'b33690a6-6d5e-4f7b-9e86-5f8f7913d2ea', websiteName: '<script>bad</script>', websiteHost: 'example.test', checkedAt: '2026-10-11T12:00:00Z', outageStartedAt: '2026-10-11T11:30:00Z', httpStatus: 503, recent: ['UP', 'DOWN', 'UNKNOWN'] };
describe('graphical downtime and recovery emails', () => {
  it.each(['DOWN', 'RECOVERED', 'UNKNOWN'])('renders safe branded %s mail with static green/red graphics', state => {
    const data = monitoringEmailData({ ...fixture, state }, 'https://codebandage.com')!; const html = renderMonitoringEmail(data);
    expect(html).toContain('cid:codebandage-logo'); expect(html).toContain('#167347'); expect(html).toContain('#b42318');
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;'); expect(html).not.toMatch(/<img[^>]+https?:/);
    expect(html).toContain('not continuous coverage'); expect(html).toContain('https://codebandage.com/customer/overview?website=');
    expect(html).not.toContain('javascript:'); expect(html).not.toContain('animation:');
  });
  it('rejects invalid metadata and fixes the action URL to the configured origin', () => {
    expect(monitoringEmailData({ ...fixture, state: '<script>' }, 'https://codebandage.com')).toBeUndefined();
    expect(monitoringEmailData({ ...fixture, checkedAt: 'not-a-date' }, 'https://codebandage.com')).toBeUndefined();
    expect(monitoringEmailData({ ...fixture, overviewUrl: 'https://evil.example/', recent: ['bad'] }, 'https://codebandage.com')?.overviewUrl).toMatch(/^https:\/\/codebandage.com\/customer\/overview/);
    expect(() => monitoringEmailData(fixture, 'javascript:alert(1)')).toThrow('MONITORING_EMAIL_ORIGIN_INVALID');
  });
});
