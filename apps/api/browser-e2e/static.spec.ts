import { spawnSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { captureStaticDocument } from '../src/modules/care/static-browser.js';
const source = '<!doctype html><html lang="en"><head><title>Fixture page</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}#private{width:200px;height:50px;background:white;color:red}</style></head><body><div id="private"><span id="private-name">PRIVATE CUSTOMER VALUE</span></div><main><h1>Public heading</h1><p aria-labelledby="private-name">Public paragraph</p><details><summary>Read details</summary><p>Fixture details</p></details><a href="https://example.test/">Disabled external link</a></main></body></html>';
const input = { source, toolId: 'T25' as const, viewport: 'DESKTOP' as const, privateIds: ['private'] };
// Only fixed synthetic fixtures reach this test-provided browser. Production always uses the sandbox launcher.
test('renders offline with real Chromium and closes the disposable context', async ({ browser }) => {
  const before = browser.contexts().length;
  const result = await captureStaticDocument(browser, input);
  expect(result.report).toMatchObject({ rendered: true, blockedRequests: 0, privateRegionCount: 1, viewport: { width: 1280, height: 900 } });
  expect(browser.contexts()).toHaveLength(before); expect(result.screenshot).toBeUndefined();
});
test('redacts private text and external ARIA references from the actual accessibility tree', async ({ browser }) => {
  const { report } = await captureStaticDocument(browser, { ...input, toolId: 'T26' });
  expect(report.accessibilitySnapshot).toContain('Public heading');
  expect(report.accessibilitySnapshot).not.toContain('PRIVATE CUSTOMER VALUE');
  expect(report.accessibilitySnapshot).toContain('Public paragraph');
});
test('captures the approved viewport with opaque black masking and sanitized PNG pixels', async ({ browser }) => {
  const { screenshot, report } = await captureStaticDocument(browser, { ...input, toolId: 'T27', viewport: 'MOBILE' });
  expect(report.screenshotDigest).toMatch(/^[a-f0-9]{64}$/);
  const meta = await sharp(screenshot!).metadata(); expect(meta).toMatchObject({ width: 390, height: 844, format: 'png' }); expect(meta.exif).toBeUndefined();
  const pixels = await sharp(screenshot!).extract({ left: 5, top: 5, width: 100, height: 30 }).removeAlpha().raw().toBuffer();
  expect(pixels.every((value) => value === 0)).toBe(true);
});
test('executes the registered disclosure journey and detects viewport overflow', async ({ browser }) => {
  const result = await captureStaticDocument(browser, { ...input, toolId: 'T28' });
  expect(result.report.journey).toMatchObject({ id: 'static-document-v1', passed: true, disclosure: { state: 'CHECKED', passed: true } });
  const hiddenFirst = await captureStaticDocument(browser, { ...input, toolId: 'T28', source: source.replace('<details>', '<details style="display:none"><summary>Hidden fixture</summary><p>Hidden</p></details><details>') });
  expect(hiddenFirst.report.journey).toMatchObject({ disclosure: { state: 'CHECKED', passed: true } });
  const overflow = await captureStaticDocument(browser, { ...input, toolId: 'T28', viewport: 'MOBILE', source: source.replace('<main>', '<main style="width:2000px">') });
  expect(overflow.report.journey).toMatchObject({ passed: false, checks: expect.arrayContaining([{ name: 'viewport-overflow', passed: false }]) });
});
test('rejects missing, duplicate and overlapping private regions and closes failed contexts', async ({ browser }) => {
  for (const [sourceValue, privateIds] of [[source, ['missing']], [source.replace('<main>', '<main id="private">'), ['private']], [source, ['private', 'private-name']]] as const) {
    await expect(captureStaticDocument(browser, { ...input, source: sourceValue, privateIds: [...privateIds] })).rejects.toMatchObject({ code: 'PRIVATE_REGION_INVALID' });
  }
  expect(browser.contexts()).toHaveLength(0);
});

test('built preflight loads its runtime dependencies and fails closed for a root service', () => {
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', "process.getuid = () => 0; await import('./apps/api/dist/scripts/care-browser-preflight.js');"], { encoding: 'utf8', timeout: 10000 });
  expect(child.status, child.stderr).toBe(1);
  expect(JSON.parse(child.stdout)).toMatchObject({ state: 'BLOCKED', code: 'BROWSER_SANDBOX_REQUIRED' });
});
