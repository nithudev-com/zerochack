import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import sharp from 'sharp';
import { digestBytes, inspectStaticHtml, staticPreview } from '@zerochack/care';
import { ApiError } from '../../errors.js';

export const BROWSER_POLICY = 'offline-static-browser-v1';
export const viewports = { MOBILE: { width: 390, height: 844 }, TABLET: { width: 768, height: 1024 }, DESKTOP: { width: 1280, height: 900 } } as const;
export type BrowserInput = { source: string; toolId: 'T25' | 'T26' | 'T27' | 'T28'; viewport: keyof typeof viewports; privateIds: string[] };
export type BrowserResult = { report: Record<string, unknown>; screenshot?: Buffer };
export type BrowserAdapter = (input: BrowserInput) => Promise<BrowserResult>;

// No environment flag, HTTP input or production fallback can disable the sandbox.
export function browserLaunchOptions(directory: string) {
  return { headless: true, chromiumSandbox: true, timeout: 10000, env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'C.UTF-8', TZ: 'UTC' },
    args: ['--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--host-resolver-rules=MAP * ~NOTFOUND'] };
}
let active = false;
export const runStaticBrowser: BrowserAdapter = async (input) => {
  inspectStaticHtml(input.source);
  if (process.platform !== 'linux' || !process.getuid || process.getuid() === 0) throw new ApiError(503, 'BROWSER_SANDBOX_REQUIRED', 'Browser tools require a non-root Linux service with the Chromium sandbox enabled.');
  if (active) throw new ApiError(429, 'BROWSER_BUSY', 'The browser worker is occupied. Try a new request later.');
  active = true;
  let directory: string | undefined; let browser: Browser | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), 'care-browser-'));
    try { browser = await chromium.launch(browserLaunchOptions(directory)); }
    catch { throw new ApiError(503, 'BROWSER_UNAVAILABLE', 'Install the pinned Chromium runtime and validate sandbox startup before enabling browser tools.'); }
    return await captureStaticDocument(browser, input);
  } finally {
    try { await browser?.close(); } finally { try { if (directory) await rm(directory, { recursive: true, force: true }); } finally { active = false; } }
  }
};

