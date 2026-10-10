import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { websiteServices } from '../lib/website-services';

const id = 'd33690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const base = `/customer/websites/${id}`;
const site = { id, name: 'Service fixture', url: 'https://example.test/', normalizedHost: 'example.test', connectionStatus: 'PENDING', securityStatus: 'UNKNOWN', monitoringStatus: 'NOT_CONFIGURED', backupStatus: 'NOT_CONFIGURED', lastScanAt: null, findings: [], scans: [], tickets: [], backups: [], reports: [], _count: { findings: 0 } };
async function fixture(page: Page, options: { supportFailure?: boolean; missingSite?: boolean } = {}) {
  const writes: { path: string; data: Record<string, unknown> }[] = [];
  await page.route('**/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (request.method() !== 'GET') writes.push({ path, data: request.postDataJSON() });
    let body: unknown = {}; let status = 200;
    if (path === '/v1/auth/me') body = { roles: ['Customer'] };
    else if (path === '/v1/websites' && request.method() === 'GET') body = [site];
    else if (path === '/v1/websites' && request.method() === 'POST') body = site;
    else if (path === `/v1/websites/${id}`) { body = options.missingSite ? { error: { code: 'NOT_FOUND', message: 'Website not found.' } } : site; if (options.missingSite) status = 404; }
    else if (path.endsWith('/care')) { status = 403; body = { error: { code: 'CAPABILITY_DISABLED', message: 'Care is disabled for this deployment.' } }; }
    else if (path.endsWith('/chat') || path === '/v1/notifications') body = [];
    else if (path === '/v1/support/conversations') { status = options.supportFailure ? 503 : 201; body = options.supportFailure ? { error: { code: 'UNAVAILABLE', message: 'Support could not save this request. Check your conversation list before retrying.' } } : { id: 'a33690a6-6d5e-4f7b-9e86-5f8f7913d2ea' }; }
    await route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return writes;
}

for (const width of [320, 390, 1440]) test(`Open workspace shows seven accessible service choices before chat at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); const writes = await fixture(page);
  await page.goto('/customer/websites'); await page.getByRole('link', { name: 'Open workspace', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`${base}/services$`));
  await expect(page.getByRole('heading', { name: 'What do you need help with?' })).toBeVisible();
  await expect(page.getByRole('radio')).toHaveCount(7);
  await expect(page.getByRole('button', { name: 'Next: open workspace' })).toBeDisabled();
  for (const service of websiteServices) await expect(page.getByRole('radio', { name: new RegExp(service.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })).toBeVisible();
  await expect(page.getByLabel('Message CodeBandage')).toHaveCount(0); expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/tmp/codebandage-services-${width}.png`, fullPage: true });
});

