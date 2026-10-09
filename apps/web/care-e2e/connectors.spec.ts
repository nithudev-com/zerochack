import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const websiteId = '9c3b4431-28e3-4c3b-9ce4-176ef56ff0ed';
const adapters = [
  { provider: 'wordpress', name: 'WordPress', researchId: 1, usernameLabel: 'WordPress username', secretLabel: 'Application Password', scope: 'Read the authenticated user ID.' },
  { provider: 'woocommerce', name: 'WooCommerce', researchId: 87, usernameLabel: 'Consumer key', secretLabel: 'Consumer secret', scope: 'Read at most one product ID.' },
  { provider: 'ghost', name: 'Ghost', researchId: 5, usernameLabel: null, secretLabel: 'Admin API key (id:secret)', scope: 'Read at most one post ID.' },
  { provider: 'directus', name: 'Directus', researchId: 42, usernameLabel: null, secretLabel: 'Static access token', scope: 'Read the authenticated user ID.' }
];
type Saved = { provider: string; endpoint: string; revision: number; status: string; secretStored: boolean; authorizationExpiresAt: string; lastCheckedAt: string | null; lastErrorCode: string | null };
async function fixture(page: Page, verified = true, failure = false) {
  let rows: Saved[] = [];
  await page.route('**/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, PUT, POST, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let body: unknown = {}; let status = 200;
    if (path === '/v1/auth/me') body = { roles: ['Customer'] };
    else if (path === `/v1/websites/${websiteId}`) body = { id: websiteId, name: 'Fixture site', url: 'https://cms.customer.com/', connectionStatus: verified ? 'VERIFIED' : 'PENDING' };
    else if (path === '/v1/connectors/catalog') body = { adapters, research: { research_date: '2026-10-09', platforms: [{ id: 126, platform: 'Wix', category: 'Builder', connection_method: 'OAuth requires a registered app.', required_information: 'Approved app and scopes.', limitations: 'Not server access.', official_sources: ['https://dev.wix.com/'] }] } };
    else if (path.endsWith('/connectors') && request.method() === 'PUT') {
      const input = request.postDataJSON(); expect(input.authorizationConfirmed).toBe(true); expect(input.secret).toBe('abcd efgh ijkl mnop qrst uvwx');
      rows = [{ provider: input.provider, endpoint: input.endpoint, revision: 1, status: 'CONFIGURED', secretStored: true, authorizationExpiresAt: '2026-11-08T00:00:00Z', lastCheckedAt: null, lastErrorCode: null }]; body = rows[0];
    } else if (path.endsWith('/check')) {
      expect(request.postDataJSON().confirm).toBe(true);
      rows[0] = { ...rows[0]!, revision: 2, status: failure ? 'NEEDS_ATTENTION' : 'AUTHENTICATED_READ', lastCheckedAt: '2026-10-09T10:00:00Z', lastErrorCode: failure ? 'AUTH_OR_PERMISSION_DENIED' : null }; body = rows[0];
    } else if (path.endsWith('/wordpress') && request.method() === 'DELETE') { expect(request.postDataJSON()).toMatchObject({ confirm: true, revision: 2 }); rows[0] = { ...rows[0]!, status: 'REVOKED', secretStored: false }; status = 204; }
    else if (path.endsWith('/connectors')) body = rows;
    else if (path === '/v1/notifications') body = [];
    await route.fulfill({ status, headers, ...(status === 204 ? {} : { contentType: 'application/json', body: JSON.stringify(body) }) });
  });
}
async function save(page: Page) {
  await page.getByRole('group', { name: 'Connection methods' }).getByRole('button', { name: /^WordPress/ }).click();
  await page.getByRole('button', { name: 'Set up WordPress', exact: true }).click();
  await page.getByLabel('WordPress username', { exact: true }).fill('reader');
  const secret = page.getByLabel('Application Password', { exact: true }); await expect(secret).toHaveAttribute('type', 'password'); await secret.fill('abcd efgh ijkl mnop qrst uvwx');
  const submit = page.getByRole('button', { name: 'Save encrypted credential' }); await expect(submit).toBeDisabled();
  await page.getByRole('checkbox').check(); await submit.click();
  await expect(page.getByText('Saved · not checked', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Application Password', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Authenticated read succeeded', { exact: true })).toHaveCount(0);
}
for (const width of [320, 390, 1440]) test(`connector save/check/remove and accessible layout at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 }); await fixture(page); await page.goto(`/customer/websites/${websiteId}/connectors`);
  await expect(page.getByRole('heading', { name: 'Connect your platform' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Connection methods' }).getByRole('button')).toHaveCount(5);
  await expect(page.getByLabel('Server host')).toHaveCount(0);
  await page.screenshot({ path: `/tmp/codebandage-connection-picker-${width}.png`, fullPage: true });
  await save(page); await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.getByText('Authenticated read succeeded', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Remove access', exact: true }).click(); await page.getByRole('button', { name: 'Confirm removal' }).click();
  await expect(page.getByText('Access removed', { exact: true })).toBeVisible();
  await page.getByText('150-platform connection guide', { exact: true }).click();
  await page.getByLabel('Search platform guide').fill('Wix'); await page.getByText('Wix · Guide only · not implemented', { exact: true }).click();
  await expect(page.getByText('OAuth requires a registered app.')).toBeVisible(); await expect(page.getByRole('button', { name: /Set up Wix/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/tmp/codebandage-connectors-${width}.png`, fullPage: true });
});
test('failed authentication is not labelled connected', async ({ page }) => {
  await fixture(page, true, true); await page.goto(`/customer/websites/${websiteId}/connectors`); await save(page);
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.getByText('Connection needs attention', { exact: true })).toBeVisible(); await expect(page.getByText('Authenticated read succeeded', { exact: true })).toHaveCount(0);
});
test('unverified websites cannot enter API credentials', async ({ page }) => {
  await fixture(page, false); await page.goto(`/customer/websites/${websiteId}/connectors`);
  await page.getByRole('group', { name: 'Connection methods' }).getByRole('button', { name: /^WordPress/ }).click();
  await expect(page.getByRole('button', { name: 'Set up WordPress', exact: true })).toBeDisabled(); await expect(page.getByText('Ownership verification required', { exact: true })).toBeVisible();
});