// A fresh browser is supplied by the production launcher; tests supply ONLY trusted synthetic fixtures.
// Never expose this function or a browser endpoint as an HTTP-controlled capability.
export async function captureStaticDocument(browser: Browser, input: BrowserInput): Promise<BrowserResult> {
  const inspection = inspectStaticHtml(input.source);
  if (!(input.viewport in viewports) || input.privateIds.length > 20 || new Set(input.privateIds).size !== input.privateIds.length || input.privateIds.some((id) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(id))) throw new ApiError(400, 'BROWSER_INPUT_INVALID', 'Use an approved viewport and unique simple element IDs.');
  // Bound embedded raster decoding before Chromium sees it. Metadata is not carried into evidence.
  let images = 0; let imagePixels = 0;
  for (const match of input.source.matchAll(/data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/=]+)/gi)) {
    if (++images > 20) throw new ApiError(400, 'BROWSER_IMAGE_LIMIT', 'Use at most 20 embedded images.');
    const metadata = await sharp(Buffer.from(match[1]!, 'base64'), { limitInputPixels: 4_000_000 }).metadata();
    imagePixels += (metadata.width ?? 0) * (metadata.height ?? 0);
    if (imagePixels > 8_000_000 || !metadata.width || !metadata.height || metadata.width * metadata.height > 4_000_000 || (metadata.pages ?? 1) !== 1) throw new ApiError(400, 'BROWSER_IMAGE_LIMIT', 'Use single-frame embedded images below four million pixels.');
  }
  const context = await browser.newContext({ viewport: viewports[input.viewport], deviceScaleFactor: 1, javaScriptEnabled: false, offline: true, serviceWorkers: 'block', acceptDownloads: false, permissions: [], locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light', reducedMotion: 'reduce' });
  const timer = setTimeout(() => { void context.close().catch(() => undefined); }, 20000);
  let blockedRequests = 0;
  try {
    await context.route('**/*', (route) => { blockedRequests++; return route.abort(); });
    const page = await context.newPage(); page.setDefaultTimeout(3000);
    const preview = staticPreview(input.source).replace('</head>', '<style>*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}</style></head>');
    await page.setContent(preview, { waitUntil: 'domcontentloaded', timeout: 5000 });
    const masks = input.privateIds.map((id) => page.locator(`[id="${id}"]`));
    for (const mask of masks) {
      if (await mask.count() !== 1 || !await mask.evaluate((element) => element instanceof HTMLElement && document.body.contains(element) && element !== document.body && !['STYLE', 'META', 'TITLE'].includes(element.tagName))) throw new ApiError(400, 'PRIVATE_REGION_INVALID', 'Every private ID must identify exactly one body content element.');
    }
    const overlapping = await page.evaluate((ids) => ids.some((id) => ids.some((other) => id !== other && document.getElementById(id)!.contains(document.getElementById(other)!))), input.privateIds);
    if (overlapping) throw new ApiError(400, 'PRIVATE_REGION_INVALID', 'Select the outer private region only; private IDs must not overlap.');
    // Replace private text as well as masking pixels. Accessible names may reference hidden nodes.
    await page.evaluate((ids) => {
      const privateNodes = ids.map((id) => document.getElementById(id)!);
      const referencedIds = new Set(privateNodes.flatMap((node) => [node.id, ...Array.from(node.querySelectorAll('[id]'), (child) => child.id)]));
      for (const node of document.querySelectorAll('[aria-labelledby],[aria-describedby]')) for (const attribute of ['aria-labelledby', 'aria-describedby']) {
        if ((node.getAttribute(attribute) ?? '').split(/\s+/).some((id) => referencedIds.has(id))) node.removeAttribute(attribute);
      }
      for (const node of privateNodes) {
        const box = node.getBoundingClientRect(); node.replaceChildren();
        for (const attribute of Array.from(node.attributes)) if (!['id', 'class', 'style'].includes(attribute.name)) node.removeAttribute(attribute.name);
        node.setAttribute('aria-hidden', 'true'); node.setAttribute('data-care-private', 'true');
        Object.assign(node.style, { width: `${box.width}px`, height: `${box.height}px`, boxSizing: 'border-box', overflow: 'hidden' });
      }
    }, input.privateIds);
    const report: Record<string, unknown> = { policy: BROWSER_POLICY, toolId: input.toolId, sourceDigest: digestBytes(input.source), renderer: `Chromium ${browser.version()}`, playwright: '1.62.1', viewport: viewports[input.viewport], privateRegionCount: input.privateIds.length, staticFindings: inspection.errors,
      boundary: 'Offline standalone HTML with inline CSS and reviewed raster images. Scripts, navigation, forms, external resources and downloads are disabled. Explicitly selected private regions are removed and masked; other content requires human privacy review. This is not a live-app, full accessibility or security certification.' };
    let screenshot: Buffer | undefined;
    if (input.toolId === 'T26') {
      const snapshot = await page.locator('body').ariaSnapshot({ timeout: 3000 });
      if (Buffer.byteLength(snapshot) > 100000) throw new ApiError(422, 'BROWSER_RESULT_LIMIT', 'The accessibility snapshot is too large.');
      report.accessibilitySnapshot = snapshot;
    }
    if (input.toolId === 'T28') {
      const checks = await page.evaluate(() => [
        { name: 'document-language', passed: Boolean(document.documentElement.lang.trim()) },
        { name: 'document-title', passed: Boolean(document.title.trim()) },
        { name: 'main-landmark', passed: document.querySelectorAll('main').length === 1 },
        { name: 'primary-heading', passed: document.querySelectorAll('h1').length === 1 },
        { name: 'viewport-overflow', passed: document.documentElement.scrollWidth <= window.innerWidth + 1 }
      ]);
      const summary = page.locator('details:not([data-care-private]) > summary:not([data-care-private])').first();
      let disclosure: { state: string; passed?: boolean } = { state: 'NOT_APPLICABLE' };
      if (await summary.count() && await summary.isVisible()) {
        const previous = await summary.evaluate((node) => (node.parentElement as HTMLDetailsElement).open);
        await summary.focus(); await summary.press('Enter');
        const changed = await summary.evaluate((node) => (node.parentElement as HTMLDetailsElement).open);
        disclosure = { state: 'CHECKED', passed: previous !== changed };
        await summary.evaluate((node, open) => { (node.parentElement as HTMLDetailsElement).open = open; }, previous);
      }
      report.journey = { id: 'static-document-v1', checks, disclosure, passed: checks.every((check) => check.passed) && disclosure.passed !== false };
    }
    if (input.toolId === 'T27') {
      const png = await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', mask: masks, maskColor: '#000000', timeout: 5000 });
      screenshot = await sharp(png, { limitInputPixels: 2_000_000 }).png().toBuffer();
      if (screenshot.length > 4_000_000) throw new ApiError(422, 'BROWSER_RESULT_LIMIT', 'The screenshot exceeds the artifact limit.');
      report.screenshotDigest = digestBytes(screenshot);
    }
    report.blockedRequests = blockedRequests;
    report.rendered = true;
    return { report, ...(screenshot ? { screenshot } : {}) };
  } finally { clearTimeout(timer); await context.close(); }
}
