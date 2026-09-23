import sharp from 'sharp';
import { CareError } from './vault.js';

let active = 0;
/** Stored, privacy-reviewed PNG artifacts only. This is not a renderer or masking service. */
export async function compareStoredScreenshots(before: Buffer, after: Buffer) {
  if (active >= 2) throw new CareError('CHECK_BUSY', 'Image comparison is busy. Retry shortly.');
  const png = Buffer.from([137,80,78,71,13,10,26,10]);
  if ([before, after].some((bytes) => bytes.length > 4000000 || !bytes.subarray(0, 8).equals(png))) throw new CareError('IMAGE_INVALID', 'Comparison requires two sanitized PNG artifacts within the storage limit.');
  active++;
  try {
    const decode = async (bytes: Buffer) => sharp(bytes, { limitInputPixels: 5760000, failOn: 'warning', animated: false }).timeout({ seconds: 5 }).flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const decoded = await Promise.allSettled([decode(before), decode(after)]);
    if (decoded[0]!.status !== 'fulfilled' || decoded[1]!.status !== 'fulfilled') throw new CareError('IMAGE_INVALID', 'The stored images could not be decoded within the comparison limits.');
    const a = decoded[0]!.value; const b = decoded[1]!.value;
    const limitation = 'Pixel comparison of supplied sanitized screenshots on white, threshold 16/255 in any RGB channel. Renderer, viewport, fonts, privacy masking and capture provenance are not independently verified. No accessibility or layout correctness claim.';
    if (a.info.width !== b.info.width || a.info.height !== b.info.height) return { state: 'INCOMPARABLE', baseline: { width: a.info.width, height: a.info.height }, candidate: { width: b.info.width, height: b.info.height }, limitation };
    const { width, height } = a.info; let changed = 0; let minX = width; let minY = height; let maxX = -1; let maxY = -1;
    for (let pixel = 0; pixel < width * height; pixel++) {
      const index = pixel * 3;
      if ([0,1,2].some((channel) => Math.abs(a.data[index + channel]! - b.data[index + channel]!) > 16)) {
        changed++; const x = pixel % width; const y = Math.floor(pixel / width);
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
    }
    return { state: changed ? 'PIXEL_DIFFERENCES' : 'NO_PIXEL_DIFFERENCES_ABOVE_THRESHOLD', width, height, threshold: 16, changedPixels: changed, changedRatio: changed / (width * height), bounds: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null, limitation };
  } catch (error) { if (error instanceof CareError) throw error; throw new CareError('IMAGE_INVALID', 'The stored images could not be decoded within the comparison limits.'); }
  finally { active--; }
}
