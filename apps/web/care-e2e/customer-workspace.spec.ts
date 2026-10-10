import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { CustomerOverviewData } from '../components/overview';

const empty: CustomerOverviewData = { protectedWebsites: 0, securityPosture: null, openFindings: 0, criticalFindings: 0, latestScan: null, monitoring: { active: 0, total: 0 }, backups: { active: 0, total: 0 }, openTickets: 0, subscription: null, unreadNotifications: 0 };
const populated: CustomerOverviewData = { protectedWebsites: 2, securityPosture: 'ATTENTION', openFindings: 7, criticalFindings: 1, latestScan: { status: 'COMPLETED', requestedAt: '2026-10-08T10:00:00.000Z' }, monitoring: { active: 2, total: 3 }, backups: { active: 1, total: 3 }, openTickets: 2, subscription: { planName: 'Business', status: 'ACTIVE' }, unreadNotifications: 4 };

async function fixture(page: Page, data: () => CustomerOverviewData = () => empty, options: { overviewError?: () => boolean; logoutError?: () => boolean; onLogout?: () => void; authenticated?: boolean } = {}) {
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let body: unknown = {}; let status = 200;
    if (path === '/v1/auth/me') { body = { roles: ['Customer'] }; if (options.authenticated === false) status = 401; }
    else if (path === '/v1/customer/overview') { body = data(); if (options.overviewError?.()) { status = 503; body = { error: { code: 'UNAVAILABLE', message: 'Overview temporarily unavailable. Please retry.' } }; } }
    else if (path === '/v1/auth/logout') { expect(route.request().method()).toBe('POST'); options.onLogout?.(); if (options.logoutError?.()) status = 503; }
    else if (path === '/v1/customer/billing' || path === '/v1/websites' || path === '/v1/notifications') body = [];
    else if (path === '/v1/notification-preferences') body = { preferences: [] };
    else if (path === '/v1/customer/commercial') body = { billingStatus: 'ACTIVE', invoices: [], payments: [], quotes: [] };
    await route.fulfill({ status, headers, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

for (const width of [320, 390, 768, 1440]) {
  test(`customer overview is compact, accessible and overflow-free at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 }); await fixture(page);
    await page.goto('/customer/overview');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview.' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add your first website' })).toBeVisible();
    await expect(page.getByText('Setup needed', { exact: true })).toBeVisible();
    await expect(page.getByText('No scans yet', { exact: true })).toBeVisible();
    await expect(page.getByText('No subscription', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect((await page.locator('.cw-metric').first().boundingBox())!.y).toBeLessThan(610);
    await expect(page.locator('.role-metric, .role-pulse, .role-visual')).toHaveCount(0);
    await expect(page.getByRole('navigation', { name: width < 1024 ? 'Customer mobile navigation' : 'Customer navigation', exact: true })).toBeVisible();
    const logo = page.locator('.app-header').getByRole('img', { name: 'CodeBandage', exact: true });
    await expect.poll(() => logo.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(accessibility.violations).toEqual([]);
    await page.screenshot({ path: `/tmp/codebandage-customer-${width}.png`, fullPage: true });
    if (width < 1024) {
      const nav = page.getByRole('navigation', { name: 'Customer mobile navigation' });
      for (const control of await nav.locator('a,button').all()) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.getByRole('link', { name: 'Billing & invoices', exact: true }).scrollIntoViewIfNeeded();
      const box = await page.getByRole('link', { name: 'Billing & invoices', exact: true }).boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual((await nav.boundingBox())!.y);
    }
  });
}

for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 768, height: 900 }, { width: 844, height: 390 }]) {
  test(`mobile Customer header stays pinned without covering content at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport); await fixture(page); await page.goto('/customer/overview');
    await expect(page.getByRole('heading', { level: 1, name: 'Overview.' })).toBeVisible();
    const header = page.locator('.app-header');
    await expect(header).toHaveCSS('position', 'sticky');
    const firstHeading = await page.locator('.cw-page-heading').boundingBox();
    const initialHeader = await header.boundingBox();
    expect(firstHeading!.y).toBeGreaterThanOrEqual(initialHeader!.y + initialHeader!.height);
    await page.evaluate(() => window.scrollTo({ top: 650, behavior: 'instant' }));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
    expect(Math.abs((await header.boundingBox())!.y)).toBeLessThan(1);
    expect(await header.evaluate(element => element.contains(document.elementFromPoint(35, 25)))).toBe(true);
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Customer portal' })).toBeVisible();
    await page.getByRole('button', { name: 'Close navigation' }).click();
    await expect(page.getByRole('button', { name: 'More', exact: true })).toBeFocused();
    await page.locator('.cw-metric').first().evaluate(element => element.scrollIntoView({ block: 'start', behavior: 'instant' }));
    const target = await page.locator('.cw-metric').first().boundingBox();
    const pinnedHeader = await header.boundingBox();
    expect(target!.y).toBeGreaterThanOrEqual(pinnedHeader!.height);
    await header.getByRole('link', { name: 'Notifications', exact: true }).click();
    await expect(page).toHaveURL(/\/customer\/notifications$/);
    await expect(page.getByRole('heading', { name: 'Notifications', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  });
}

test('sticky header is limited to mobile Customer pages', async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/customer/overview');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview.' })).toBeVisible();
  await expect(page.locator('.app-header')).toHaveCSS('position', 'relative');
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/customer/login');
  await expect(page.locator('.app-shell--customer')).toHaveCount(0);
  await expect(page.locator('.app-header')).not.toHaveCSS('position', 'sticky');
  await expect(page.locator('html')).not.toHaveCSS('scroll-padding-top', '80px');
});

