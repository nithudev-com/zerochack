import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const id = 'd33690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const checked = '2026-10-10T11:00:00Z';
const site = { id, name: 'Nithudev', url: 'https://nithudev.example/', connectionStatus: 'VERIFIED', securityStatus: 'UNKNOWN', monitoringStatus: 'NOT_CONFIGURED', backupStatus: 'NOT_CONFIGURED', lastScanAt: null, _count: { findings: 0 } };
async function fixture(page: Page, summary: unknown = { kind: 'NONE', providers: [], lastCheckedAt: null }) {
  const writes: string[] = [];
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (route.request().method() !== 'GET') writes.push(path);
    const body = path === '/v1/auth/me' ? { roles: ['Customer'] } : path === '/v1/websites' ? [{ ...site, ...(summary === undefined ? {} : { connectionSummary: summary }) }] : path === `/v1/websites/${id}` ? site : [];
    await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return writes;
}
for (const width of [320, 390, 1440]) test(`website card and five under-construction tools work accessibly at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); const writes = await fixture(page); await page.goto('/customer/websites');
  await expect(page.getByRole('heading', { name: site.name, exact: true })).toBeVisible();
  await expect(page.locator('[data-connection="disconnected"]')).toHaveText('○Not connected');
  // The Tools modal has its own Security option; only the obsolete card rows must be absent.
  for (const label of ['Security', 'Monitoring', 'Backups', 'Last scan', 'Open issues']) await expect(page.locator('.website-grid').getByText(label, { exact: true })).toHaveCount(0);
  const open = page.getByRole('link', { name: 'Open workspace', exact: true }); await expect(open).toHaveAttribute('href', `/customer/websites/${id}/services`);
  const tools = page.getByRole('button', { name: 'Tools', exact: true }); await expect(tools).toHaveCSS('background-color', 'rgb(21, 128, 61)'); await tools.click();
  const dialog = page.getByRole('dialog', { name: 'Website tools' }); await expect(dialog).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/tmp/codebandage-website-tools-${width}.png`, fullPage: true });
  for (const name of ['SEO', 'Security', 'Automation', 'Marketing', 'Chat Agent']) {
    const choice = dialog.locator(`[data-tool="${name}"]`); await expect(choice).toContainText('Under construction'); await choice.click();
    await expect(dialog.getByRole('heading', { name: `${name} · Under construction` })).toBeFocused();
    await expect(dialog.getByText(/no work has started/)).toBeVisible();
    if (name === 'Security' && width === 390) await page.screenshot({ path: '/tmp/codebandage-tool-construction-390.png', fullPage: true });
    await dialog.getByRole('button', { name: 'All tools' }).click(); await expect(choice).toBeFocused();
  }
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(tools).toBeFocused();
  await tools.click(); await expect(dialog.locator('[data-tool]')).toHaveCount(5); await dialog.getByRole('button', { name: 'Close dialog' }).click();
  expect(writes).toEqual([]); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/tmp/codebandage-website-card-${width}.png`, fullPage: true });
});
for (const row of [
  { kind: 'SSH', providers: ['ssh'], lastCheckedAt: checked, color: 'ssh', text: 'SSH connected' },
  { kind: 'CONNECTOR', providers: ['wordpress', 'joomla'], lastCheckedAt: checked, color: 'connector', text: 'WordPress, Joomla connected' },
  { kind: 'SSH', providers: ['ssh'], lastCheckedAt: null, color: 'disconnected', text: 'Not connected' },
  { kind: 'CONNECTOR', providers: [], lastCheckedAt: checked, color: 'disconnected', text: 'Not connected' }
] as const) test(`website card uses ${row.color} for ${row.kind} (${row.lastCheckedAt ?? 'unchecked'})`, async ({ page }) => {
  await fixture(page, row); await page.goto('/customer/websites');
  const badge = page.locator(`[data-connection="${row.color}"]`); await expect(badge).toContainText(row.text);
  await expect(badge).toHaveCSS('background-color', { ssh: 'rgb(240, 253, 244)', connector: 'rgb(254, 252, 232)', disconnected: 'rgb(255, 241, 242)' }[row.color]);
  if (row.color === 'connector') await expect(badge).toContainText('read access only');
});
test('missing connection metadata is unknown, not a false disconnected or connected claim', async ({ page }) => {
  await fixture(page, null); await page.goto('/customer/websites');
  await expect(page.locator('[data-connection="unknown"]')).toContainText('Connection status unavailable');
});
test('keyboard focus stays inside the tools modal and returns to its trigger', async ({ page }) => {
  await fixture(page); await page.goto('/customer/websites'); const tools = page.getByRole('button', { name: 'Tools', exact: true });
  await tools.focus(); await page.keyboard.press('Enter'); const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  for (let index = 0; index < 12; index++) { await page.keyboard.press('Tab'); expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true); }
  await page.keyboard.press('Escape'); await expect(tools).toBeFocused();
});
