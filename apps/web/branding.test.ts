import { describe, expect, it } from 'vitest';
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
