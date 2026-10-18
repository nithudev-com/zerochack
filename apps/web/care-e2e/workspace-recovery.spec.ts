import { expect, test } from '@playwright/test';

const id = '21f586dc-d1d5-4b46-bb17-5422468e8699';
test('background workspace 429 retains the conversation and draft, respects its wait, then recovers', async ({ page }) => {
  await page.clock.install();
  let websiteReads = 0; let limit = false; const writes: string[] = [];
  await page.route('**/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'retry-after', 'access-control-allow-methods': 'GET, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (request.method() !== 'GET') writes.push(path);
    if (path === '/v1/auth/me') return route.fulfill({ headers, json: { roles: ['Customer'] } });
    if (path === `/v1/websites/${id}`) {
      websiteReads++;
      if (limit) return route.fulfill({ status: 429, headers: { ...headers, 'retry-after': '17' }, json: { error: { code: 'RATE_LIMITED', message: 'Wait 17 seconds' } } });
      return route.fulfill({ headers, json: { id, name: 'Recovery fixture', url: 'https://example.test' } });
    }
    if (path.endsWith('/access')) return route.fulfill({ headers, json: { status: 'READY_FOR_SECURE_SESSION', secretStored: true, lastCheckedAt: new Date().toISOString(), lastErrorCode: null, authorizationExpiresAt: null } });
    if (path.endsWith('/care')) return route.fulfill({ headers, json: { capabilities: { secureCapture: true }, jobs: [], accessRequests: [] } });
    if (path.endsWith('/assessment')) return route.fulfill({ headers, json: { scan: null } });
    if (path.endsWith('/chat')) return route.fulfill({ headers, json: [{ id: 'saved', type: 'AI', content: 'Your saved conversation stays here.', createdAt: new Date().toISOString() }] });
    return route.fulfill({ headers, json: [] });
  });
  await page.goto(`/customer/websites/${id}?service=security`);
  const input = page.getByLabel('Message CodeBandage', { exact: true });
  await input.fill('Keep this draft while updates pause.');
  limit = true; await page.clock.fastForward(30_100);
  const recovery = page.getByRole('region', { name: 'Workspace connection status' });
  await expect(recovery).toContainText('Updates are taking a short pause.');
  await expect(recovery.getByRole('button', { name: 'Retry updates' })).toBeDisabled();
  await expect(input).toHaveValue('Keep this draft while updates pause.');
  await expect(page.getByText('Your saved conversation stays here.', { exact: true })).toBeVisible();
  const pausedCount = websiteReads;
  await page.clock.fastForward(16_000); expect(websiteReads).toBe(pausedCount);
  limit = false; await page.clock.fastForward(2000);
  await expect(recovery).toHaveCount(0); expect(websiteReads).toBe(pausedCount + 1);
  await expect(input).toHaveValue('Keep this draft while updates pause.'); expect(writes).toEqual([]);
});
