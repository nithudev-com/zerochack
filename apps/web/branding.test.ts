import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

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
    expect(createHash('sha256').update(source).digest('hex')).toBe('edafbe3ebb4eada7719e7f312b4d8fd083f72f44bf3f30e95c2b776c56743b10');
    const sourceMetadata = await sharp(source).metadata();
    expect([sourceMetadata.width, sourceMetadata.height, sourceMetadata.hasAlpha]).toEqual([2172,724,true]);
    for (const file of ['codebandage-logo.webp','codebandage-logo.png','codebandage-wordmark.webp','codebandage-mark.png','codebandage-email.png','favicon-32.png','icon-512.png']) {
      const { data, info } = await sharp(await readFile('apps/web/public/brand/'+file)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
      expect(info.channels).toBe(4);
      for (const pixel of [0,info.width-1,(info.height-1)*info.width,info.width*info.height-1]) expect(data[pixel*4+3],file).toBe(0);
    }
    const images: Array<[string,number,number]>=[['public/brand/icon-192.png',192,192],['public/brand/icon-512.png',512,512],['public/brand/icon-maskable-512.png',512,512],['public/brand/apple-touch-icon.png',180,180],['public/brand/favicon-32.png',32,32],['app/opengraph-image.png',1200,630]];
    for (const [file,width,height] of images) {
      const png=await readFile(`apps/web/${file}`); expect(png.subarray(1,4).toString()).toBe('PNG');
      expect(png.readUInt32BE(16)).toBe(width); expect(png.readUInt32BE(20)).toBe(height);
    }
  });
});
