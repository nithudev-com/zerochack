import { expect, test } from '@playwright/test'; import { totp } from '@zerochack/auth';
test('MFA-authenticated Owner can navigate the complete control center', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/owner/login'); await page.getByLabel('Email').fill('owner-e2e@zerochack.test'); await page.getByLabel('Password').fill('Customer-E2E-Password9!'); await page.getByRole('button', { name: 'Sign in' }).click(); await expect(page).toHaveURL(/\/mfa/u); await page.getByLabel('Authenticator or recovery code').fill(totp(Buffer.alloc(20,7).toString('base64'))); await page.getByRole('button',{name:'Verify'}).click(); await expect(page).toHaveURL(/\/owner\/overview$/u);
  await expect(page.getByRole('heading', { name: /^Platform overview\./ })).toBeVisible();
  await expect(page.getByText('This alert count is not a security score.', { exact: false })).toBeVisible();
  const sections=['Overview','Users','Approvals','Tenants','Websites','Specialists','Tickets','Subscriptions','Packages','Pricing','Quotes','Revenue','Affiliates','Commissions','Payouts','Backups','Monitoring','Security','Notifications','Email Automation','AI Gateway','Care','Integrations','System Health','Audit Logs','Settings'];
  const ownerNavigation=page.getByRole('navigation',{name:'Owner navigation'});
  const headings: Record<string, string | RegExp> = { Overview: /^Platform overview\./, Approvals: 'Account approvals', Care: 'Care capabilities', Tickets: 'Ticket operations', Commissions: 'Commission review', Payouts: 'Payout operations' };
  for(const section of sections){await ownerNavigation.getByRole('link',{name:section,exact:true}).click();await expect(page.getByRole('heading',{name:headings[section]??section,exact:true})).toBeVisible({timeout:30_000});}
});
