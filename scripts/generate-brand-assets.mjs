import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

// Fixed customer artwork only. No remote resources, arbitrary SVG, or uploaded instructions.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'apps/web/public/brand');
const source = await readFile(path.join(output, 'codebandage-source.webp'));
const expected = '4cc14fe063f69b66785e44f10e5645ae9b70e608feed93492dd385e56735965b';
if (createHash('sha256').update(source).digest('hex') !== expected) throw new Error('Unexpected CodeBandage source artwork');
await mkdir(output, { recursive:true });
const background = '#050509';
const mark = await sharp(source).extract({left:58,top:88,width:396,height:285}).png().toBuffer();
const wordmark = await sharp(source).extract({left:16,top:374,width:484,height:94}).webp({quality:92}).toBuffer();
await writeFile(path.join(output,'codebandage-wordmark.webp'),wordmark);
await sharp(source).extract({left:16,top:89,width:484,height:379}).webp({quality:92}).toFile(path.join(output,'codebandage-logo.webp'));
for (const [name,size,scale] of [['codebandage-mark.png',192,0.88],['icon-192.png',192,0.88],['icon-512.png',512,0.88],['icon-maskable-512.png',512,0.69],['apple-touch-icon.png',180,0.80],['favicon-32.png',32,0.94]]) {
  const inner=Math.floor(size*scale);
  const glyph=await sharp(mark).resize(inner,inner,{fit:'contain',background}).png().toBuffer();
  await sharp({create:{width:size,height:size,channels:3,background}}).composite([{input:glyph,gravity:'centre'}]).png({compressionLevel:9}).toFile(path.join(output,name));
}
// Compatibility path used by previously cached pages, now showing the new symbol.
const icon = await readFile(path.join(output,'icon-192.png'));
await writeFile(path.join(root,'apps/web/public/icon.svg'),`<svg xmlns="http://www.w3.org/2000/svg" width="192" height="192" viewBox="0 0 192 192"><title>CodeBandage</title><image width="192" height="192" href="data:image/png;base64,${icon.toString('base64')}"/></svg>\n`);
const favicon = await readFile(path.join(output,'favicon-32.png'));
const ico=Buffer.alloc(22); ico.writeUInt16LE(1,2); ico.writeUInt16LE(1,4); ico[6]=32; ico[7]=32; ico.writeUInt16LE(1,10); ico.writeUInt16LE(32,12); ico.writeUInt32LE(favicon.length,14); ico.writeUInt32LE(22,18);
await writeFile(path.join(root,'apps/web/app/favicon.ico'),Buffer.concat([ico,favicon]));
const emailLogo=await sharp(wordmark).resize(300,58).png({palette:true,colours:128,compressionLevel:9}).toBuffer();
await writeFile(path.join(output,'codebandage-email.png'),emailLogo);
await writeFile(path.join(root,'packages/email/src/brand-asset.ts'),`/** Generated from the supplied CodeBandage logo. No runtime file/network access. */\nexport const emailLogoBase64 = '${emailLogo.toString('base64')}';\n`);
// Social card is generated once from reviewed text and the verified logo.
const text=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"><rect width="1200" height="630" fill="#050509"/><path d="M530 82V548" stroke="#28314b"/><g font-family="sans-serif" fill="#ffffff"><text x="585" y="168" font-size="29">AI Website Security &amp; Repair</text><text x="585" y="280" font-size="49" font-weight="700">Review. Repair.</text><text x="585" y="347" font-size="49" font-weight="700" fill="#43def3">Verify.</text><text x="585" y="447" font-size="25" fill="#b7bfd3">Your website. You stay in control.</text><text x="585" y="495" font-size="20" fill="#b7bfd3">Websites · APIs · Servers · DevOps</text></g></svg>`);
const logo=await sharp(source).extract({left:16,top:89,width:484,height:379}).resize(444).png().toBuffer();
await sharp(text).composite([{input:logo,left:44,top:136}]).png().toFile(path.join(root,'apps/web/app/opengraph-image.png'));
await writeFile(path.join(output,'provenance.json'),JSON.stringify({brand:'CodeBandage',source:'User-supplied CodeBandage AI Logo(1).png; optimized to 512px and flattened on #050509',optimizedSourceSha256:expected,derivatives:'Crops/resizes of the supplied artwork; not AI-generated replacement artwork',internalNamesPreserved:true},null,2)+'\n');
console.log('Generated CodeBandage logos, icons, email artwork and social card from verified supplied artwork.');
