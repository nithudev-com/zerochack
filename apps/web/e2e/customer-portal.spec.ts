import { expect, test } from '@playwright/test';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/customer/login');
  await page.getByLabel('Email address').fill('customer-e2e@zerochack.test');
  await page.getByLabel('Password').fill('Customer-E2E-Password9!');
  await page.getByRole('button', { name: 'Sign in as Customer' }).click();
  await expect(page).toHaveURL(/\/customer\/overview$/);
}

test('customer can navigate the workspace, store approved access, and persist a conversation', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'My Websites' }).click();
  await page.getByLabel('Website name').fill('E2E Website');
  await page.getByLabel('Website URL').fill('https://example.com');
  await page.getByRole('button', { name: 'Add and continue' }).click();
  await expect(page.getByRole('heading', { name: 'E2E Website' })).toBeVisible();
  await page.getByRole('link', { name: 'Open workspace' }).click();
  await expect(page.getByRole('navigation', { name: 'Website workspace' })).toBeVisible();
  await page.getByLabel('Secure access details').fill('Type: CMS\nHost: cms.example.test\nUsername: fixture-editor\nPassword: synthetic-e2e-vault-marker');
  await expect(page.getByRole('button', { name: 'Store securely' })).toBeDisabled();
  await page.getByLabel('I’m authorized to provide').check();
  await page.getByRole('button', { name: 'Store securely' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Access stored securely' })).toBeVisible();
  await expect(page.getByLabel('Conversation history')).not.toContainText('synthetic-e2e-vault-marker');
  await page.getByRole('button', { name: /^Access / }).click();
  await expect(page.getByRole('region', { name: 'Stored access' })).toContainText('CMS · cms.example.test');
  // Published-price responses use the real database and require no external model account.
  const message = 'What pricing is available for my E2E Website?';
  await page.getByLabel('Message ZeroRoot').fill(message);
  await page.getByRole('button', { name: /^Send/ }).click();
  await expect(page.getByLabel('Conversation history')).toContainText(message);
  await expect(page.getByText('ZeroRoot · AI assistant', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Conversation history')).toContainText(message);
  await expect(page.getByLabel('Conversation history')).not.toContainText('synthetic-e2e-vault-marker');
  await page.getByRole('navigation', { name: 'Website workspace' }).getByRole('link', { name: 'Access or live help' }).click();
  await expect(page.getByLabel('Server host')).toHaveValue('example.com');
  await expect(page.getByLabel('SSH port')).toHaveValue('22');
  await expect(page.getByLabel('SSH username')).toBeVisible();
  await page.getByLabel('Authentication method').selectOption('PASSWORD');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save, connect, and assess' })).toBeDisabled();
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(page.getByLabel('Conversation history')).toContainText(message);
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
  await expect(page.getByRole('region', { name: 'Mobile E2E Website conversation', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Website options' }).click();
  const workspaceNavigation = page.getByRole('navigation', { name: 'Website workspace' });
  await expect(workspaceNavigation).toBeVisible();
  await workspaceNavigation.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(page.getByLabel('Secure access details')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
