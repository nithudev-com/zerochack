import { createHash } from 'node:crypto';
import { parse, serialize, type DefaultTreeAdapterMap } from 'parse5';
import { z } from 'zod';
import sharp from 'sharp';
import { CareError, looksSensitive } from './vault.js';

export const STATIC_POLICY_VERSION = 'static-html-v1';
export const MAX_SOURCE_BYTES = 200_000;
export const digestBytes = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
type HtmlNode = DefaultTreeAdapterMap['node'];
const allowed = new Set('html head title meta body main header footer nav section article aside div span p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd a img picture source button table thead tbody tfoot tr td th caption colgroup col br hr strong em b i u s small code pre blockquote figure figcaption details summary time address abbr sup sub style'.split(' '));
const structural = new Set(['html','head','body']);
export function inspectStaticHtml(source: string) {
  if (!source.trim() || Buffer.byteLength(source) > MAX_SOURCE_BYTES || source.includes('\0')) throw new CareError('SOURCE_LIMIT', 'Use a standalone HTML page up to 200 KB.');
  if (looksSensitive(source) || /<\?(?:php|=)|<%|\{\{|\{%/i.test(source)) throw new CareError('SENSITIVE_OR_DYNAMIC_SOURCE', 'Source contains possible credentials or server templates. Remove sensitive data; this worker supports static HTML only.');
  const errors: string[] = []; const tree = parse(source); const queue: HtmlNode[] = [tree]; const ids = new Set<string>(); let count = 0; let viewport = false; let title = false; let lang = false;
  while (queue.length) {
    const node = queue.pop()!; if (++count > 10000) throw new CareError('SOURCE_LIMIT', 'The page exceeds the supported structure limit.');
    if ('childNodes' in node) queue.push(...node.childNodes);
    if (!('tagName' in node)) continue;
    if (!allowed.has(node.tagName) || node.namespaceURI !== 'http://www.w3.org/1999/xhtml') throw new CareError('UNSUPPORTED_STACK', 'This workflow supports standalone HTML and inline CSS, without scripts, forms, embeds, or build steps.');
    const attrs = new Map(node.attrs.map((attr) => [attr.name, attr.value]));
    for (const [name, value] of attrs) {
      if (/^on|^(?:srcdoc|formaction|action|ping|autofocus|autoplay|integrity|nonce)$/i.test(name) || /javascript\s*:|vbscript\s*:/i.test(value)) throw new CareError('ACTIVE_CONTENT_BLOCKED', 'Active event handlers or unsafe URLs are unsupported.');
      if (['src','srcset','poster','background'].includes(name) && value && !/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/i.test(value)) throw new CareError('EXTERNAL_DEPENDENCY', 'Bundle image assets as reviewed PNG/JPEG/WebP data URLs for this standalone workflow.');
      if (name === 'href' && value && !/^(?:#[\w-]*|https?:\/\/[^\s]+|mailto:[^\s]+|tel:[+\d ()-]+)$/i.test(value)) throw new CareError('EXTERNAL_DEPENDENCY', 'Use explicit HTTPS links or local fragment links in this standalone page.');
      if (name === 'style') checkCss(value);
    }
    if (node.tagName === 'style') checkCss(node.childNodes.filter((child) => child.nodeName === '#text').map((child) => 'value' in child ? child.value : '').join(''));
    if (node.tagName === 'meta' && attrs.has('http-equiv')) throw new CareError('ACTIVE_CONTENT_BLOCKED', 'HTTP-equivalent metadata is unsupported.');
    if (node.tagName === 'html') lang = Boolean(attrs.get('lang'));
    if (node.tagName === 'meta' && attrs.get('name')?.toLowerCase() === 'viewport') viewport = true;
    if (node.tagName === 'title') title = node.childNodes.some((child) => 'value' in child && child.value.trim());
    if (node.tagName === 'img' && !attrs.has('alt')) errors.push('IMAGE_ALT_MISSING');
    const id = attrs.get('id'); if (id && ids.has(id)) errors.push('DUPLICATE_ID'); if (id) ids.add(id);
  }
  if (!lang) errors.push('LANGUAGE_MISSING'); if (!viewport) errors.push('VIEWPORT_MISSING'); if (!title) errors.push('TITLE_MISSING');
  return { policy: STATIC_POLICY_VERSION, digest: digestBytes(source), bytes: Buffer.byteLength(source), nodes: count, errors: [...new Set(errors)], executableCodeRun: false as const };
}
function checkCss(value: string) {
  value = value.replace(/\/\*[\s\S]*?\*\//g, '');
  if (value.length > 100000 || /url\s*\(|@import|image-set\s*\(|image\s*\(|paint\s*\(|src\s*\(|@font-face|@namespace|@counter-style|@document|expression\s*\(|-moz-binding|behavior\s*:|\\|\u0000/i.test(value)) throw new CareError('EXTERNAL_DEPENDENCY', 'CSS must be self-contained without external resources or active expressions.');
}
export function staticPreview(source: string): string {
  inspectStaticHtml(source); const document = parse(source); const queue: HtmlNode[] = [document];
  while (queue.length) {
    const node = queue.pop()!; if ('childNodes' in node) queue.push(...node.childNodes);
    if (!('tagName' in node)) continue;
    node.attrs = node.attrs.filter((attr) => !['href','target','download','name'].includes(attr.name) || structural.has(node.tagName) || node.tagName === 'meta');
    if (['input','textarea','select','button'].includes(node.tagName)) node.attrs.push({ name: 'disabled', value: '' });
  }
  const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'";
  return serialize(document).replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`);
}
const patchSchema = z.object({ summary: z.string().min(1).max(1000), replacements: z.array(z.object({ before: z.string().min(1).max(50000), after: z.string().max(50000) }).strict()).min(1).max(20) }).strict();
export function applyStaticProposal(source: string, raw: string) {
  if (Buffer.byteLength(raw) > 200_000) throw new CareError('PATCH_INVALID', 'Provider output exceeds the patch limit.');
  let proposal: z.infer<typeof patchSchema>;
  try { proposal = patchSchema.parse(JSON.parse(raw)); } catch { throw new CareError('PATCH_INVALID', 'The provider did not return a valid bounded patch.'); }
  if (looksSensitive(proposal.summary)) throw new CareError('PATCH_INVALID', 'Patch summary contains possible credentials.');
  let candidate = source; let changed = 0;
  for (const item of proposal.replacements) {
    const index = candidate.indexOf(item.before);
    if (index < 0 || candidate.indexOf(item.before, index + item.before.length) !== -1) throw new CareError('PATCH_CONFLICT', 'A patch anchor is missing or ambiguous.');
    changed += Buffer.byteLength(item.before) + Buffer.byteLength(item.after);
    if (changed > Math.max(10000, Buffer.byteLength(source))) throw new CareError('PATCH_SCOPE_EXCEEDED', 'The proposed change exceeds the approved narrow patch boundary.');
    candidate = candidate.slice(0, index) + item.after + candidate.slice(index + item.before.length);
  }
  if (candidate === source) throw new CareError('PATCH_EMPTY', 'No source change was proposed.');
  const baseline = inspectStaticHtml(source); const verification = inspectStaticHtml(candidate);
  if (verification.errors.length) throw new CareError('VERIFICATION_FAILED', 'The candidate did not pass the independent static HTML checks.');
  return { candidate, summary: proposal.summary, verification: { ...verification, baselineErrors: baseline.errors, changedBytes: changed, checks: ['static-policy','no-executable-content','no-external-resources','language','viewport','title','image-alternatives','unique-identifiers'], limitations: ['Visual appearance and requested behavior require customer review.', 'No JavaScript, backend, browser automation, or full WCAG audit was executed.'] } };
}
export async function sanitizeScreenshot(bytes: Buffer): Promise<Buffer> {
  if (bytes.length > 2_000_000 || !(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.subarray(0,3).equals(Buffer.from([255,216,255])))) throw new CareError('ATTACHMENT_TYPE', 'Use a PNG or JPEG screenshot up to 2 MB.');
  try { const sanitized = await sharp(bytes, { limitInputPixels: 12_000_000, failOn: 'warning', animated: false }).rotate().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true }).png().toBuffer(); if (sanitized.length > 4_000_000) throw new Error('image size'); return sanitized; }
  catch { throw new CareError('ATTACHMENT_INVALID', 'The screenshot could not be decoded within the image limits.'); }
}
export function assertStaticTarget(path: string) {
  if (!/^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/){1,12}index\.html$/.test(path) || path.split('/').some((part) => part.startsWith('.'))) throw new CareError('TARGET_PATH_INVALID', 'Choose an absolute web-root path ending in index.html, without hidden or parent directories.');
}
