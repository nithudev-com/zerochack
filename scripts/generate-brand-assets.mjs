import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'apps/web/public/brand');
const source = await readFile(path.join(output, 'codebandage-source.webp'));
const expected = 'edafbe3ebb4eada7719e7f312b4d8fd083f72f44bf3f30e95c2b776c56743b10';
if (createHash('sha256').update(source).digest('hex') !== expected) throw new Error('Unexpected CodeBandage source artwork');
const metadata = await sharp(source).metadata();
if (metadata.width !== 2172 || metadata.height !== 724 || !metadata.hasAlpha) throw new Error('Expected transparent horizontal source');
await mkdir(output, { recursive: true });
const transparent = { r:0, g:0, b:0, alpha:0 };
const markCrop = { left:98, top:109, width:535, height:531 };
const wordmarkCrop = { left:660, top:284, width:1416, height:225 };
const mark = await sharp(source).extract(markCrop).png().toBuffer();
const wordmark = await sharp(source).extract(wordmarkCrop).webp({ lossless:true }).toBuffer();
await writeFile(path.join(output, 'codebandage-wordmark.webp'), wordmark);
const horizontal = await sharp({ create:{ width:1200, height:240, channels:4, background:transparent } })
  .composite([
    { input:await sharp(mark).resize(220,220,{fit:'contain',background:transparent}).png().toBuffer(), left:0, top:10 },
    { input:await sharp(wordmark).resize(940).png().toBuffer(), left:250, top:45 }
  ]).png().toBuffer();
await writeFile(path.join(output,'codebandage-logo.png'),horizontal);
await sharp(horizontal).resize(600,120).webp({lossless:true}).toFile(path.join(output,'codebandage-logo.webp'));
for (const [name,size,scale] of [['codebandage-mark.png',192,0.96],['icon-192.png',192,0.88],['icon-512.png',512,0.88],['icon-maskable-512.png',512,0.69],['apple-touch-icon.png',180,0.80],['favicon-32.png',32,0.94]]) {
  const inner=Math.floor(size*scale);
  const glyph=await sharp(mark).resize(inner,inner,{fit:'contain',background:transparent}).png().toBuffer();
  await sharp({create:{width:size,height:size,channels:4,background:transparent}}).composite([{input:glyph,gravity:'centre'}]).png({compressionLevel:9}).toFile(path.join(output,name));
}
const icon=await readFile(path.join(output,'icon-192.png'));
await writeFile(path.join(root,'apps/web/public/icon.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><title>CodeBandage</title><image width="192" height="192" href="data:image/png;base64,${icon.toString('base64')}"/></svg>\n`);
const favicon=await readFile(path.join(output,'favicon-32.png'));
const ico=Buffer.alloc(22); ico.writeUInt16LE(1,2); ico.writeUInt16LE(1,4); ico[6]=32; ico[7]=32; ico.writeUInt16LE(1,10); ico.writeUInt16LE(32,12); ico.writeUInt32LE(favicon.length,14); ico.writeUInt32LE(22,18);
await writeFile(path.join(root,'apps/web/app/favicon.ico'),Buffer.concat([ico,favicon]));
const emailLogo=await sharp(horizontal).resize(300,60).png({compressionLevel:9}).toBuffer();
await writeFile(path.join(output,'codebandage-email.png'),emailLogo);
await writeFile(path.join(root,'packages/email/src/brand-asset.ts'),`/** Generated from the reviewed transparent CodeBandage artwork. No runtime file/network access. */\nexport const emailLogoBase64 = '${emailLogo.toString('base64')}';\n`);
// Bundle the licensed font so a minimal Docker image cannot silently render tofu.
const fontfile=path.join(root,'scripts/brand-fonts/LiberationSans-Regular.ttf');
if (createHash('sha256').update(await readFile(fontfile)).digest('hex') !== 'bade59d822652f76e6941aa87b40a87c13d1cc70db98ededb5011127efafd1d3') throw new Error('Unexpected social-card font');
const caption=async (text,size,color) => sharp({text:{text:`<span foreground="${color}">${text}</span>`,font:`Liberation Sans ${size}`,fontfile,rgba:true,dpi:72}}).png().toBuffer();
await sharp({create:{width:1200,height:630,channels:4,background:'#f8fbff'}}).composite([
  {input:await sharp(horizontal).resize(900,180).png().toBuffer(),left:76,top:65},
  {input:await caption('AI Website Security &amp; Repair',48,'#081a40'),left:76,top:300},
  {input:await caption('Review. Repair. Verify.',44,'#087cff'),left:76,top:385},
  {input:await caption('Your website. You stay in control.',26,'#425675'),left:76,top:490}
]).png().toFile(path.join(root,'apps/web/app/opengraph-image.png'));
await writeFile(path.join(output,'provenance.json'),JSON.stringify({
  brand:'CodeBandage', suppliedFile:'CodeBandageLogoEmblem.png',
  suppliedSha256:'a4b2e43b2ecda3e0d44190678f9ba42c5198400e406d666ee3f283cbab9c4f45',
  editMethod:'Built-in image editing: remove the white background; arrange emblem left and exact CodeBandage wordmark right; retain blue/navy identity; actual transparent alpha. This is an edited derivative, not a pixel-identical copy.',
  editedPngSha256:'ad5eaa64bd304c5ddf31a15954c0bf01058c69de3998a8f42a29a5afae4be886',
  optimizedSourceSha256:expected, sourceDimensions:{width:2172,height:724}, markCrop, wordmarkCrop,
  derivatives:'Deterministic crops, transparent resizes and horizontal composites. Social card has its own light canvas; logo files have no backplate.',
  darkSurfaceTreatment:'CSS renders only the wordmark white on dark surfaces; emblem colors are unchanged.',
  internalNamesPreserved:true
},null,2)+'\n');
console.log('Generated transparent horizontal CodeBandage assets, icons, email artwork and social card.');
