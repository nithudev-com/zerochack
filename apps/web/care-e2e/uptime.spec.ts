import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { UptimeSummary } from '@zerochack/types';
const first = 'b33690a6-6d5e-4f7b-9e86-5f8f7913d2ea'; const second = 'c33690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const stamp = new Date().toISOString();
function summary(state: UptimeSummary['state'] = 'UP'): UptimeSummary {
  return { observedAt: stamp, enabled: true, eligible: true, intervalMinutes: 5, emailAlerts: true, state, lastCheck: { id: first, state: 'UP', httpStatus: 200, responseTimeMs: 120, errorCode: null, observedAt: stamp }, windowDays: 30, sampleCount: 5, knownCount: 4, upCount: 3, downCount: 1, unknownCount: 1, passedPercent: 75, averageResponseMs: 120, truncated: false, days: Array.from({ length: 30 }, (_, index) => ({ day: new Date(Date.now() - (29 - index) * 86400000).toISOString().slice(0, 10), up: index === 29 ? 3 : 0, down: index === 28 ? 1 : 0, unknown: 0 })), incidents: [{ id: first, title: 'Website availability failure', firstObservedAt: stamp, lastObservedAt: stamp, recoveredAt: stamp }], emailHistory: [{ id: first, status: 'DELIVERED', createdAt: stamp, deliveredAt: stamp, attempts: 1, lastErrorCode: null }], emailTemplateEnabled: true };
}
async function fixture(page: Page, options: { state?: UptimeSummary['state']; failure?: boolean; noSamples?: boolean; eligible?: boolean; saveFailure?: boolean; disconnected?: boolean } = {}) {
  const writes: Array<{ path: string; body: unknown }> = []; let data = summary(options.state);
  if (options.noSamples) data = { ...data, enabled: false, state: 'PAUSED', lastCheck: null, sampleCount: 0, knownCount: 0, upCount: 0, downCount: 0, unknownCount: 0, passedPercent: null, averageResponseMs: null, incidents: [], emailHistory: [] };
  if (options.eligible === false) data.eligible = false;
  await page.route('**/v1/**', async route => {
    const req = route.request(); const path = new URL(req.url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, PATCH, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (req.method() !== 'GET') writes.push({ path, body: req.postDataJSON() });
    if (path.endsWith('/auth/me')) return route.fulfill({ headers, json: { roles: ['Customer'] } });
    if (path === '/v1/websites') return route.fulfill({ headers, json: [first, second].map((id, index) => ({ id, name: index ? 'Second website' : 'First website', url: `https://${index ? 'second' : 'first'}.example/`, createdAt: stamp, connectionSummary: { kind: options.disconnected ? 'DISCONNECTED' : 'SSH', providers: options.disconnected ? [] : ['ssh'], lastCheckedAt: options.disconnected ? null : stamp } })) });
    if (path.endsWith('/uptime')) return options.failure ? route.fulfill({ headers, status: 503, json: { error: { code: 'UNAVAILABLE', message: 'Monitoring is temporarily unavailable.' } } }) : route.fulfill({ headers, json: path.includes(second) ? { ...data, enabled: false, state: 'PAUSED', lastCheck: null, passedPercent: null, averageResponseMs: null, incidents: [], emailHistory: [] } : data });
    if (path.endsWith('/uptime/history')) {
      const before = new URL(req.url()).searchParams.get('before');
      return route.fulfill({ headers, json: { checks: [{ id: before ? second : first, state: before ? 'DOWN' : 'UP', httpStatus: before ? 503 : 200, responseTimeMs: 120, errorCode: null, observedAt: stamp }], nextCursor: before ? null : first } });
    }
    if (path.endsWith('/monitoring')) {
      if (options.saveFailure) { data.enabled = false; data.state = 'PAUSED'; return route.fulfill({ headers, status: 503, json: { error: { code: 'SCHEDULER_UNAVAILABLE', message: 'Monitoring could not be scheduled. It remains disabled; retry shortly.' } } }); }
      const input = req.postDataJSON(); data = { ...data, ...input, state: input.enabled ? 'PENDING' : 'PAUSED' }; return route.fulfill({ headers, json: {} });
    }
    if (path.endsWith('/monitoring/checks')) return route.fulfill({ headers, status: 202, json: { queued: true } });
    if (path.endsWith('/navigation-activity') || path.endsWith('/notifications')) return route.fulfill({ headers, json: [] });
    return route.fulfill({ headers, json: {} });
  });
  return writes;
}
for (const width of [320, 390, 1440]) test(`real-status monitoring sits after the website switcher and is accessible at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); const writes = await fixture(page); await page.goto('/customer/overview');
  const panel = page.getByRole('region', { name: 'Uptime monitoring' });
  await expect(panel.getByText('75.00%', { exact: true })).toBeVisible(); await expect(panel.getByText('Up', { exact: true }).first()).toBeVisible();
  expect(await page.locator('[aria-label="Selected website"]').evaluate(element => element.nextElementSibling?.getAttribute('data-uptime-state'))).toBe('UP');
  await expect(panel.getByRole('img', { name: /observed availability/ })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width); expect(writes).toEqual([]);
  await page.screenshot({ path: `/tmp/codebandage-uptime-${width}.png`, fullPage: true });
});
test('history, incidents and own email deliveries are readable and older checks remain reachable', async ({ page }) => {
  const writes = await fixture(page); await page.goto('/customer/overview'); const panel = page.getByRole('region', { name: 'Uptime monitoring' });
  await panel.getByRole('button', { name: 'View check history' }).click(); await expect(panel.getByText('SMTP accepted', { exact: true })).toBeVisible();
  await expect(panel.getByText('Recovered', { exact: true })).toBeVisible(); await panel.getByRole('button', { name: 'Load older checks' }).click(); await expect(panel.getByText('HTTP 503 · 120 ms', { exact: true })).toBeVisible();
  await page.getByLabel('Monitoring history window').selectOption('7d'); expect(writes).toEqual([]);
});
test('visible pause and resume preserve history and saved settings without applying a draft', async ({ page }) => {
  const writes = await fixture(page); await page.goto('/customer/overview'); const panel = page.getByRole('region', { name: 'Uptime monitoring' });
  await expect(panel.getByRole('button', { name: 'Pause monitoring', exact: true })).toBeVisible();
  await panel.getByText('Monitoring & email settings', { exact: true }).click();
  await page.getByLabel('Check frequency').selectOption('15'); await page.getByLabel('Monitoring emails for my account').uncheck();
  await panel.getByText('Monitoring & email settings', { exact: true }).click();
  await panel.getByRole('button', { name: 'Pause monitoring', exact: true }).click();
  await expect(panel).toHaveAttribute('data-uptime-state', 'PAUSED');
  await expect(panel.getByText(/Monitoring paused for this website/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Check now', exact: true })).toBeDisabled();
  await expect(panel.getByText('75.00%', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'View check history' }).click(); await expect(panel.getByText('SMTP accepted', { exact: true })).toBeVisible();
  await page.reload(); await expect(panel).toHaveAttribute('data-uptime-state', 'PAUSED');
  await panel.getByRole('button', { name: 'Resume monitoring', exact: true }).click();
  await expect(panel).toHaveAttribute('data-uptime-state', 'PENDING');
  await panel.getByText('Monitoring & email settings', { exact: true }).click();
  await expect(page.getByLabel('Check frequency')).toHaveValue('5'); await expect(page.getByLabel('Monitoring emails for my account')).toBeChecked();
  expect(writes).toEqual([{ path: `/v1/websites/${first}/monitoring`, body: { enabled: false } }, { path: `/v1/websites/${first}/monitoring`, body: { enabled: true } }]);
  await page.getByLabel('Switch website').selectOption(second); await expect(panel.getByRole('button', { name: 'Resume monitoring', exact: true })).toBeVisible();
});
test('quick resume fails honestly and unsupported targets cannot resume', async ({ page }) => {
  const writes = await fixture(page, { noSamples: true, saveFailure: true }); await page.goto('/customer/overview'); const panel = page.getByRole('region', { name: 'Uptime monitoring' });
  await panel.getByRole('button', { name: 'Resume monitoring', exact: true }).click();
  await expect(panel.getByRole('alert').filter({ hasText: 'Monitoring could not be scheduled' })).toBeVisible(); await expect(panel).toHaveAttribute('data-uptime-state', 'PAUSED');
  expect(writes).toEqual([{ path: `/v1/websites/${first}/monitoring`, body: { enabled: true } }]);
  await page.unroute('**/v1/**'); await fixture(page, { noSamples: true, eligible: false }); await page.reload();
  await expect(panel.getByRole('button', { name: 'Resume monitoring', exact: true })).toBeDisabled();
});
test('last hour and last 24 hours use real API ranges and isolate the check-history cache', async ({ page }) => {
  const reads: string[] = []; page.on('request', request => { if (request.method() === 'GET' && request.url().includes('/uptime')) reads.push(request.url()); });
  const writes = await fixture(page); await page.goto('/customer/overview'); const panel = page.getByRole('region', { name: 'Uptime monitoring' });
  await expect(panel.getByText('75.00%', { exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'View check history' }).click();
  for (const [value, hours] of [['1h', '1'], ['24h', '24']] as const) {
    await page.getByLabel('Monitoring history window').selectOption(value);
    await expect(panel.getByRole('img', { name: new RegExp(`Last ${hours} hour`) })).toBeVisible();
    await expect.poll(() => reads.some(url => new URL(url).pathname.endsWith('/uptime') && new URL(url).searchParams.get('hours') === hours)).toBe(true);
    await expect.poll(() => reads.some(url => new URL(url).pathname.endsWith('/uptime/history') && new URL(url).searchParams.get('hours') === hours)).toBe(true);
  }
  expect(writes).toEqual([]);
});
test('saving is explicit, check-now only queues work, and switching never keeps another website settings draft', async ({ page }) => {
  const writes = await fixture(page); await page.goto('/customer/overview'); const panel = page.getByRole('region', { name: 'Uptime monitoring' });
  await panel.getByText('Monitoring & email settings', { exact: true }).click(); await page.getByLabel('Check frequency').selectOption('15'); await page.getByLabel('Monitoring emails for my account').uncheck(); expect(writes).toEqual([]);
  await panel.getByRole('button', { name: 'Save monitoring settings' }).click(); await expect(panel.getByText(/Monitoring settings saved/)).toBeVisible(); expect(writes[0]).toEqual({ path: `/v1/websites/${first}/monitoring`, body: { enabled: true, intervalMinutes: 15, emailAlerts: false } });
  await panel.getByRole('button', { name: 'Check now' }).click(); await expect(panel.getByText(/Check queued/)).toBeVisible(); expect(writes).toHaveLength(2);
  await page.getByLabel('Switch website').selectOption(second); await expect(panel.getByText('Paused', { exact: true })).toBeVisible(); await expect(panel.getByText(/Check queued/)).toHaveCount(0); await expect(panel.getByText('75.00%', { exact: true })).toHaveCount(0);
});
test('unsafe and failed monitors never invent 100% uptime, with stale warning and reduced-motion support', async ({ page }) => {
  await fixture(page, { noSamples: true, eligible: false }); await page.goto('/customer/overview'); const panel = page.getByRole('region', { name: 'Uptime monitoring' });
  await expect(panel.getByText('No checks yet', { exact: true })).toBeVisible(); await expect(panel.getByText('100.00%', { exact: true })).toHaveCount(0); await panel.getByText('Monitoring & email settings', { exact: true }).click(); await expect(page.getByLabel('Enable website monitoring')).toBeDisabled();
  await page.unroute('**/v1/**'); await fixture(page, { state: 'STALE' }); await page.reload(); await expect(panel.getByText(/latest check is overdue/)).toBeVisible();
  await page.emulateMedia({ reducedMotion: 'reduce' }); expect(await panel.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.unroute('**/v1/**'); await fixture(page, { failure: true }); await page.reload(); await expect(panel.getByText('Status unavailable', { exact: true })).toBeVisible(); await expect(panel.getByText('75.00%', { exact: true })).toHaveCount(0); await expect(panel.getByRole('button', { name: 'Retry monitoring' })).toBeVisible();
});
test('a newly added disconnected website can opt into HTTP uptime without SSH or connector writes', async ({ page }) => {
  const writes = await fixture(page, { noSamples: true, disconnected: true }); await page.goto('/customer/overview');
  const panel = page.getByRole('region', { name: 'Uptime monitoring' });
  await expect(panel.getByText('Paused', { exact: true })).toBeVisible();
  await expect(panel.getByText(/no SSH or platform connection needed/)).toBeVisible();
  expect(writes).toEqual([]);
  await panel.getByText('Monitoring & email settings', { exact: true }).click();
  const toggle = page.getByLabel('Enable website monitoring'); await expect(toggle).toBeEnabled(); await expect(toggle).not.toBeChecked();
  await toggle.check(); expect(writes).toEqual([]);
  await panel.getByRole('button', { name: 'Save monitoring settings' }).click();
  await expect(panel.getByText(/Monitoring settings saved/)).toBeVisible();
  expect(writes).toEqual([{ path: `/v1/websites/${first}/monitoring`, body: { enabled: true, intervalMinutes: 5, emailAlerts: true } }]);
  await panel.getByRole('button', { name: 'Check now' }).click();
  await expect(panel.getByText(/Check queued/)).toBeVisible();
  expect(writes.map(item => item.path)).toEqual([`/v1/websites/${first}/monitoring`, `/v1/websites/${first}/monitoring/checks`]);
});
test('scheduler failure refreshes the paused state and never claims activation', async ({ page }) => {
  const writes = await fixture(page, { noSamples: true, saveFailure: true }); await page.goto('/customer/overview'); const panel = page.getByRole('region', { name: 'Uptime monitoring' });
  await panel.getByText('Monitoring & email settings', { exact: true }).click(); await page.getByLabel('Enable website monitoring').check(); await panel.getByRole('button', { name: 'Save monitoring settings' }).click();
  await expect(panel.getByRole('alert').filter({ hasText: 'Monitoring could not be scheduled' })).toBeVisible(); await expect(panel.getByText('Paused', { exact: true })).toBeVisible(); await expect(panel.getByText(/Monitoring settings saved/)).toHaveCount(0); expect(writes).toHaveLength(1);
});
test('a failed refresh never leaves a cached green Up status visible', async ({ page }) => {
  const options = { failure: false }; await fixture(page, options); await page.goto('/customer/overview');
  const panel = page.getByRole('region', { name: 'Uptime monitoring' }); await expect(panel).toHaveAttribute('data-uptime-state', 'UP');
  options.failure = true; await panel.getByRole('button', { name: 'Check now' }).click();
  await expect(panel.getByText('Status unavailable', { exact: true })).toBeVisible(); await expect(panel).toHaveAttribute('data-uptime-state', 'UNKNOWN');
  await expect(panel.getByText('75.00%', { exact: true })).toHaveCount(0);
});
