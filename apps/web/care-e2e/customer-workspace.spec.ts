import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { websiteNavigationLabel, type WebsiteNavigationActivity, type WebsiteNavigationClick } from '@zerochack/types';
import { websiteServices } from '../lib/website-services';
import type { OverviewWebsite } from '../lib/overview-websites';

const firstId = 'b33690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const secondId = 'c33690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const pendingId = 'a33690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const first: OverviewWebsite = { id: firstId, name: 'First connected website', url: 'https://first.example/', createdAt: '2026-10-01T01:00:00Z', connectionSummary: { kind: 'SSH', providers: ['ssh'], lastCheckedAt: '2026-10-11T01:00:00Z' } };
const second: OverviewWebsite = { id: secondId, name: 'Second connected website', url: 'https://second.example/', createdAt: '2026-10-09T01:00:00Z', connectionSummary: { kind: 'CONNECTOR', providers: ['wordpress'], lastCheckedAt: '2026-10-11T01:00:00Z' } };
const pending: OverviewWebsite = { id: pendingId, name: 'Added, not connected', url: 'https://pending.example/', createdAt: '2026-09-01T01:00:00Z', connectionSummary: { kind: 'NONE', providers: [], lastCheckedAt: null } };

async function fixture(page: Page, options: { websites?: OverviewWebsite[]; overviewError?: () => boolean; activityError?: () => boolean; saveError?: () => boolean; logoutError?: () => boolean; onLogout?: () => void; authenticated?: boolean } = {}) {
  const rows = new Map<string, WebsiteNavigationActivity[]>(); const writes: { websiteId: string; click: WebsiteNavigationClick }[] = [];
  let serial = 0;
  await page.route('**/v1/**', async route => {
    const path = new URL(route.request().url()).pathname; const method = route.request().method();
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
    let body: unknown = {}; let status = 200;
    if (path === '/v1/auth/me') { body = { roles: ['Customer'] }; if (options.authenticated === false) status = 401; }
    else if (path === '/v1/websites') { body = options.websites ?? [second, pending, first]; if (options.overviewError?.()) { status = 503; body = { error: { code: 'UNAVAILABLE', message: 'Overview temporarily unavailable. Please retry.' } }; } }
    else if (path.endsWith('/navigation-activity')) {
      const websiteId = path.split('/')[3]!;
      if (method === 'POST') {
        const click = route.request().postDataJSON() as WebsiteNavigationClick;
        expect(Object.keys(click).sort()).toEqual(['option', 'section']); writes.push({ websiteId, click });
        if (options.saveError?.()) { status = 503; body = { error: { code: 'UNAVAILABLE', message: 'Activity save unavailable' } }; }
        else { rows.set(websiteId, [{ id: String(++serial), createdAt: new Date().toISOString(), ...click }, ...(rows.get(websiteId) ?? [])].slice(0, 50)); status = 204; }
      } else { body = rows.get(websiteId) ?? []; if (options.activityError?.()) { status = 503; body = { error: { code: 'UNAVAILABLE', message: 'Activity unavailable' } }; } }
    }
    else if (path === '/v1/auth/logout') { expect(method).toBe('POST'); options.onLogout?.(); if (options.logoutError?.()) status = 503; }
    else if (path === '/v1/notifications') body = [];
    else if (path === '/v1/notification-preferences') body = { preferences: [] };
    else if (/^\/v1\/websites\/[^/]+$/.test(path)) body = { ...first, ...(options.websites ?? [first, second, pending]).find(site => site.id === path.split('/')[3]), connectionStatus: 'VERIFIED', securityStatus: 'UNKNOWN', monitoringStatus: 'NOT_CONFIGURED', backupStatus: 'NOT_CONFIGURED', findings: [], scans: [], tickets: [], backups: [], reports: [] };
    else if (path.endsWith('/access')) body = { configured: false, tools: [] };
    else if (path.includes('/care?') || path.endsWith('/care')) body = { credentials: [], accessRequests: [], jobs: [], roles: [], capabilities: {} };
    else if (method !== 'GET') throw new Error('Unexpected write: ' + path);
    else body = [];
    await route.fulfill({ status, headers, ...(status === 204 ? {} : { contentType: 'application/json', body: JSON.stringify(body) }) });
  });
  return { rows, writes };
}

