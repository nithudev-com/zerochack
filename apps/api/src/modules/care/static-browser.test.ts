import { describe, expect, it, vi } from 'vitest';
import { browserLaunchOptions, captureStaticDocument, runStaticBrowser } from './static-browser.js';
import type { Browser } from 'playwright';
const input = { source: '<html><head><title>Fixture</title></head><body>Fixture</body></html>', toolId: 'T25' as const, viewport: 'DESKTOP' as const, privateIds: [] };
describe('static browser boundaries', () => {
  it('keeps the sandbox required and excludes inherited credentials and proxies', () => {
    const options = browserLaunchOptions('/tmp/fixture');
    expect(options.chromiumSandbox).toBe(true);
    expect(Object.keys(options.env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR', 'TZ']);
    expect(options.args.join(' ')).not.toContain('--no-sandbox');
  });
  it('rejects root execution before launching a browser', async () => {
    const uid = vi.spyOn(process, 'getuid').mockReturnValue(0);
    try { await expect(runStaticBrowser(input)).rejects.toMatchObject({ code: 'BROWSER_SANDBOX_REQUIRED' }); } finally { uid.mockRestore(); }
  });
  it('rejects unsupported source and invalid private selections before browser interaction', async () => {
    const browser = { newContext: vi.fn() } as unknown as Browser;
    await expect(captureStaticDocument(browser, { ...input, source: '<script>fixture()</script>' })).rejects.toMatchObject({ code: 'UNSUPPORTED_STACK' });
    await expect(captureStaticDocument(browser, { ...input, privateIds: ['bad selector'] })).rejects.toMatchObject({ code: 'BROWSER_INPUT_INVALID' });
    await expect(captureStaticDocument(browser, { ...input, source: '<img src="https://example.test/photo.png" alt="Fixture">' })).rejects.toMatchObject({ code: 'EXTERNAL_DEPENDENCY' });
    const mislabeledImage = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>').toString('base64');
    const entityEncoded = `&#${mislabeledImage.charCodeAt(0)};${mislabeledImage.slice(1)}`;
    for (const image of [mislabeledImage, entityEncoded]) await expect(captureStaticDocument(browser, { ...input, source: `<img alt="Fixture" src="data:image/png;base64,${image}">` })).rejects.toMatchObject({ code: 'BROWSER_IMAGE_LIMIT' });
    expect(browser.newContext).not.toHaveBeenCalled();
  });
});
