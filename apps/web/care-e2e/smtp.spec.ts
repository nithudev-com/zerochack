import { expect, test } from '@playwright/test';

for (const width of [390, 1280]) {
  test(`Owner SMTP settings are editable and secrets stay write-only at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    let settings = { host: 'smtp.hostinger.com', port: 465, user: 'owner@example.test', from: 'owner@example.test', fromName: 'CodeBandage', passwordSet: true, source: 'server', revision: 'environment', testRecipient: 'owner@example.test' };
    const saved: Array<Record<string, unknown>> = []; const checks: string[] = [];
    await page.route('**/v1/**', async route => {
      const url = new URL(route.request().url()); const method = route.request().method();
      const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, PUT, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
      if (method === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
      let body: unknown = {};
      if (url.pathname === '/v1/auth/me') body = { roles: ['Owner'], mfaVerified: true };
      else if (url.pathname === '/v1/owner/smtp') {
        if (method === 'PUT') { const input = route.request().postDataJSON(); saved.push(input); settings = { ...settings, fromName: input.fromName, source: 'owner', revision: `fixture-${saved.length}` }; }
        body = settings;
      } else if (url.pathname.startsWith('/v1/owner/smtp/')) { checks.push(url.pathname); body = { message: 'Synthetic check completed; no real email sent.' }; }
      await route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('/owner/smtp-settings');
    await expect(page.getByRole('heading', { name: 'SMTP Settings', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Owner navigation' }).getByRole('link', { name: /SMTP Settings/ })).toBeVisible();
    const password = page.getByLabel('SMTP password', { exact: true }); await expect(password).toHaveValue(''); await expect(password).toHaveAttribute('type', 'password');
    await expect(page.getByRole('button', { name: 'Send test email to me' })).toBeDisabled();
    await page.getByLabel('Sender display name', { exact: true }).fill('Updated CodeBandage');
    await page.getByRole('button', { name: 'Verify and save SMTP' }).click();
    await expect(page.getByText('Saved Owner SMTP settings are active', { exact: true })).toBeVisible();
    expect(saved).toHaveLength(1); expect(saved[0]).not.toHaveProperty('password'); await expect(password).toHaveValue('');
    await password.fill('Synthetic-new-mail-password9!');
    await page.getByRole('button', { name: 'Verify and save SMTP' }).click();
    await expect(password).toHaveValue(''); expect(saved).toHaveLength(2); expect(saved[1]?.password).toBe('Synthetic-new-mail-password9!');
    await expect(page.getByText('Synthetic-new-mail-password9!', { exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Verify saved connection' }).click();
    await expect(page.getByText('Synthetic check completed; no real email sent.')).toBeVisible();
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: 'Send test email to me' }).click();
    await expect(page.getByRole('checkbox')).not.toBeChecked(); expect(checks).toEqual(['/v1/owner/smtp/verify', '/v1/owner/smtp/test']);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `/tmp/codebandage-smtp-${width}.png`, fullPage: true });
  });
}

test('SMTP API failure shows an actionable MFA message without exposing a password', async ({ page }) => {
  await page.route('**/v1/**', async route => {
    const owner = route.request().url().includes('/auth/me');
    await route.fulfill({ status: owner ? 200 : 403, headers: { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true' }, contentType: 'application/json', body: JSON.stringify(owner ? { roles: ['Owner'], mfaVerified: true } : { error: { code: 'MFA_REQUIRED', message: 'Recent multi-factor authentication is required' } }) });
  });
  await page.goto('/owner/smtp-settings');
  await expect(page.getByText('Recent multi-factor authentication is required')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in again', exact: true })).toBeVisible();
  await expect(page.getByLabel('SMTP password', { exact: true })).toHaveCount(0);
});
