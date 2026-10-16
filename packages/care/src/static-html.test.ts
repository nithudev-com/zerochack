import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { applyStaticProposal, inspectStaticHtml, sanitizeScreenshot, staticPreview, assertStaticTarget } from './static-html.js';
const source = '<!doctype html><html lang="en"><head><title>Page</title><meta name="viewport" content="width=device-width, initial-scale=1"><style>h1{color:navy}</style></head><body><h1>Old heading</h1><a href="https://example.com">Visit</a></body></html>';
describe('bounded static HTML candidate pipeline', () => {
  it('applies an exact patch and verifies the result independently', () => {
    const result = applyStaticProposal(source, JSON.stringify({ summary: 'Corrected the heading.', replacements: [{ before: 'Old heading', after: 'Correct heading' }] }));
    expect(result.candidate).toContain('<h1>Correct heading</h1>'); expect(result.verification.errors).toEqual([]); expect(result.verification.executableCodeRun).toBe(false);
    expect(staticPreview(result.candidate)).toContain('Content-Security-Policy'); expect(staticPreview(result.candidate)).not.toContain('href=');
  });
  it('rejects unsupported executable stacks and external dependencies', () => {
    for (const content of ['<script>alert(1)</script>', '<form></form>', '<input type="password" value="private">', '<svg></svg>', '<img src="https://example.com/pixel">', '<style>p{background:image-set("https://example.com/pixel" 1x)}</style>', '<style>@im/**/port "https://example.com/a.css";</style>', '<style>@import "https://example.com/a.css";</style>', '<div onclick="alert(1)">x</div>', '<meta http-equiv="refresh" content="0;url=https://example.com">', '<?php echo 1; ?>']) expect(() => inspectStaticHtml(source.replace('<h1>Old heading</h1>', content))).toThrow();
  });
  it('rejects ambiguous patches, scope expansion, and failed checks', () => {
    const patch = (before: string, after: string) => JSON.stringify({ summary: 'A change', replacements: [{ before, after }] });
    expect(() => applyStaticProposal(source, patch('heading absent', 'x'))).toThrow();
    expect(() => applyStaticProposal(source, patch('>', '>'))).toThrow();
    expect(() => applyStaticProposal(source, patch('Old heading', 'x'.repeat(12000)))).toThrow();
    expect(() => applyStaticProposal(source, patch('<title>Page</title>', ''))).toThrow();
    expect(() => applyStaticProposal(source, patch('Old heading', '<script>alert(1)</script>'))).toThrow();
  });
  it('strips screenshot metadata and rejects invalid or excessive image input', async () => {
    const original = await sharp({ create: { width: 20, height: 20, channels: 3, background: 'white' } }).withMetadata({ exif: { IFD0: { Artist: 'private metadata' } } }).jpeg().toBuffer();
    const cleaned = await sanitizeScreenshot(original); expect((await sharp(cleaned).metadata()).exif).toBeUndefined();
    await expect(sanitizeScreenshot(Buffer.from('not an image'))).rejects.toThrow();
  });
  it('confines the release target to an explicit visible index.html path', () => {
    expect(() => assertStaticTarget('/var/www/site/index.html')).not.toThrow();
    for (const path of ['/etc/passwd','/var/www/../index.html','/var/www/.hidden/index.html','relative/index.html','/var/www/index.php']) expect(() => assertStaticTarget(path)).toThrow();
  });
});