test('real counts, unknown posture, refresh and populated states are displayed without invented protection scores', async ({ page }) => {
  let data = { ...populated }; await fixture(page, () => data); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/customer/overview');
  await expect(page.getByText('Needs attention', { exact: true })).toBeVisible();
  const cards = page.locator('.cw-metric');
  for (const [index, value] of ['2', '7', '2 / 3', '1 / 3'].entries()) await expect(cards.nth(index).locator('strong')).toHaveText(value);
  await expect(page.getByText('Business', { exact: true })).toBeVisible();
  await expect(page.locator('time')).toHaveAttribute('datetime', populated.latestScan!.requestedAt);
  await expect(page.getByRole('link', { name: 'Manage websites', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/codebandage-customer-populated.png', fullPage: true });
  data = { ...populated, securityPosture: 'UNKNOWN', criticalFindings: 0 };
  await page.getByRole('button', { name: 'Refresh overview', exact: true }).click();
  await expect(page.getByText('Not assessed', { exact: true })).toBeVisible();
  await expect(page.getByText('Healthy', { exact: true })).toHaveCount(0);
  data = { ...data, securityPosture: 'HEALTHY' }; await page.getByRole('button', { name: 'Refresh overview', exact: true }).click();
  await expect(page.getByText('Healthy', { exact: true })).toBeVisible();
});

test('mobile More menu preserves every destination, traps keyboard focus and closes with Escape and navigation', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await fixture(page); await page.goto('/customer/overview');
  const more = page.getByRole('button', { name: 'More', exact: true }); await more.click();
  const menu = page.getByRole('dialog', { name: 'Customer portal' }); await expect(menu).toBeVisible(); await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(menu.getByRole('navigation').getByRole('link')).toHaveCount(7);
  for (const href of ['/customer/overview', '/customer/websites', '/customer/support', '/customer/subscription', '/customer/billing', '/customer/notifications', '/customer/profile', '/account']) await expect(menu.locator(`a[href="${href}"]`)).toBeVisible();
  await menu.getByRole('button', { name: 'Sign out', exact: true }).focus(); await page.keyboard.press('Tab');
  await expect(menu.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: '/tmp/codebandage-customer-menu.png', fullPage: true });
  await page.keyboard.press('Escape'); await expect(menu).not.toBeVisible(); await expect(more).toBeFocused();
  await more.click(); await menu.getByRole('link', { name: 'Billing', exact: true }).click();
  await expect(page).toHaveURL(/\/customer\/billing$/); await expect(menu).not.toBeVisible();
  await expect(page.getByRole('heading', { name: 'Invoices and payments', exact: true })).toBeVisible();
  await expect(more).toHaveAttribute('data-active', 'true');
  await more.click(); await page.setViewportSize({ width: 1280, height: 900 }); await expect(menu).not.toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Customer navigation', exact: true }).getByRole('link', { name: 'Billing', exact: true })).toHaveAttribute('aria-current', 'page');
});

test('overview error can be retried and logout failures are recoverable', async ({ page }) => {
  let failed = true; let logoutFailed = true; let logouts = 0;
  await fixture(page, () => empty, { overviewError: () => failed, logoutError: () => logoutFailed, onLogout: () => { logouts++; } });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/customer/overview');
  await expect(page.getByText('Overview temporarily unavailable. Please retry.')).toBeVisible();
  failed = false; await page.getByRole('button', { name: /retry|try again/i }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Overview.' })).toBeVisible();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Sign out did not complete. Please try again.');
  await expect(page).toHaveURL(/\/customer\/overview$/);
  logoutFailed = false; await page.getByRole('dialog').getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/customer\/login$/); expect(logouts).toBe(2);
  await expect(page.getByRole('navigation', { name: 'Customer mobile navigation' })).toHaveCount(0);
});

test('signed-out visitors still need authentication and signup stays available', async ({ page }) => {
  await fixture(page, () => empty, { authenticated: false }); await page.goto('/customer/overview');
  await expect(page).toHaveURL(/\/customer\/login$/); await expect(page.getByLabel('Email address', { exact: true })).toBeVisible();
  await expect(page.locator('a[href="/customer/register"]')).toBeVisible();
  await expect(page.locator('.cw-mobile-nav, .cw-overview')).toHaveCount(0);
});

test('website form remains reachable and reduced motion removes decorative movement', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
  await fixture(page); await page.goto('/customer/overview');
  await expect(page.locator('.cw-metric').first()).toHaveCSS('transition-duration', '0s');
  await page.getByRole('link', { name: 'Add your first website' }).click(); await expect(page).toHaveURL(/\/customer\/websites$/);
  await expect(page.getByLabel('Website name', { exact: true })).toBeVisible(); await expect(page.getByLabel('Website URL', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add and continue' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Customer mobile navigation' }).getByRole('link', { name: 'Websites' })).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
});