for (const width of [320, 390, 768, 1440]) test(`website-focused overview is simple, accessible and overflow-free at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 }); const { writes } = await fixture(page); await page.goto('/customer/overview');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview', exact: true })).toBeVisible();
  await expect(page.getByLabel('Switch website')).toHaveValue(firstId);
  await expect(page.getByRole('heading', { name: first.name, exact: true })).toBeVisible();
  for (const heading of ['Tools', 'Workplace', 'My activity log']) await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  for (const old of ['At a glance', 'Care status', 'What needs attention', 'Quick access', 'Open findings', 'Latest scan']) await expect(page.getByText(old, { exact: true })).toHaveCount(0);
  await expect(page.locator('[data-overview-tool]')).toHaveCount(5);
  const workplace = page.locator('section[aria-labelledby="overview-workplace"]');
  for (const service of websiteServices) await expect(workplace.getByRole('link', { name: service.label, exact: true })).toHaveAttribute('href', `/customer/websites/${firstId}?service=${service.id}`);
  expect(writes).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  expect((await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: `/tmp/codebandage-overview-${width}.png`, fullPage: true });
});

test('switching website changes every destination and personal log, survives reload and handles inaccessible selection', async ({ page }) => {
  const { writes } = await fixture(page); await page.goto('/customer/overview');
  const seo = page.locator('[data-overview-tool="seo"]'); await seo.click();
  const dialog = page.getByRole('dialog', { name: 'Website tools' }); await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'SEO · Under construction' })).toBeFocused();
  await expect(dialog.getByText(first.name, { exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(seo).toBeFocused();
  await expect(page.getByText('Tools · SEO', { exact: true })).toBeVisible();
  await page.getByLabel('Switch website').selectOption(secondId); await expect(page).toHaveURL(new RegExp('website=' + secondId));
  await expect(page.getByRole('heading', { name: second.name, exact: true })).toBeVisible();
  await expect(page.getByText('Tools · SEO', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Full-stack web development', exact: true })).toHaveAttribute('href', `/customer/websites/${secondId}?service=development`);
  await page.reload(); await expect(page.getByLabel('Switch website')).toHaveValue(secondId);
  await page.getByLabel('Switch website').selectOption(firstId); await expect(page.getByText('Tools · SEO', { exact: true })).toBeVisible();
  expect(writes).toEqual([{ websiteId: firstId, click: { section: 'TOOLS', option: 'seo' } }]);
  await page.goto('/customer/overview?website=foreign'); await expect(page.getByLabel('Switch website')).toHaveValue(firstId);
});

test('all five tools open truthful construction states and record only explicit clicks without replay', async ({ page }) => {
  const { writes } = await fixture(page); await page.goto('/customer/overview');
  for (const [option, name] of [['seo','SEO'], ['security','Security'], ['automation','Automation'], ['marketing','Marketing'], ['chat','Chat Agent']]) {
    const trigger = page.locator(`[data-overview-tool="${option}"]`); await trigger.click(); const dialog = page.getByRole('dialog', { name: 'Website tools' });
    await expect(dialog.getByRole('heading', { name: `${name} · Under construction` })).toBeFocused();
    await expect(dialog.getByText(/no work has started/)).toBeVisible(); await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
    await expect(page.getByText('Tools · ' + name, { exact: true })).toBeVisible();
  }
  expect(writes).toHaveLength(5); await page.reload(); await expect(page.locator('section[aria-labelledby="overview-activity"] li')).toHaveCount(5); expect(writes).toHaveLength(5);
});

for (const service of websiteServices) test(`Workplace ${service.label} opens its existing selected flow and records one minimal click`, async ({ page }) => {
  const { writes } = await fixture(page); await page.goto('/customer/overview');
  await page.getByRole('link', { name: service.label, exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/customer/websites/' + firstId + '\\?service=' + service.id));
  if (service.id === 'security') await expect(page.getByLabel('Message CodeBandage')).toBeVisible();
  else await expect(page.getByRole('heading', { name: `${service.label} workspace`, exact: true })).toBeVisible();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({ websiteId: firstId, click: { section: 'WORKPLACE', option: service.id } });
  // The destination is an existing flow, not a new execution engine.
  await page.goto('/customer/overview'); await expect(page.getByText('Workplace · ' + websiteNavigationLabel({ section: 'WORKPLACE', option: service.id }), { exact: true })).toBeVisible();
});

test('activity failures never invent successful clicks or block tool choices, and retry restores history', async ({ page }) => {
  let activityError = true; let saveError = true; const { writes } = await fixture(page, { activityError: () => activityError, saveError: () => saveError });
  await page.goto('/customer/overview'); await expect(page.getByText(/Activity is unavailable/)).toBeVisible();
  await page.locator('[data-overview-tool="seo"]').click(); await expect(page.getByRole('heading', { name: 'SEO · Under construction' })).toBeVisible();
  await expect(page.getByText('Could not save this click to your activity.', { exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  activityError = false; await page.getByRole('button', { name: 'Retry activity' }).click(); await expect(page.getByText(/No clicks yet/)).toBeVisible();
  saveError = false; await page.locator('[data-overview-tool="marketing"]').click(); await page.keyboard.press('Escape'); await expect(page.getByText('Tools · Marketing', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(2); await expect(page.getByText('Tools · SEO', { exact: true })).toHaveCount(0);
});

test('empty websites and disconnected defaults are honest', async ({ page }) => {
  await fixture(page, { websites: [] }); await page.goto('/customer/overview'); await expect(page.getByRole('link', { name: 'Add website' })).toBeVisible(); await expect(page.getByLabel('Switch website')).toHaveCount(0);
  await page.getByRole('link', { name: 'Add website' }).click(); await expect(page.getByLabel('Website URL', { exact: true })).toBeVisible();
});

for (const viewport of [{ width: 320, height: 740 }, { width: 390, height: 844 }, { width: 768, height: 900 }, { width: 844, height: 390 }]) test(`mobile header and navigation remain usable at ${viewport.width}x${viewport.height}`, async ({ page }) => {
  await page.setViewportSize(viewport); await fixture(page); await page.goto('/customer/overview');
  await expect(page.getByLabel('Switch website')).toBeVisible(); const header = page.locator('.app-header'); await expect(header).toHaveCSS('position', 'sticky');
  const initialHeader = await header.boundingBox(); const heading = await page.getByRole('heading', { name: 'Overview', exact: true }).boundingBox(); expect(heading!.y).toBeGreaterThanOrEqual(initialHeader!.y + initialHeader!.height);
  await page.evaluate(() => window.scrollTo({ top: 650, behavior: 'instant' })); await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(300);
  expect(Math.abs((await header.boundingBox())!.y)).toBeLessThan(1);
  const more = page.getByRole('button', { name: 'More', exact: true }); await more.click(); const menu = page.getByRole('dialog', { name: 'Customer portal' });
  await expect(menu).toBeVisible();
  for (const path of ['subscription','billing','notifications','profile']) await expect(menu.locator(`a[href="/customer/${path}"]`)).toBeVisible();
  await page.keyboard.press('Escape'); await expect(more).toBeFocused();
  await header.getByRole('link', { name: 'Notifications', exact: true }).click(); await expect(page).toHaveURL(/\/customer\/notifications$/);
});

test('overview loading errors and logout failures are recoverable', async ({ page }) => {
  let failed = true; let logoutFailed = true; let logouts = 0;
  await fixture(page, { overviewError: () => failed, logoutError: () => logoutFailed, onLogout: () => { logouts++; } }); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/customer/overview');
  await expect(page.getByText('Overview temporarily unavailable. Please retry.')).toBeVisible(); failed = false; await page.getByRole('button', { name: /retry|try again/i }).click();
  await expect(page.getByRole('heading', { name: 'Overview', exact: true })).toBeVisible(); await page.getByRole('button', { name: 'More', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Customer portal' }); await menu.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(menu.getByRole('alert')).toHaveText('Sign out did not complete. Please try again.');
  logoutFailed = false; await menu.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page).toHaveURL(/\/customer\/login$/); expect(logouts).toBe(2);
});

test('signed-out visitors still need authentication and signup remains available', async ({ page }) => {
  await fixture(page, { authenticated: false }); await page.goto('/customer/overview'); await expect(page).toHaveURL(/\/customer\/login$/); await expect(page.getByLabel('Email address', { exact: true })).toBeVisible();
  await expect(page.locator('a[href="/customer/register"]')).toBeVisible(); await expect(page.locator('.cw-mobile-nav')).toHaveCount(0);
});

test('desktop header and public login styles stay unchanged; reduced motion is respected', async ({ page }) => {
  await fixture(page); await page.setViewportSize({ width: 1440, height: 900 }); await page.goto('/customer/overview'); await expect(page.getByLabel('Switch website')).toBeVisible(); await expect(page.locator('.app-header')).toHaveCSS('position', 'relative');
  await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' }); await expect(page.locator('[data-overview-tool="seo"]')).toHaveCSS('transition-duration', '0s');
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/customer/login'); await expect(page.locator('.app-shell--customer')).toHaveCount(0); await expect(page.locator('.app-header')).not.toHaveCSS('position', 'sticky');
});
