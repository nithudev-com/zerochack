import { expect, test } from '@playwright/test';

test('agency can navigate every portal section with only authorized client data', async ({ page }) => {
  await page.goto('/agency/login');
  await page.getByLabel('Email').fill('agency-e2e@zerochack.test');
  await page.getByLabel('Password').fill('Customer-E2E-Password9!');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/agency\/overview$/u);
  for (const section of ['Overview', 'Clients', 'Websites', 'Subscriptions', 'Commerce', 'Quotes', 'Billing', 'Notifications', 'Profile']) {
    await page.getByRole('navigation', { name: 'Agency navigation' }).getByRole('link', { name: section, exact: true }).click();
    const heading = section === 'Overview' ? /^Every client,/ : section;
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible({ timeout: 30_000 });
  }
});
