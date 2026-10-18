import { test, expect } from '@playwright/test';

for (const width of [390,1280]) {
  test(`CodeBandage header, artwork and metadata at ${width}px`, async ({ page }) => {
    await page.setViewportSize({width,height:900}); await page.goto('/');
    await expect(page).toHaveTitle(/^CodeBandage/);
    const logo=page.locator('.app-header').getByRole('img',{name:'CodeBandage',exact:true});
    await expect(logo).toBeVisible();
    await expect.poll(() => logo.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute('content','CodeBandage');
    expect(await page.locator('.app-main').innerText()).not.toContain('ZeroRoot');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path:`test-results/codebandage-home-${width}.png`,fullPage:true});
  });
}
test('new artwork, favicon, social card and PWA icons are served', async ({ request }) => {
  const manifest=await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.short_name).toBe('CodeBandage');
  expect(manifest.icons).toHaveLength(3);
  for (const src of ['/brand/codebandage-logo.webp','/brand/favicon-32.png','/brand/apple-touch-icon.png','/opengraph-image.png',...manifest.icons.map((icon:{src:string})=>icon.src)]) {
    const res=await request.get(src); expect(res.status()).toBe(200); expect(res.headers()['content-type']).toMatch(/^image\//);
  }
  const alias=await request.get('/opengraph-image',{maxRedirects:0}); expect(alias.status()).toBe(307);
});
test('all public portal sign-ins use the new logo without changing form semantics', async ({ page }) => {
  for (const portal of ['customer','agency','affiliate','specialist','owner']) {
    await page.goto(`/${portal}/login`); await expect(page).toHaveTitle(/CodeBandage/);
    await expect(page.locator('.auth-copy').getByRole('img',{name:'CodeBandage',exact:true})).toBeVisible();
    await expect(page.getByLabel('Email address',{exact:true})).toBeVisible();
    await expect(page.getByLabel('Password',{exact:true})).toBeVisible();
    expect(await page.locator('main').innerText()).not.toContain('ZeroRoot');
  }
});
test('logo stays transparent and horizontal in dark/reduced-motion rendering', async ({ page }) => {
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'}); await page.goto('/customer/login');
  const logo=page.locator('.app-header .cb-brand');
  await expect(logo).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  const mark=await logo.locator('.cb-brand__mark').boundingBox();
  const word=await logo.locator('.cb-brand__wordmark').boundingBox();
  expect(mark).not.toBeNull(); expect(word).not.toBeNull();
  expect(mark!.x+mark!.width).toBeLessThan(word!.x);
  expect(Math.abs(mark!.y+mark!.height/2-word!.y-word!.height/2)).toBeLessThan(2);
  await expect(page.locator('.auth-copy .cb-brand')).toHaveCSS('background-color','rgba(0, 0, 0, 0)');
  await expect(page.locator('.auth-copy .cb-brand__wordmark')).toHaveCSS('filter','brightness(0) invert(1)');
  await page.screenshot({path:'test-results/codebandage-auth-dark.png',fullPage:true});
});
