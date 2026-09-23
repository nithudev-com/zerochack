import { expect, test } from '@playwright/test'; import { totp } from '@zerochack/auth';
test('MFA-authenticated Owner can navigate the complete control center', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/owner/login'); await page.getByLabel('Email').fill('owner-e2e@zerochack.test'); await page.getByLabel('Password').fill('Customer-E2E-Password9!'); await page.getByRole('button', { name: 'Sign in' }).click(); await expect(page).toHaveURL(/\/mfa/u); await page.getByLabel('Authenticator or recovery code').fill(totp(Buffer.alloc(20,7).toString('base64'))); await page.getByRole('button',{name:'Verify'}).click(); await expect(page).toHaveURL(/\/owner\/overview$/u);
  const sections=['Overview','Users','Approvals','Tenants','Websites','Specialists','Tickets','Subscriptions','Packages','Pricing','Quotes','Revenue','Affiliates','Commissions','Payouts','Backups','Monitoring','Security','Notifications','Email Automation','AI Gateway','Integrations','System Health','Audit Logs','Settings'];
  const ownerNavigation=page.getByRole('navigation',{name:'Owner navigation'});
  for(const section of sections){await ownerNavigation.getByRole('link',{name:section,exact:true}).click();const heading=section==='Approvals'?'Account approvals':section;await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible({timeout:30_000});}
});
