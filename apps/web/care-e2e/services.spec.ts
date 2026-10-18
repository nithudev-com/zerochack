import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { websiteServices } from '../lib/website-services';

const id = 'd33690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const base = `/customer/websites/${id}`;
const site = { id, name: 'Service fixture', url: 'https://example.test/', normalizedHost: 'example.test', connectionStatus: 'PENDING', securityStatus: 'UNKNOWN', monitoringStatus: 'NOT_CONFIGURED', backupStatus: 'NOT_CONFIGURED', lastScanAt: null, findings: [], scans: [], tickets: [], backups: [], reports: [], _count: { findings: 0 } };
async function fixture(page: Page, options: { missingSite?: boolean } = {}) {
  const writes: { path: string; data: Record<string, unknown> }[] = []; const workflowReads: string[] = [];
  await page.route('**/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (/\/(care|chat|jobs|activity\/stream)(\/|$)/.test(path)) workflowReads.push(path);
    if (request.method() !== 'GET') writes.push({ path, data: request.postDataJSON() });
    let body: unknown = {}; let status = 200;
    if (path === '/v1/auth/me') body = { roles: ['Customer'] };
    else if (path === '/v1/websites' && request.method() === 'GET') body = [site];
    else if (path === '/v1/websites' && request.method() === 'POST') body = site;
    else if (path === `/v1/websites/${id}`) { body = options.missingSite ? { error: { code: 'NOT_FOUND', message: 'Website not found.' } } : site; if (options.missingSite) status = 404; }
    else if (path.endsWith('/care')) { status = 403; body = { error: { code: 'CAPABILITY_DISABLED', message: 'Care is disabled for this deployment.' } }; }
    else if (path.endsWith('/chat') || path === '/v1/notifications') body = [];
    await route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return { writes, workflowReads };
}

for (const width of [320, 390, 1440]) test(`Service selection marks six workplaces under construction at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); const { writes } = await fixture(page);
  await page.goto('/customer/websites'); await page.getByRole('link', { name: 'Open workspace', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${base}/services$`));
  await expect(page.getByRole('heading', { name: 'What do you need help with?' })).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(7);
  await expect(page.getByText('Under construction', { exact: true })).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Next: open workspace' })).toBeDisabled();
  for (const service of websiteServices) await expect(page.getByRole('radio', { name: new RegExp(service.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeVisible();
  await expect(page.getByLabel('Message CodeBandage')).toHaveCount(0); expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/tmp/codebandage-coming-soon-services-${width}.png`, fullPage: true });
});

for (const service of websiteServices.filter(item => item.id !== 'security')) test(`${service.label} is coming soon after selection, reload and bookmarked resource, without workflow calls`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const { writes, workflowReads } = await fixture(page);
  await page.goto(`${base}/services`);
  await page.getByRole('radio', { name: new RegExp(service.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).check();
  await page.getByRole('button', { name: 'Next: view details' }).click();
  await expect(page).toHaveURL(`${base}?service=${service.id}`);
  for (const destination of [null, `${base}?service=${service.id}`, `${base}/access?service=${service.id}`]) {
    if (destination) await page.goto(destination);
    await expect(page.getByRole('heading', { name: service.label, exact: true })).toBeVisible();
    await expect(page.getByText('Under construction', { exact: true })).toBeVisible();
    await expect(page.getByText('This workplace is coming soon. We’re developing it for you.')).toBeVisible();
    await expect(page.getByRole('form', { name: 'Website task brief' })).toHaveCount(0);
    await expect(page.getByLabel('Message CodeBandage')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Save request for human review' })).toHaveCount(0);
  }
  await page.reload(); await expect(page.getByRole('heading', { name: service.label, exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Change service', exact: true }).click();
  await expect(page.getByRole('radio', { name: new RegExp(service.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeChecked();
  expect(writes).toEqual([]); expect(workflowReads).toEqual([]);
});

test('adding a website still continues to service selection without creating a task', async ({ page }) => {
  const { writes } = await fixture(page); await page.goto('/customer/websites');
  await page.getByLabel('Website name', { exact: true }).fill('New fixture'); await page.getByLabel('Website URL', { exact: true }).fill('https://example.test/');
  await page.getByRole('button', { name: 'Add and continue' }).click();
  await expect(page).toHaveURL(`${base}/services`); expect(writes.map(row => row.path)).toEqual(['/v1/websites']);
});

test('unsupported service and inaccessible website cannot open a preview or execute work', async ({ page }) => {
  const { writes } = await fixture(page); await page.goto(`${base}?service=production-release`);
  await expect(page.getByText('Choose a supported service', { exact: true })).toBeVisible(); expect(writes).toEqual([]);
  await page.unroute('**/v1/**'); await fixture(page, { missingSite: true }); await page.goto(`${base}?service=seo`);
  await expect(page.getByRole('alert').filter({ hasText: 'This website workspace is unavailable for your account.' })).toBeVisible();
  await expect(page.getByText('Under construction', { exact: true })).toHaveCount(0);
});

test('keyboard selection opens an accessible mobile coming-soon preview with a selected-website return link', async ({ page }) => {
  const { writes } = await fixture(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}/services`);
  await page.getByRole('radio', { name: /Fix hacks & security/ }).focus(); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: /Full-stack web development/ })).toBeChecked();
  await page.getByRole('button', { name: 'Next: view details' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Full-stack web development', exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await expect(page.getByRole('link', { name: '← Back to Overview' })).toHaveAttribute('href', `/customer/overview?website=${id}`);
  expect(writes).toEqual([]);
  await page.screenshot({ path: '/tmp/codebandage-coming-soon-workplace-390.png', fullPage: true });
});
