import { expect, test } from '@playwright/test';

async function login(page: import('@playwright/test').Page) {
  await page.goto('/customer/login');
  await page.getByLabel('Email address').fill('customer-e2e@zerochack.test');
  await page.getByLabel('Password').fill('Customer-E2E-Password9!');
  await page.getByRole('button', { name: 'Sign in as Customer' }).click();
  await expect(page).toHaveURL(/\/customer\/overview$/);
}

// Keep the current service chooser and the retained direct conversation route
// under real authenticated API/database coverage; neither starts repair work.
async function openSecurityAndRetainedConversation(page: import('@playwright/test').Page, name: string) {
  await expect(page).toHaveURL(/\/customer\/websites\/[a-f\d-]+\/services$/, { timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Choose website service' })).toContainText(name);
  await page.getByRole('radio', { name: /Fix hacks & security/ }).check();
  await page.getByRole('button', { name: /Next: open workspace/ }).click();
  await expect(page).toHaveURL(/\/customer\/websites\/[a-f\d-]+\?service=security$/, { timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Security recovery conversation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review security repairs' })).toBeVisible();
  // Existing links/bookmarks to the general conversation remain supported.
  await page.goto(new URL(page.url()).pathname);
  await expect(page.getByRole('region', { name: `${name} conversation`, exact: true })).toBeVisible();
}

test('customer can navigate the workspace, store approved access, and persist a conversation', async ({ page }) => {
  test.setTimeout(120_000);
  await login(page);
  await page.getByRole('link', { name: 'My Websites' }).click();
  await page.getByLabel('Website name').fill('E2E Website');
  await page.getByLabel('Website URL').fill('https://example.com');
  await page.getByRole('button', { name: 'Add and continue' }).click();
  await expect(page).toHaveURL(/\/customer\/websites\/[a-f\d-]+\/services$/, { timeout: 30_000 });
  await expect(page.getByRole('region', { name: 'Choose website service' })).toContainText('E2E Website');
  await page.getByRole('link', { name: '← My websites', exact: true }).click();
  await page.locator('.ui-card').filter({ has: page.getByRole('heading', { name: 'E2E Website', exact: true }) }).getByRole('link', { name: 'Open workspace' }).click();
  await openSecurityAndRetainedConversation(page, 'E2E Website');
  await expect(page.getByRole('navigation', { name: 'Website workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Message assistant' }).click();
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
  await page.getByLabel('Message CodeBandage').fill(message);
  await page.getByRole('button', { name: /^Send/ }).click();
  await expect(page.getByLabel('Conversation history')).toContainText(message);
  await expect(page.getByText('CodeBandage · AI assistant', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Conversation history')).toContainText(message);
  await expect(page.getByLabel('Conversation history')).not.toContainText('synthetic-e2e-vault-marker');
  const savedUrl = page.url(); const context = page.context();
  await page.close(); page = await context.newPage(); await page.goto(savedUrl);
  await expect(page.getByLabel('Conversation history')).toContainText(message);
  await page.getByText('Workspace controls', { exact: true }).click();
  await page.getByRole('button', { name: 'Recovery readiness', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Recovery readiness' })).toContainText('No retained, verified production backup record was found.');
  await expect(page.getByRole('region', { name: 'Recovery readiness' })).toContainText('not verified');
  await page.getByRole('button', { name: 'Recovery readiness', exact: true }).click();
  await page.getByRole('navigation', { name: 'Website workspace' }).getByRole('link', { name: 'Connections', exact: true }).click();
  await expect(page.getByLabel('Server host')).toHaveValue('example.com', { timeout: 30_000 });
  await expect(page.getByLabel('SSH port')).toHaveValue('22');
  await expect(page.getByLabel('SSH username')).toBeVisible();
  await page.getByLabel('Authentication method').selectOption('PASSWORD');
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save, connect, and assess' })).toBeDisabled();
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await expect(page.getByLabel('Conversation history')).toContainText(message);
});

test('customer portal remains usable on a mobile viewport', async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 }); await login(page);
  await page.getByRole('navigation', { name: 'Customer mobile navigation' }).getByRole('button', { name: 'More', exact: true }).click();
  const navigation = page.getByRole('dialog', { name: 'Customer portal' });
  await expect(navigation).toBeVisible(); await navigation.getByRole('link', { name: 'My websites', exact: true }).click();
  await expect(navigation).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Websites' })).toBeVisible();
  await page.getByLabel('Website name').fill('Mobile E2E Website');
  await page.getByLabel('Website URL').fill('https://example.org');
  await page.getByRole('button', { name: 'Add and continue' }).click();
  await openSecurityAndRetainedConversation(page, 'Mobile E2E Website');
  await page.getByRole('button', { name: 'Website options' }).click();
  const workspaceNavigation = page.getByRole('navigation', { name: 'Website workspace' });
  await expect(workspaceNavigation).toBeVisible();
  await workspaceNavigation.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('link', { name: 'Back to conversation' }).click();
  await page.getByRole('button', { name: 'Message assistant' }).click();
  await expect(page.getByLabel('Secure access details')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
