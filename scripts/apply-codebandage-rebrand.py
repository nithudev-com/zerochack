"""One-time reviewed CodeBandage rebrand; preserve persisted and internal identifiers."""
from pathlib import Path
import subprocess
root=Path.cwd()
tracked=subprocess.check_output(['git','ls-files','-z']).decode().split('\0')
preserved={'packages/scanner/src/network.ts','apps/api/src/modules/care/external-observations.ts'}
for name in tracked:
 p=Path(name)
 if not name or name in preserved or '/migrations/' in name: continue
 if not (name.startswith(('apps/','packages/','docs/')) or name=='README.md'): continue
 if p.suffix not in {'.ts','.tsx','.md','.json','.txt','.svg','.css'}: continue
 try: text=p.read_text()
 except UnicodeDecodeError: continue
 updated=text.replace('ZeroRoot','CodeBandage').replace('Zero Root','CodeBandage').replace('/brand/zeroroot-logo.webp','/brand/codebandage-logo.webp')
 if updated!=text: p.write_text(updated)
def put(name,content):
 p=root/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(content.lstrip('\n'))
def change(name,before,after):
 p=root/name;text=p.read_text()
 if text.count(before)!=1: raise RuntimeError(f'Expected one reviewed anchor in {name}: {before[:75]}')
 p.write_text(text.replace(before,after,1))
