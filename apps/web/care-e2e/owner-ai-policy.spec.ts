import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
async function fixture(page: Page, denied = false) {
  let policy: Record<string, unknown> | null = null;
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  await page.route('**/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(request.headers().origin ?? (process.env.CARE_WEB_PRODUCTION === 'true' ? 'http://127.0.0.1:3510' : 'http://127.0.0.1:3107')).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,PUT,PATCH,OPTIONS', 'content-type': 'application/json' };
    const send = (value: unknown, status = 200) => route.fulfill({ status, headers, body: JSON.stringify(value) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (path.endsWith('/auth/me')) return send({ roles: ['Owner'], mfaVerified: true });
    if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() });
    if (path === '/v1/owner/ai/providers') return send([{ id, name: 'Claude fixture', adapterKey: 'anthropic-messages', enabled: false, healthStatus: 'UNKNOWN', requestsPerMinute: 6, maxConcurrent: 1, credentials: [{ id: 'credential', label: 'Saved key', enabled: true, healthStatus: 'UNKNOWN', keyVersion: 1 }], models: [] }]);
    if (path === '/v1/owner/ai/tenants') return denied ? send({ error: { code: 'MFA_REQUIRED', message: 'Recent Owner MFA required' } }, 403) : send([{ id, name: 'Kavi fixture', aiPolicy: policy }, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Other fixture', aiPolicy: null }]);
    if (path.endsWith('/policy')) { policy = { ...request.postDataJSON(), updatedAt: new Date().toISOString() }; return send(policy); }
    if (path.endsWith('/models')) return send({}, 201);
    return send([]);
  });
  return writes;
}

test('saved key does not auto-enable a tenant; Owner can save a bounded policy then disable it', async ({ page }) => {
  const writes = await fixture(page); await page.goto('/owner/ai-gateway');
  await expect(page.getByRole('heading', { name: 'Tenant AI access' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save tenant AI policy' })).toHaveCount(0); expect(writes).toEqual([]);
  await page.getByLabel('Customer organization').selectOption(id);
  await expect(page.getByLabel('Enable AI for Kavi fixture')).not.toBeChecked();
  await page.getByLabel('Enable AI for Kavi fixture').check();
  await expect(page.getByLabel('Estimated daily spending threshold (USD)')).toHaveValue('1');
  await expect(page.getByLabel('Concurrent requests', { exact: true })).toHaveValue('1');
  await page.getByRole('button', { name: 'Save tenant AI policy' }).click();
  await expect.poll(() => writes.length).toBe(1); expect(writes[0]).toEqual({ path: `/v1/owner/ai/tenants/${id}/policy`, body: { enabled: true, dailyCostLimitMicros: 1_000_000, requestsPerMinute: 6, requestsPerUserMinute: 3, maxConcurrent: 1 } });
  await expect(page.getByRole('option', { name: 'Kavi fixture — AI enabled' })).toHaveCount(1);
  await page.getByLabel('Enable AI for Kavi fixture').uncheck(); await page.getByRole('button', { name: 'Save tenant AI policy' }).click();
  await expect.poll(() => writes.length).toBe(2); expect(writes[1]!.body.enabled).toBe(false);
});
test('positive budget required for enabling, tenant switching resets drafts, model prices cannot default to zero', async ({ page }) => {
  const writes = await fixture(page); await page.goto('/owner/ai-gateway'); await page.getByLabel('Customer organization').selectOption(id);
  await page.getByLabel('Enable AI for Kavi fixture').check(); await page.getByLabel('Estimated daily spending threshold (USD)').fill('0');
  await expect(page.getByRole('button', { name: 'Save tenant AI policy' })).toBeDisabled();
  await page.getByLabel('Customer organization').selectOption('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  await expect(page.getByLabel('Enable AI for Other fixture')).not.toBeChecked(); await expect(page.getByLabel('Estimated daily spending threshold (USD)')).toHaveValue('1');
  await expect(page.getByLabel('Provider model ID')).toHaveValue(''); await page.getByLabel('Provider model ID').fill('claude-synthetic-fixture'); await expect(page.getByRole('button', { name: 'Add model', exact: true })).toBeDisabled();
  await page.getByLabel('Input price (USD per million tokens)').fill('2'); await page.getByLabel('Output price (USD per million tokens)').fill('10'); await page.getByRole('button', { name: 'Add model', exact: true }).click();
  await expect.poll(() => writes.length).toBe(1); expect(writes[0]!.body).toMatchObject({ providerModel: 'claude-synthetic-fixture', inputCostMicrosPerM: 2_000_000, outputCostMicrosPerM: 10_000_000, maxConcurrent: 1, maxOutputTokens: 1024 });
});
test('MFA failure does not show an editable tenant policy', async ({ page }) => {
  const writes = await fixture(page, true); await page.goto('/owner/ai-gateway'); await expect(page.getByText('Recent Owner MFA required')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save tenant AI policy' })).toHaveCount(0); expect(writes).toEqual([]);
});
for (const width of [390, 1440]) test(`tenant policy is accessible at ${width}px`, async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width, height: 900 }); await page.goto('/owner/ai-gateway'); await page.getByLabel('Customer organization').selectOption(id);
  expect((await new AxeBuilder({ page }).include('[aria-label="AI access for Kavi fixture"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.screenshot({ path: `/tmp/owner-ai-policy-${width}.png`, fullPage: true });
});