test('default access page offers every connector and SSH save never starts an assessment', async ({ page }) => {
  await fixture(page); let checks = 0; let assessments = 0; let stored = false;
  const credential = { host: 'cms.customer.com', port: 22, username: 'deploy', authMethod: 'SSH_KEY', status: 'VERIFIED', secretStored: true, lastErrorCode: null };
  await page.route('**/assessment', route => { assessments++; return route.fulfill({ json: {} }); });
  await page.route('**/v1/websites/*/access', route => { if (route.request().method() === 'PUT') { stored = true; expect(route.request().postDataJSON().authorizationConfirmed).toBe(true); } return route.fulfill({ json: stored ? credential : null }); });
  await page.route('**/access/check', route => { checks++; return route.fulfill({ json: credential }); });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/customer/websites/${websiteId}/access`);
  const methods = page.getByRole('group', { name: 'Connection methods' });
  await expect(methods.getByRole('button')).toHaveCount(5);
  for (const item of adapters) {
    await methods.getByRole('button', { name: new RegExp(`^${item.name}`) }).click();
    await page.getByRole('button', { name: `Set up ${item.name}`, exact: true }).click();
    await expect(page.getByLabel(item.secretLabel, { exact: true })).toHaveAttribute('type', 'password');
  }
  await methods.getByRole('button', { name: /^SSH server/ }).click();
  await page.getByLabel('Server host').fill('cms.customer.com'); await page.getByLabel('SSH username').fill('deploy');
  await page.getByLabel('Private key', { exact: true }).fill('synthetic-ui-key-not-a-real-private-key');
  await page.getByLabel(/I own or administer this server/).check(); await page.getByRole('button', { name: 'Save and check SSH', exact: true }).click();
  await expect(page.getByText('SSH connection checked. No assessment or changes started.', { exact: true })).toBeVisible();
  expect(checks).toBe(1); expect(assessments).toBe(0); await expect(page).toHaveURL(new RegExp(`/access$`));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});

test('switching connectors discards unsaved credentials', async ({ page }) => {
  await fixture(page); await page.goto(`/customer/websites/${websiteId}/access`);
  const methods = page.getByRole('group', { name: 'Connection methods' });
  await methods.getByRole('button', { name: /^WordPress/ }).click(); await page.getByRole('button', { name: 'Set up WordPress', exact: true }).click();
  await page.getByLabel('Application Password', { exact: true }).fill('unsaved-secret-marker');
  await methods.getByRole('button', { name: /^Ghost/ }).click(); await methods.getByRole('button', { name: /^WordPress/ }).click();
  await page.getByRole('button', { name: 'Set up WordPress', exact: true }).click();
  await expect(page.getByLabel('Application Password', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('unsaved-secret-marker');
});