put('apps/web/components/brand-logo.tsx','''
import Image from 'next/image';

/** Faithful crops of the customer-supplied artwork. Never stretch the source. */
export function BrandLogo({ variant = 'horizontal', priority = false, decorative = false }: {
  variant?: 'horizontal' | 'full' | 'mark'; priority?: boolean; decorative?: boolean;
}) {
  const eager = { loading: priority ? 'eager' as const : 'lazy' as const, fetchPriority: priority ? 'high' as const : 'auto' as const };
  if (variant === 'full') return <span className="cb-brand cb-brand--full"><Image src="/brand/codebandage-logo.webp" width={484} height={379} alt={decorative ? '' : 'CodeBandage'} unoptimized {...eager} /></span>;
  if (variant === 'mark') return <span className="cb-brand cb-brand--mark"><Image src="/brand/codebandage-mark.png" width={192} height={192} alt={decorative ? '' : 'CodeBandage'} unoptimized {...eager} /></span>;
  return <span className="cb-brand cb-brand--horizontal"><Image className="cb-brand__mark" src="/brand/codebandage-mark.png" width={192} height={192} alt="" unoptimized {...eager} /><Image className="cb-brand__wordmark" src="/brand/codebandage-wordmark.webp" width={484} height={94} alt={decorative ? '' : 'CodeBandage'} unoptimized {...eager} /></span>;
}
''')
change('apps/web/components/application-shell.tsx',"import Image from 'next/image';","import { BrandLogo } from './brand-logo';")
p=root/'apps/web/components/application-shell.tsx';text=p.read_text();start=text.index('function BrandLogo(');end=text.index('export function ApplicationShell',start);p.write_text(text[:start]+text[end:])
change('apps/web/components/auth-form.tsx',"import Link from 'next/link';","import Link from 'next/link';\nimport { BrandLogo } from './brand-logo';")
change('apps/web/components/auth-form.tsx','<section className="auth-copy"><span','<section className="auth-copy"><BrandLogo variant="full" /><span')
change('apps/web/app/page.tsx',"import Link from 'next/link';","import Link from 'next/link';\nimport { BrandLogo } from '../components/brand-logo';")
change('apps/web/app/page.tsx','<div>z<span>r</span><i>✳</i></div>','<div className="cb-core-mark"><BrandLogo variant="mark" decorative /></div>')
change('apps/web/components/home-preview.tsx',"'use client';","'use client';\nimport { BrandLogo } from './brand-logo';")
change('apps/web/components/home-preview.tsx','<span className="zr-mini-mark">Z</span>','<BrandLogo variant="mark" decorative />')
change('apps/web/components/owner-control.tsx',"'use client';","'use client';\nimport { BrandLogo } from './brand-logo';")
change('apps/web/components/owner-control.tsx','<b>Z</b>','<BrandLogo variant="mark" decorative />')
change('apps/web/components/care-chat.tsx',"import Link from 'next/link';","import Link from 'next/link';\nimport { BrandLogo } from './brand-logo';")
change('apps/web/components/care-chat.tsx','<strong>{message.type ===','<strong className="cb-agent-brand">{message.type === \'AI\' && <BrandLogo variant="mark" decorative />}{message.type ===')
put('apps/web/app/branding.css','''
/* CodeBandage artwork has white lettering: preserve its dark backplate in both themes. */
.cb-brand { display:inline-flex; flex:none; align-items:center; justify-content:center; overflow:hidden; background:#050509; border-radius:10px; vertical-align:middle; line-height:0; }
.cb-brand img { display:block; object-fit:contain; mix-blend-mode:normal; }
.cb-brand--horizontal { gap:7px; padding:5px 9px 5px 5px; }
.cb-brand--horizontal .cb-brand__mark { width:38px; height:38px; }
.cb-brand--horizontal .cb-brand__wordmark { width:155px; height:auto; }
.cb-brand--mark { width:40px; height:40px; }
.cb-brand--mark img { width:100%; height:100%; }
.cb-brand--full { width:min(260px,100%); }
.cb-brand--full img { width:100%; height:auto; }
.app-shell .brand--image { padding:0; border:0; background:transparent; min-width:0; }
.app-header .brand--image { flex-shrink:0; }
.brand--footer .cb-brand__wordmark { width:174px; }
.auth-copy > .cb-brand { margin-bottom:24px; }
.zr-core-graphic .cb-core-mark { width:174px; height:174px; display:flex; align-items:center; justify-content:center; letter-spacing:normal; transform:none; background:transparent; box-shadow:none; border:0; padding:0; }
.zr-core-graphic .cb-brand--mark { width:164px; height:164px; border-radius:28px; }
.owner-orbit > span > .cb-brand--mark { width:80px; height:80px; }
.zr-preview .cb-brand--mark { width:26px; height:26px; border-radius:6px; }
.cb-agent-brand { display:inline-flex; gap:8px; align-items:center; }
.cb-agent-brand .cb-brand--mark { width:24px; height:24px; border-radius:6px; }
@media(max-width:672px) {
 .app-header .cb-brand--horizontal { gap:4px; padding:4px 7px 4px 4px; }
 .app-header .cb-brand__mark { width:28px; height:28px; }
 .app-header .cb-brand__wordmark { width:112px; }
 .auth-copy > .cb-brand--full { width:190px; }
 .app-footer--branded { flex-wrap:wrap; gap:12px; }
 .zr-core-graphic .cb-brand--mark { width:140px; height:140px; }
}
@media(prefers-reduced-motion:reduce) { .cb-brand, .cb-brand * { animation:none!important; transition:none!important; } }
''')
change('apps/web/app/layout.tsx',"import './home.css';","import './home.css';\nimport './branding.css';")
change('apps/web/app/layout.tsx',"icons: { icon: [{ url: '/icon.svg', type: 'image/svg+xml' }], shortcut: '/icon.svg' },","icons: { icon: [{ url: '/brand/favicon-32.png', sizes: '32x32', type: 'image/png' }, { url: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' }], shortcut: '/brand/favicon-32.png', apple: [{ url: '/brand/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }] },")
for name in ['apps/web/app/layout.tsx','apps/web/app/page.tsx']:
 p=root/name;p.write_text(p.read_text().replace("'/opengraph-image'","'/opengraph-image.png'"))