for (const service of websiteServices) test(`${service.label} opens its own scoped form and saves the correct service without starting jobs`, async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); const writes = await fixture(page);
  await page.goto(`${base}/services`);
  await page.getByRole('radio', { name: new RegExp(service.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).check();
  expect(writes).toEqual([]); await page.getByRole('button', { name: 'Next: open workspace' }).click();
  await expect(page).toHaveURL(`${base}?service=${service.id}`);
  await expect(page.getByRole('heading', { name: `${service.label} workspace`, exact: true })).toBeVisible();
  expect(await page.locator('.care-composer').evaluate(element => getComputedStyle(element).position)).toBe('static');
  const goalField = page.getByLabel('Requested work', { exact: true });
  await goalField.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  await expect.poll(() => goalField.evaluate(element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element; })).toBe(true);
  const form = page.getByRole('form', { name: 'Website task brief' });
  await expect(form.getByText(service.hint, { exact: false })).toBeVisible();
  await expect(page.getByLabel('How should we verify success?')).toHaveAttribute('placeholder', service.success);
  expect(writes).toEqual([]); const submit = page.getByRole('button', { name: 'Save request for human review' }); await expect(submit).toBeDisabled();
  await page.getByLabel('Requested work', { exact: true }).fill(`Plan this ${service.id} task for the authorized fixture website.`);
  await page.getByLabel('How should we verify success?').fill('Review the agreed scope and record bounded acceptance checks before any release.');
  await page.getByLabel('I reviewed this brief').check(); await submit.click();
  await expect(page.getByRole('status').filter({ hasText: 'Request saved in Support' })).toBeVisible();
  expect(writes).toHaveLength(1); expect(writes[0]!.path).toBe('/v1/support/conversations');
  expect(writes[0]!.data.subject).toBe(`${service.name}: Service fixture`);
  expect(writes[0]!.data.message).toContain(`Service: ${service.id} · ${service.label}`);
  expect(writes[0]!.data.message).toContain(`Website ID: ${id}`); expect(writes[0]!.data.message).toContain('Environment: PRODUCTION');
  expect(writes[0]!.data.message).toContain('No permission to execute code');
  await expect(page.getByLabel('Requested work', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('adding a website continues to service selection and does not create a task', async ({ page }) => {
  const writes = await fixture(page); await page.goto('/customer/websites');
  await page.getByLabel('Website name', { exact: true }).fill('New fixture'); await page.getByLabel('Website URL', { exact: true }).fill('https://example.test/');
  await page.getByRole('button', { name: 'Add and continue' }).click();
  await expect(page).toHaveURL(`${base}/services`); expect(writes.map(row => row.path)).toEqual(['/v1/websites']);
});

test('service choice survives resource navigation/reload while unsent drafts and consent do not', async ({ page }) => {
  const writes = await fixture(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}?service=seo`);
  await page.getByLabel('Requested work', { exact: true }).fill('Unsent SEO scope should not follow a service change.');
  await page.getByLabel('I reviewed this brief').check(); await page.getByRole('link', { name: 'Saved reports →', exact: true }).click();
  await expect(page).toHaveURL(`${base}/reports?service=seo`); await page.getByRole('link', { name: '← Back to conversation' }).click();
  await expect(page.getByLabel('Requested work', { exact: true })).toHaveValue(''); await expect(page.getByLabel('I reviewed this brief')).not.toBeChecked();
  await page.reload(); await expect(page.getByRole('heading', { name: 'SEO work workspace' })).toBeVisible();
  await page.getByRole('link', { name: 'Change service', exact: true }).click(); await expect(page.getByRole('radio', { name: /SEO work/ })).toBeChecked();
  await page.getByRole('radio', { name: /Automation/ }).check(); await page.getByRole('button', { name: 'Next: open workspace' }).click();
  await expect(page.getByRole('heading', { name: 'Automation workspace' })).toBeVisible(); await expect(page.getByLabel('Requested work', { exact: true })).toHaveValue('');
  expect(writes).toEqual([]);
});

test('service forms refuse credentials, clear scope on environment changes, and expose truthful tool gates', async ({ page }) => {
  const writes = await fixture(page); await page.goto(`${base}?service=server`);
  await page.getByLabel('Requested work', { exact: true }).fill('password: synthetic-service-test-only');
  await page.getByLabel('How should we verify success?').fill('Bounded fixture checks with no production writes.');
  await page.getByLabel('I reviewed this brief').check(); await page.getByRole('button', { name: 'Save request for human review' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This appears to contain access information' })).toBeVisible();
  expect(writes).toEqual([]); await page.getByLabel('Environment', { exact: true }).selectOption('STAGING');
  await expect(page.getByLabel('Requested work', { exact: true })).toHaveValue(''); await expect(page.getByLabel('I reviewed this brief')).not.toBeChecked();
  await page.getByText('Tools & availability', { exact: true }).click(); await expect(page.getByRole('button', { name: 'Prepare AI source review' })).toBeDisabled();
  await expect(page.getByText(/Care workflows are disabled on this server/)).toBeVisible();
});

test('unsupported service and inaccessible website do not open a task or execute work', async ({ page }) => {
  const writes = await fixture(page); await page.goto(`${base}?service=production-release`);
  await expect(page.getByText('Choose a supported service', { exact: true })).toBeVisible(); await expect(page.getByRole('form', { name: 'Website task brief' })).toHaveCount(0); expect(writes).toEqual([]);
  await page.unroute('**/v1/**'); await fixture(page, { missingSite: true }); await page.goto(`${base}/services`);
  await expect(page.getByRole('alert').filter({ hasText: 'Workspace unavailable' })).toBeVisible(); await expect(page.getByRole('radio')).toHaveCount(0);
});

test('failed request saves preserve the brief and never report success or retry automatically', async ({ page }) => {
  const writes = await fixture(page, { supportFailure: true }); await page.goto(`${base}?service=automation`);
  await page.getByLabel('Requested work', { exact: true }).fill('Plan a scheduled fixture workflow with safe retry limits.');
  await page.getByLabel('How should we verify success?').fill('Only one fixture event and a recorded failure result.');
  await page.getByLabel('I reviewed this brief').check(); await page.getByRole('button', { name: 'Save request for human review' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Check your conversation list before retrying' })).toBeVisible();
  await expect(page.getByLabel('Requested work', { exact: true })).toHaveValue('Plan a scheduled fixture workflow with safe retry limits.');
  await expect(page.getByText('Request saved in Support', { exact: false })).toHaveCount(0); expect(writes).toHaveLength(1);
});

test('keyboard service selection and accessible mobile brief can be cancelled and reopened without retaining drafts', async ({ page }) => {
  const writes = await fixture(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${base}/services`);
  await page.getByRole('radio', { name: /Fix hacks & security/ }).focus(); await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('radio', { name: /Full-stack web development/ })).toBeChecked();
  await page.getByRole('button', { name: 'Next: open workspace' }).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Full-stack web development workspace' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.getByLabel('Requested work', { exact: true }).fill('Unsent fixture brief is never persisted by cancel.');
  await page.getByRole('button', { name: 'Cancel brief', exact: true }).click(); await page.getByRole('button', { name: 'Start service request', exact: true }).click();
  await expect(page.getByLabel('Requested work', { exact: true })).toHaveValue(''); await expect(page.getByLabel('I reviewed this brief')).not.toBeChecked();
  expect(writes).toEqual([]);
  await page.evaluate(() => { document.activeElement instanceof HTMLElement && document.activeElement.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: '/tmp/codebandage-service-workspace-390.png', fullPage: true });
});
