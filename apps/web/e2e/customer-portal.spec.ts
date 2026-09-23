import { expect, test } from '@playwright/test';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/customer/login');
  await page.getByLabel('Email address').fill('customer-e2e@zerochack.test');
  await page.getByLabel('Password').fill('Customer-E2E-Password9!');
  await page.getByRole('button', { name: 'Sign in as Customer' }).click();
  await expect(page).toHaveURL(/\/customer\/overview$/);
}

test('customer can navigate from dashboard to website workspace and chat', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'My Websites' }).click();
  await page.getByLabel('Website name').fill('E2E Website');
  await page.getByLabel('Website URL').fill('https://example.com');
  await page.getByRole('button', { name: 'Add and continue' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Website' })).toBeVisible();
  await page.getByRole('link', { name: 'Open workspace' }).click();
  await expect(page.getByRole('navigation', { name: 'Website workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Enter SSH and password' }).click();
  const secureForm = page.getByRole('region', { name: 'Encrypted SSH access form' });
  await expect(secureForm.getByLabel('SSH host')).toHaveValue('example.com');
  await expect(secureForm.getByLabel('Port')).toHaveValue('22');
  await expect(secureForm.getByLabel('Username')).toBeVisible();
  await expect(secureForm.getByLabel('SSH password')).toBeVisible();
  await expect(secureForm.getByRole('button', { name: 'Connect and start assessment' })).toBeDisabled();
  await secureForm.getByRole('button', { name: 'Back to chat' }).click();
  await page.getByLabel('Message').fill('This is a real tenant-scoped message.');
  await page.getByRole('button', { name: 'Message support' }).click();
  await expect(page.getByText('This is a real tenant-scoped message.')).toBeVisible();
});

test('customer portal remains usable on a mobile viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  const navigation = page.getByRole('navigation', { name: 'Customer navigation' });
  await expect(navigation).toBeVisible(); await navigation.getByRole('link', { name: 'My Websites' }).click();
  await expect(page.getByRole('heading', { name: 'Websites' })).toBeVisible();
  await page.getByLabel('Website name').fill('Mobile E2E Website');
  await page.getByLabel('Website URL').fill('https://example.org');
  await page.getByRole('button', { name: 'Add and continue' }).click();
  await expect(page.getByRole('heading', { name: 'Mobile E2E Website' })).toBeVisible();
  await page.getByRole('link', { name: 'Open workspace' }).last().click();
  await expect(page.getByRole('navigation', { name: 'Website workspace' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Live website help' })).toBeVisible();
});
