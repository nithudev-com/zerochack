from pathlib import Path

def change(name,before,after):
 p=Path(name);text=p.read_text()
 if text.count(before)!=1: raise RuntimeError('Unexpected branding anchor: '+name)
 p.write_text(text.replace(before,after,1))
for name in ['owner-nav.tsx','customer-support.tsx']:
 change('apps/web/components/'+name,"'use client';","'use client';\nimport { BrandLogo } from './brand-logo';")
change('apps/web/components/owner-nav.tsx','<span>ZR</span>','<BrandLogo variant="mark" decorative />')
change('apps/web/components/customer-support.tsx','aria-hidden="true">ZR</div>','aria-hidden="true"><BrandLogo variant="mark" decorative /></div>')
p=Path('apps/web/app/branding.css');p.write_text(p.read_text()+'\n.customer-sidebar-title > .cb-brand { background:#050509; padding:0; }\n.support-list-mark--agent > .cb-brand { width:32px; height:32px; }\n')
change('README.md','# CodeBandage\n','# CodeBandage\n\n<img src="apps/web/public/brand/codebandage-logo.webp" alt="CodeBandage" width="240" />\n')
# The trust boundary is unchanged: a fixed same-origin UI avatar is allowed, untrusted Markdown images are not.
change('apps/web/care-e2e/chat.spec.ts',"await expect(page.locator('.care-message img')).toHaveCount(0);",'''const avatars=page.locator('.care-message img');
  await expect(avatars).toHaveCount(1);
  await expect(avatars).toHaveAttribute('src','/brand/codebandage-mark.png');
  await expect(avatars).toHaveAttribute('alt','');
  await expect(page.locator('.care-message > :not(.care-message-label) img')).toHaveCount(0);''')
change('apps/web/care-e2e/chat.spec.ts',"test('untrusted Markdown cannot load remote images or render raw HTML', async ({ page }) => {",'''test('untrusted Markdown cannot load remote images or render raw HTML', async ({ page }) => {
  let remoteImages=0;
  await page.route('https://invalid.example.test/pixel', route => { remoteImages++; return route.abort(); });''')
change('apps/web/care-e2e/chat.spec.ts',"await expect(page.locator('.care-message a[href^=\"javascript:\"]')).toHaveCount(0);", "await expect(page.locator('.care-message a[href^=\"javascript:\"]')).toHaveCount(0);\n  expect(remoteImages).toBe(0);")
Path('apps/web/branding.test.ts').write_text(r'''import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

async function sources(directory: string): Promise<string[]> {
  const result: string[]=[];
  for (const entry of await readdir(directory,{withFileTypes:true})) {
    const file=path.join(directory,entry.name);
    if (entry.isDirectory()) result.push(...await sources(file));
    else if (/\.tsx?$/.test(entry.name)) result.push(file);
  }
  return result;
}
describe('CodeBandage visible branding regression guard', () => {
  it('has no former product labels or lettermarks in current web surfaces', async () => {
    for (const root of ['apps/web/components','apps/web/app']) {
      for (const file of await sources(root)) expect(await readFile(file,'utf8'),file).not.toMatch(/ZeroRoot|Zero Root|>ZR<|>Z</);
    }
  });
  it('retains the verified customer artwork and correctly sized icons/social card', async () => {
    const source=await readFile('apps/web/public/brand/codebandage-source.webp');
    expect(createHash('sha256').update(source).digest('hex')).toBe('4cc14fe063f69b66785e44f10e5645ae9b70e608feed93492dd385e56735965b');
    const images: Array<[string,number,number]>=[['public/brand/icon-192.png',192,192],['public/brand/icon-512.png',512,512],['public/brand/icon-maskable-512.png',512,512],['public/brand/apple-touch-icon.png',180,180],['public/brand/favicon-32.png',32,32],['app/opengraph-image.png',1200,630]];
    for (const [file,width,height] of images) {
      const png=await readFile(`apps/web/${file}`); expect(png.subarray(1,4).toString()).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(width); expect(png.readUInt32BE(20)).toBe(height);
    }
  });
});
''')
print('Updated remaining lettermarks and strict branding/Markdown regression coverage.')
