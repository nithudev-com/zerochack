import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { websiteServices } from '../lib/website-services';

const id = 'e43690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const base = `/customer/websites/${id}`;
async function fixture(page: Page) {
  const writes: string[] = [];
  await page.route('**/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (request.method() !== 'GET') writes.push(path);
    if (path.endsWith('/care')) return route.fulfill({ status: 403, headers, json: { error: { code: 'CAPABILITY_DISABLED', message: 'Care is disabled.' } } });
    const body = path.endsWith('/auth/me') ? { roles: ['Customer'] } : path === `/v1/websites/${id}` ? { id, name: 'Nithudev fixture', url: 'https://example.test/', connectionStatus: 'PENDING', findings: [], scans: [], tickets: [], backups: [], reports: [] } : [];
    await route.fulfill({ headers, json: body });
  });
  return writes;
}

for (const width of [320, 390, 1440]) test(`all-in-one workbench is accessible, honest and unobstructed at ${width}px`, async ({ page }) => {
  const writes = await fixture(page); await page.setViewportSize({ width, height: 844 }); await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Your all-in-one website assistant' })).toBeVisible();
  await expect(page.getByText('Connection: pending', { exact: true })).toBeVisible();
  const cards = page.getByLabel('Website work types');
  await expect(cards.getByRole('button')).toHaveCount(7);
  expect(await page.locator('.care-composer').evaluate(element => getComputedStyle(element).position)).toBe('static');
  await page.getByRole('button', { name: 'Full-stack web development', exact: true }).click();
  const goal = page.getByLabel('Requested work', { exact: true });
  await goal.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect.poll(() => goal.evaluate(element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element; })).toBe(true);
  await page.getByRole('button', { name: 'Cancel brief', exact: true }).click();
  await expect(page.getByText('Execution workflows are not enabled.', { exact: false })).toBeVisible();
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    expect((await new AxeBuilder({ page }).include('.care-chat').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.evaluate(() => { document.activeElement instanceof HTMLElement && document.activeElement.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
    await page.screenshot({ path: `/tmp/codebandage-workbench-${width}-${theme}.png`, fullPage: true });
  }
  expect(writes).toEqual([]);
});

test('work cards open scoped briefs, while security opens simple chat without starting a job', async ({ page }) => {
  const writes = await fixture(page); await page.goto(base);
  for (const service of websiteServices) {
    await page.getByRole('button', { name: service.label, exact: true }).click();
    if (service.id === 'security') {
      await expect(page.getByRole('region', { name: 'Security recovery conversation' })).toBeVisible();
      await expect(page.getByRole('form', { name: 'Website task brief' })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Connect SSH securely' })).toBeVisible();
      await page.goto(base); continue;
    }
    const form = page.getByRole('form', { name: 'Website task brief' });
    await expect(form.getByRole('heading', { name: service.name, exact: true })).toBeVisible();
    await expect(page.getByLabel('How should we verify success?')).toHaveAttribute('placeholder', service.success);
    await expect(page.getByRole('button', { name: 'Save request for human review' })).toBeDisabled();
    await page.getByRole('button', { name: 'Cancel brief', exact: true }).click();
  }
  expect(writes).toEqual([]);
});

test('starter prompts only prepare editable drafts and never make paid or execution requests', async ({ page }) => {
  const writes = await fixture(page); await page.goto(base);
  for (const [label, expected] of [['Plan a feature', 'frontend, backend'], ['Improve a design', 'mobile layout'], ['Troubleshoot a bug', 'steps to reproduce']] as const) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByLabel('Message CodeBandage')).toHaveValue(new RegExp(expected!));
    await expect(page.getByRole('button', { name: 'Send ↑', exact: true })).toBeEnabled();
  }
  expect(writes).toEqual([]);
});

test('workspace controls disclose unavailable tools and preserve secure capture consent', async ({ page }) => {
  const writes = await fixture(page); await page.goto(base);
  const options = page.locator('details').filter({ has: page.getByText('Workspace controls', { exact: true }) });
  await expect(options).not.toHaveAttribute('open', '');
  await page.getByText('Workspace controls', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Report an issue', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Recovery readiness', exact: true })).toBeDisabled();
  await page.getByLabel('Reduce motion', { exact: true }).check();
  await expect(page.locator('.care-chat')).toHaveAttribute('data-reduce-motion', 'true');
  await page.getByRole('button', { name: 'Message assistant' }).click();
  await page.getByLabel('Secure access details').fill('Password: synthetic-workbench-test-marker');
  await expect(page.getByRole('button', { name: 'Store securely' })).toBeDisabled();
  await page.getByLabel('Environment', { exact: true }).selectOption('STAGING');
  await expect(page.getByLabel('Secure access details')).toHaveValue('');
  await expect(page.getByLabel('I’m authorized to provide')).not.toBeChecked();
  expect(writes).toEqual([]);
});
