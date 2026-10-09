import { expect, test } from '@playwright/test';

const portals = [
  { portal:'customer', role:'Customer' },
  { portal:'agency', role:'Agency' },
  { portal:'affiliate', role:'Affiliate' }
] as const;

// UI-only fixtures: never create production users or send real registration email.
for (const {portal,role} of portals) {
  for (const width of [390,1280]) {
    test(`${role} sign-up section opens its registration form at ${width}px`, async ({page}) => {
      await page.setViewportSize({width,height:900});
      await page.goto(`/${portal}/login`);
      const section=page.getByRole('region',{name:'New to CodeBandage?'});
      const link=section.getByRole('link',{name:`Sign up as ${role}`,exact:true});
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href',`/${portal}/register`);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await link.click();
      await expect(page).toHaveURL(new RegExp(`/${portal}/register$`));
      await expect(page.getByRole('heading',{name:'Create your secure account.'})).toBeVisible();
      await expect(page.getByLabel('Full name',{exact:true})).toBeVisible();
      await expect(page.getByLabel('Organization name',{exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:`Create ${role} account`,exact:true})).toBeVisible();
      if (role!=='Customer') await expect(page.getByText('After email verification, an Owner must approve this account before access is enabled.')).toBeVisible();
      await page.getByRole('link',{name:'Sign in',exact:true}).click();
      await expect(page).toHaveURL(new RegExp(`/${portal}/login$`));
    });
  }
  test(`${role} registration validates fields and keeps email-verification handoff`, async ({page}) => {
    const requests: Array<Record<string,unknown>>=[];
    await page.route('**/v1/auth/register', async route=>{
      const headers = { 'access-control-allow-origin':new URL(page.url()).origin, 'access-control-allow-credentials':'true', 'access-control-allow-methods':'POST, OPTIONS', 'access-control-allow-headers':'content-type' };
      if (route.request().method()==='OPTIONS') { await route.fulfill({status:204,headers}); return; }
      requests.push(route.request().postDataJSON());
      await route.fulfill({status:201,headers,contentType:'application/json',body:JSON.stringify({message:'Synthetic registration accepted'})});
    });
    await page.goto(`/${portal}/register`);
    await page.getByRole('button',{name:`Create ${role} account`,exact:true}).click();
    await expect(page.getByText('Name is required',{exact:true})).toBeVisible();
    await expect(page.getByText('Organization is required',{exact:true})).toBeVisible();
    await expect(page.getByText('Email is required',{exact:true})).toBeVisible();
    await expect(page.getByText('Password is required',{exact:true})).toBeVisible();
    expect(requests).toHaveLength(0);
    await page.getByLabel('Full name',{exact:true}).fill('Synthetic Signup User');
    await page.getByLabel('Organization name',{exact:true}).fill('Synthetic Organization');
    await page.getByLabel('Email address',{exact:true}).fill(`${portal}@signup.example.test`);
    await page.getByLabel('Password',{exact:true}).fill('Synthetic-Signup-Password9!');
    await page.getByRole('button',{name:`Create ${role} account`,exact:true}).click();
    await expect(page).toHaveURL(/\/verify-email\?sent=1$/);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({role,displayName:'Synthetic Signup User',organizationName:'Synthetic Organization',email:`${portal}@signup.example.test`});
  });
}

test('bare customer URL redirects to the public Customer login', async ({page})=>{
  await page.goto('/customer');
  await expect(page).toHaveURL(/\/customer\/login$/);
  await expect(page.getByRole('link',{name:'Sign up as Customer',exact:true})).toBeVisible();
});

test('staff login pages do not offer public sign-up', async ({page})=>{
  for (const portal of ['owner','specialist']) {
    await page.goto(`/${portal}/login`);
    await expect(page.getByRole('region',{name:'New to CodeBandage?'})).toHaveCount(0);
    await expect(page.getByRole('link',{name:/^Sign up as /})).toHaveCount(0);
  }
});
