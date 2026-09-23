import { expect, test } from '@playwright/test';
test('affiliate can navigate its attributed financial workspace', async ({ page }) => {
  await page.goto('/affiliate/login'); await page.getByLabel('Email').fill('affiliate-e2e@zerochack.test'); await page.getByLabel('Password').fill('Customer-E2E-Password9!'); await page.getByRole('button', { name: 'Sign in' }).click(); await expect(page).toHaveURL(/\/affiliate\/overview$/u);
  for (const section of ['Overview','Referral Link','Referrals','Attribution','Commissions','Transactions','Payouts','Notifications','Profile']) { await page.getByRole('link', { name: section, exact: true }).click(); await expect(page.getByRole('heading', { name: section, exact: true })).toBeVisible({ timeout: 30_000 }); }
});
