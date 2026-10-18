import { expect, test } from '@playwright/test';

test('renders the whole-stack care homepage and every role login', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('heading', { level: 1 })).toContainText('Your web stack.');
  await expect(page.getByRole('button', { name: 'All technologies', exact: true })).toBeVisible();
  for (const path of ['customer', 'agency', 'affiliate', 'specialist', 'owner']) {
    await page.goto(`/${path}/login`); await expect(page.getByRole('heading', { level: 1 })).toContainText('Welcome back'); await expect(page.locator('.customer-sidebar')).toHaveCount(0); await expect(page.getByRole('link', { name: 'Sessions' })).toHaveCount(0);
  }
});

test('protects portal navigation before authentication', async ({ page }) => {
  await page.goto('/customer/overview');
  await expect(page).toHaveURL(/\/customer\/login$/u);
  await expect(page.locator('.customer-sidebar')).toHaveCount(0);
});

test('renders registration, recovery, verification, MFA, and account-state pages', async ({ page }) => {
  for (const path of ['/customer/register', '/agency/register', '/affiliate/register', '/forgot-password', '/reset-password?token=test', '/verify-email?sent=1', '/mfa', '/approval-pending', '/rejected', '/suspended', '/deactivated']) {
    await page.goto(path); await expect(page.locator('main')).toBeVisible();
  }
  await page.goto('/specialist/register'); await expect(page).toHaveURL(/\/specialist\/login$/u);
});
