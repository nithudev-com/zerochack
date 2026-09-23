import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('per-response CSP nonces allow page hydration without inline-script bypasses', async ({ page }) => {
  const blocked: string[] = [];
  page.on('console', message => { if (message.type() === 'error' && message.text().includes('Content Security Policy')) blocked.push(message.text()); });
  await page.setExtraHTTPHeaders({ 'x-nonce': 'caller-supplied-marker' });
  const response = await page.goto('/');
  const policy = response!.headers()['content-security-policy']!;
  // Next dev substitutes its own mandatory revalidation policy.
  expect(response!.headers()['cache-control']).toContain(process.env.CARE_WEB_PRODUCTION === 'true' ? 'no-store' : 'no-cache');
  const nonce = /'nonce-([^']+)'/.exec(policy)?.[1];
  expect(nonce).toBeTruthy(); expect(nonce).not.toBe('caller-supplied-marker');
  const scriptPolicy = policy.split(';').find(part => part.trim().startsWith('script-src'))!;
  expect(scriptPolicy).not.toContain("'unsafe-inline'");
  if (process.env.CARE_WEB_PRODUCTION === 'true') expect(scriptPolicy).not.toContain("'unsafe-eval'");
  await page.getByRole('searchbox', { name: 'Search technologies or issues' }).fill('Docker');
  await expect(page.locator('.zr-tech-result-count')).toContainText('1 of 12');
  expect(await page.locator('script[type="application/ld+json"]').evaluate(node => (node as HTMLScriptElement).nonce)).toBe(nonce);
  const second = await page.reload();
  expect(second!.headers()['content-security-policy']).not.toContain(`'nonce-${nonce}'`);
  await expect(page.locator('.zr-tech-result-count')).toContainText('12 of 12');
  expect(blocked).toEqual([]);
});

test('technology search, filters and file-support details describe the implemented review flow', async ({ page }) => {
  await page.goto('/');
  const directory = page.locator('.zr-tech-directory');
  await expect(directory.getByRole('status')).toHaveText('12 of 12 technology areas');
  await expect(directory.getByText('24 source-review roles · 15 implemented tools', { exact: true })).toBeVisible();
  await directory.getByRole('button', { name: 'Servers & DevOps', exact: true }).click();
  await expect(directory.getByRole('status')).toHaveText('5 of 12 technology areas');
  const search = directory.getByRole('searchbox', { name: 'Search technologies or issues' });
  await search.fill('Docker');
  await expect(directory.getByRole('article')).toHaveCount(1);
  await directory.getByText('Review team & file support', { exact: true }).click();
  await expect(directory.getByText(/YAML syntax and duplicate keys/)).toBeVisible();
  await expect(directory.locator('.zr-tech-support p').first()).toContainText('Infrastructure Reviewer');
  await search.fill('not-a-listed-stack');
  await expect(directory.getByRole('heading', { name: 'No matching area in this view.' })).toBeVisible();
  await directory.getByRole('button', { name: 'Show all technology areas' }).click();
  await expect(search).toHaveValue('');
  await expect(directory.getByRole('article')).toHaveCount(12);
  await search.fill('Program.cs');
  await expect(directory.getByRole('heading', { name: 'Backend & application frameworks' })).toBeVisible();
});

test('homepage examples respond to keyboard and retain structured SEO and working section links', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('ZeroRoot | AI Website, API, Server & DevOps Care');
  const preview = page.locator('.zr-preview');
  const api = preview.getByRole('button', { name: 'API', exact: true });
  await api.focus(); await page.keyboard.press('Enter');
  await expect(api).toHaveAttribute('aria-pressed', 'true');
  await expect(preview.getByRole('heading', { name: 'Trace the issue. Plan the fix.' })).toBeVisible();
  await preview.getByRole('button', { name: 'Repair', exact: true }).click();
  await expect(preview.getByText('candidate-preview.html', { exact: true })).toBeVisible();
  await expect(preview.getByText('Illustrative workflow. No live system is connected.')).toBeVisible();
  const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').innerText()) as { '@graph': Array<{ '@type': string; mainEntity?: unknown[] }> };
  expect(schema['@graph'].map(item => item['@type'])).toEqual(expect.arrayContaining(['WebSite','SoftwareApplication','FAQPage']));
  expect(schema['@graph'].find(item => item['@type'] === 'FAQPage')?.mainEntity).toHaveLength(10);
  expect(await page.locator('a[href^="#"]').evaluateAll(links => links.map(link => link.getAttribute('href')!.slice(1)).filter(id => !document.getElementById(id)))).toEqual([]);
});

test('mobile navigation closes after selection and the directory fits the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByLabel('Open navigation', { exact: true }).click();
  await page.locator('.zr-mobile-nav').getByRole('link', { name: 'All technologies', exact: true }).click();
  await expect(page).toHaveURL(/#technology$/);
  await expect(page.locator('.zr-mobile-nav')).not.toHaveAttribute('open', '');
  await page.locator('.zr-tech-support summary').first().click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/home-technology-mobile.png', fullPage: true });
});

for (const width of [390, 1280]) {
  test(`automated WCAG checks for the redesigned homepage at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 }); await page.goto('/');
    await page.locator('.zr-tech-support summary').first().click();
    const result = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
    expect(result.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width === 1280) await page.screenshot({ path: 'test-results/home-desktop.png', fullPage: true });
  });
}