put('apps/web/app/manifest.ts','''
import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'CodeBandage — AI Website Security & Repair', short_name: 'CodeBandage',
    description: 'Website care, source reviews, supported repairs and specialist-led recovery.',
    start_url: '/', scope: '/', display: 'standalone', background_color: '#050509', theme_color: '#050509',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/brand/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
}
''')
(root/'apps/web/app/opengraph-image.tsx').unlink()
put('apps/web/app/opengraph-image.alt.txt','CodeBandage — AI Website Security & Repair. Review, repair, verify.\n')
put('apps/web/app/opengraph-image/route.ts','''
import { NextResponse } from 'next/server';

export function GET(request: Request) {
  return NextResponse.redirect(new URL('/opengraph-image.png', request.url), 307);
}
''')
change('packages/reports/src/index.ts','generatedAt: string; data: Record<string, unknown>',"generatedAt: string; publisher?: { name: string; logoPath: string }; data: Record<string, unknown>")
change('apps/worker/src/report-worker.ts','generatedAt:generatedAt.toISOString(),data',"generatedAt:generatedAt.toISOString(),publisher:{name:'CodeBandage',logoPath:'/brand/codebandage-logo.webp'},data")
change('packages/email/src/index.ts',"import nodemailer from 'nodemailer';","import nodemailer from 'nodemailer';\nimport { emailLogoBase64 } from './brand-asset.js';")
change('packages/email/src/index.ts','export class SmtpEmailProvider','''
function escapeEmailHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}
export function renderBrandedEmail(text: string): string {
  return `<!doctype html><html lang="en"><body style="margin:0;padding:24px;background:#f8fafc;color:#172033;font:16px/1.6 Arial,sans-serif"><table role="presentation" style="max-width:600px;width:100%;margin:auto;border-collapse:collapse"><tr><td style="background:#050509;padding:20px;border-radius:12px"><img src="cid:codebandage-logo" width="300" height="58" alt="CodeBandage" style="display:block;max-width:100%;height:auto" /></td></tr><tr><td style="padding:24px 0;white-space:pre-wrap">${escapeEmailHtml(text)}</td></tr><tr><td style="border-top:1px solid #d8dee8;padding-top:16px;color:#536174">CodeBandage · AI Website Security &amp; Repair</td></tr></table></body></html>`;
}

export class SmtpEmailProvider''')
change('packages/email/src/index.ts','text: message.text,',"text: message.text, html: renderBrandedEmail(message.text), attachments: [{ filename: 'codebandage-logo.png', content: Buffer.from(emailLogoBase64, 'base64'), contentType: 'image/png', cid: 'codebandage-logo', contentDisposition: 'inline' }],")
change('packages/email/src/index.ts','from: this.transport.from,',"from: { name: 'CodeBandage', address: this.transport.from },")
put('packages/database/prisma/migrations/20261007000000_codebandage_branding/migration.sql','''
-- Version stock templates; never rewrite sent emails, customized templates, or applied migrations.
BEGIN;
LOCK TABLE email_template_versions IN SHARE ROW EXCLUSIVE MODE;
WITH stock AS (
  SELECT t.id, t.event_type,
    (SELECT COALESCE(MAX(v.version),0)+1 FROM email_template_versions v WHERE v.event_type=t.event_type) AS next_version
  FROM email_template_versions t
  WHERE t.enabled=true AND t.created_by_user_id IS NULL
    AND t.subject_template='ZeroRoot: {{title}}'
    AND t.body_template=E'Hello {{recipientName}},\\n\\n{{message}}\\n\\nOpen ZeroRoot: {{actionUrl}}'
), disabled AS (
  UPDATE email_template_versions t SET enabled=false FROM stock s WHERE t.id=s.id
  RETURNING t.event_type
)
INSERT INTO email_template_versions (id,event_type,version,subject_template,body_template,enabled,created_by_user_id,created_at)
SELECT gen_random_uuid(), s.event_type, s.next_version, 'CodeBandage: {{title}}',
 E'Hello {{recipientName}},\\n\\n{{message}}\\n\\nOpen CodeBandage: {{actionUrl}}', true, NULL, CURRENT_TIMESTAMP
FROM stock s JOIN disabled d ON d.event_type=s.event_type;
COMMIT;
''')
put('packages/email/src/branding.test.ts','''
import { describe, expect, it } from 'vitest';
import { renderBrandedEmail } from './index.js';
import { emailLogoBase64 } from './brand-asset.js';

describe('CodeBandage email branding', () => {
  it('embeds the supplied logo without loading a remote URL', () => {
    const html = renderBrandedEmail('A safe notification');
    expect(html).toContain('cid:codebandage-logo'); expect(html).toContain('alt="CodeBandage"');
    expect(html).not.toMatch(/<img[^>]+https?:/); expect(Buffer.from(emailLogoBase64, 'base64').subarray(1,4).toString()).toBe('PNG');
  });
  it('escapes untrusted notification content, including markup and quotes', () => {
    const html = renderBrandedEmail('<script>alert("x")</script> & \\'customer\\'');
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&amp;'); expect(html).toContain('&#39;customer&#39;');
  });
});
''')
p=root/'packages/reports/src/index.test.ts';p.write_text(p.read_text()+'''

describe('CodeBandage report identity', () => {
  it('keeps old signed documents valid and binds the publisher on new documents', () => {
    const legacy: ReportDocument = { schemaVersion:1, reportId:'legacy', type:'SECURITY_SCAN', tenantId:'t', website:{id:'w',name:'Site',origin:'https://example.test'}, generatedAt:'2026-09-03T00:00:00Z',data:{} };
    const secret='synthetic-signing-secret';
    expect(verifyReport(legacy,reportIntegrity(legacy),signReport(legacy,secret),secret)).toBe(true);
    const branded={...legacy,publisher:{name:'CodeBandage',logoPath:'/brand/codebandage-logo.webp'}};
    expect(verifyReport(branded,reportIntegrity(branded),signReport(branded,secret),secret)).toBe(true);
    expect(verifyReport({...branded,publisher:{...branded.publisher,name:'Other'}},reportIntegrity(branded),signReport(branded,secret),secret)).toBe(false);
  });
});
''')
change('packages/email/src/smtp.test.ts',"expect(messages).toHaveLength(1);","expect(messages).toHaveLength(1); expect(messages[0]).toContain('From: CodeBandage <sender@example.test>'); expect(messages[0]).toContain('Content-ID: <codebandage-logo>');")
put('apps/web/care-e2e/branding.spec.ts','''
import { test, expect } from '@playwright/test';

for (const width of [390,1280]) {
  test(`CodeBandage header, artwork and metadata at ${width}px`, async ({ page }) => {
    await page.setViewportSize({width,height:900}); await page.goto('/');
    await expect(page).toHaveTitle(/^CodeBandage/);
    const logo=page.locator('.app-header').getByRole('img',{name:'CodeBandage',exact:true});
    await expect(logo).toBeVisible();
    await expect.poll(() => logo.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute('content','CodeBandage');
    expect(await page.locator('.app-main').innerText()).not.toContain('ZeroRoot');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path:`test-results/codebandage-home-${width}.png`,fullPage:true});
  });
}
test('new artwork, favicon, social card and PWA icons are served', async ({ request }) => {
  const manifest=await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.short_name).toBe('CodeBandage');
  expect(manifest.icons).toHaveLength(3);
  for (const src of ['/brand/codebandage-logo.webp','/brand/favicon-32.png','/brand/apple-touch-icon.png','/opengraph-image.png',...manifest.icons.map((icon:{src:string})=>icon.src)]) {
    const res=await request.get(src); expect(res.status()).toBe(200); expect(res.headers()['content-type']).toMatch(/^image\\//);
  }
  const alias=await request.get('/opengraph-image',{maxRedirects:0}); expect(alias.status()).toBe(307);
});
test('all public portal sign-ins use the new logo without changing form semantics', async ({ page }) => {
  for (const portal of ['customer','agency','affiliate','specialist','owner']) {
    await page.goto(`/${portal}/login`); await expect(page).toHaveTitle(/CodeBandage/);
    await expect(page.locator('.auth-copy').getByRole('img',{name:'CodeBandage',exact:true})).toBeVisible();
    await expect(page.getByLabel('Email address',{exact:true})).toBeVisible();
    await expect(page.getByLabel('Password',{exact:true})).toBeVisible();
    expect(await page.locator('main').innerText()).not.toContain('ZeroRoot');
  }
});
test('logo keeps its intended backplate in dark/reduced-motion rendering', async ({ page }) => {
  await page.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'}); await page.goto('/customer/login');
  const logo=page.locator('.app-header .cb-brand');
  await expect(logo).toHaveCSS('background-color','rgb(5, 5, 9)');
  await page.screenshot({path:'test-results/codebandage-auth-dark.png',fullPage:true});
});
''')
put('apps/api/src/branding.integration.test.ts','''
import { afterAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { database } from '@zerochack/database';

// Disposable PostgreSQL fixture; TEMP objects shadow the table only on this transaction connection.
describe('CodeBandage stock-template migration', () => {
  afterAll(() => database.$disconnect());
  it('versions exact stock defaults, preserves customization/history and is repeat-safe', async () => {
    if (!new URL(process.env.DATABASE_URL ?? '').pathname.includes('test')) throw new Error('Disposable test database required');
    const sql=await readFile('packages/database/prisma/migrations/20261007000000_codebandage_branding/migration.sql','utf8');
    const migration=sql.slice(sql.indexOf('WITH stock AS'),sql.indexOf('\\nCOMMIT;'));
    await database.$transaction(async tx => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE email_template_versions (id UUID PRIMARY KEY, event_type TEXT NOT NULL, version INT NOT NULL, subject_template TEXT NOT NULL, body_template TEXT NOT NULL, enabled BOOLEAN NOT NULL, created_by_user_id UUID, created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(event_type,version)) ON COMMIT DROP');
      await tx.$executeRawUnsafe('CREATE UNIQUE INDEX cb_fixture_one_enabled ON email_template_versions(event_type) WHERE enabled=true');
      const oldBody='Hello {{recipientName}},\\n\\n{{message}}\\n\\nOpen ZeroRoot: {{actionUrl}}';
      await tx.$executeRaw`INSERT INTO email_template_versions VALUES (gen_random_uuid(),'STOCK',1,'ZeroRoot: {{title}}',${oldBody},true,NULL,CURRENT_TIMESTAMP),(gen_random_uuid(),'CUSTOM',1,'Custom subject',${oldBody},true,NULL,CURRENT_TIMESTAMP),(gen_random_uuid(),'AUTHORED',1,'ZeroRoot: {{title}}',${oldBody},true,gen_random_uuid(),CURRENT_TIMESTAMP)`;
      await tx.$executeRawUnsafe(migration);
      const rows=await tx.$queryRaw<Array<{event_type:string;version:number;subject_template:string;enabled:boolean}>>`SELECT event_type,version,subject_template,enabled FROM email_template_versions ORDER BY event_type,version`;
      expect(rows).toHaveLength(4);
      expect(rows.filter(r=>r.event_type==='STOCK')).toEqual([{event_type:'STOCK',version:1,subject_template:'ZeroRoot: {{title}}',enabled:false},{event_type:'STOCK',version:2,subject_template:'CodeBandage: {{title}}',enabled:true}]);
      expect(rows.find(r=>r.event_type==='CUSTOM')).toMatchObject({version:1,subject_template:'Custom subject',enabled:true});
      expect(rows.find(r=>r.event_type==='AUTHORED')).toMatchObject({version:1,subject_template:'ZeroRoot: {{title}}',enabled:true});
      await tx.$executeRawUnsafe(migration);
      const count=await tx.$queryRaw<Array<{count:bigint}>>`SELECT COUNT(*) AS count FROM email_template_versions`;
      expect(count[0]?.count).toBe(4n);
    });
  });
});
''')
put('docs/CODEBANDAGE-BRANDING.md','''
# CodeBandage branding

The product display name is **CodeBandage**, with the optional tagline **AI Website Security & Repair**.
The user-supplied bandage/code-brackets artwork is the only logo source. The optimized source retains the original colors, bandage, AI lettering and wordmark, on a dark backplate for contrast. It is not a new generated design.

`apps/web/public/brand/codebandage-source.webp` is the checked 512-pixel optimized source.
Run `node scripts/generate-brand-assets.mjs` to regenerate the cropped web logo/wordmark, marks, PWA icons, favicon, Apple touch icon, trusted email attachment, and 1200x630 social card. The generator rejects an unexpected source SHA-256.

## Coverage

Shared header/footer branding covers customer, specialist, agency, affiliate, Owner, account and chat surfaces. Auth screens show the complete supplied logo. Home/Owner decorative lettermarks use the new symbol. Current copy, metadata, structured data, manifest, notification subjects, gateway identity and new MFA enrollment labels use CodeBandage. New report documents have optional signed publisher metadata; existing signed reports are not rewritten. SMTP sends an embedded logo, escaped HTML and the original text fallback; configured sender addresses stay unchanged.

## Preserved technical and historical references

The repository `nithudev-com/zerochack`, `@zerochack/*` packages, import aliases, existing environment variable names, database/volume names, cookie/session/local-storage keys, metrics and Redis namespaces, protocol user agents, SFTP lock filenames, and `@zerochack.delivery` message IDs remain unchanged for compatibility. No repository/domain migration or production deployment is performed by this rebrand.

Already-applied migration files, signed customer reports, queued/delivered messages, screenshots of earlier releases, audit records and custom customer/tenant names are historical data and must not be globally rewritten. The additive branding migration disables exact unmodified enabled system email defaults and adds a new version; customized templates and historical template versions are retained. Existing authenticator entries can keep their old display label without resetting secrets; new enrollments show CodeBandage.

Manually authored Owner email templates and configured verified sender domains require explicit review, not bulk editing. Public new pages and generated outputs must not present the former product name as the current brand. This task does not certify the unfinished platform capabilities or override dependency-audit release gates.
''')
p=root/'README.md';p.write_text(p.read_text()+'\n## Branding\n\nCodeBandage is the product brand. Stable `zerochack` package/repository identifiers are retained. See [branding and compatibility](docs/CODEBANDAGE-BRANDING.md).\n')
(root/'apps/web/public/brand/zeroroot-logo.webp').unlink(missing_ok=True)
print('Applied reviewed CodeBandage UI, metadata, email and report changes.')
