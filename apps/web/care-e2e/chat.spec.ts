import { expect, test } from '@playwright/test';
const id = 'e33690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const site = { id, name: 'Care UI fixture', url: 'https://example.test', normalizedHost: 'example.test', connectionStatus: 'PENDING', findings: [], scans: [], tickets: [], backups: [], reports: [] };
test('all 24 source-review roles require consent and exact approval, with Tamil evidence reports on mobile', async ({ page }) => {
  const roles = Array.from({ length: 24 }, (_, index) => ({ id: `A${String(index + 1).padStart(2,'0')}`, name: `Review role ${index + 1}`, implementation: 'SOURCE_REVIEW' }));
  const jobId = '71d7b8b9-79a0-4025-a2fb-9d5908e31ee5'; let phase = 0; let prepared: Record<string, unknown> | undefined; let approval: unknown;
  const revision = { id: 'b855909b-f762-40a2-b474-2d69206b752c', version: 1, state: 'AWAITING_APPROVAL', sourceDigest: 'a'.repeat(64), budgetMicros: 5000000, chargedMicros: 0, budgetState: 'UNRESERVED', plan: { roleIds: roles.map((role) => role.id), language: 'ta', boundary: 'Review approved source; no live changes or runtime tests.', requestFingerprint: 'b'.repeat(64), configuration: { model: 'Fixture model' } } };
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const job = { id: jobId, kind: 'REVIEW', summary: 'Review this source with all roles', state: phase < 2 ? 'AWAITING_APPROVAL' : 'COMPLETED', environment: 'PRODUCTION', agents: [], createdAt: new Date().toISOString(), errorCode: null };
    if (path.endsWith('/care')) return route.fulfill({ json: { credentials: [], accessRequests: [], jobs: phase ? [job] : [], roles, capabilities: { sourceReview: true, maximumReviewBudgetMicros: 5000000 } } });
    if (path.endsWith('/reviews')) { prepared = route.request().postDataJSON(); phase = 1; return route.fulfill({ status: 201, json: { jobId, state: 'AWAITING_APPROVAL' } }); }
    if (path.endsWith('/review')) return route.fulfill({ json: { job, revision, completedSteps: phase === 2 ? 24 : 0, totalSteps: 24, capabilities: { enabled: true }, agents: phase === 2 ? roles.map((role) => ({ id: role.id, roleId: role.id, state: 'COMPLETED' })) : [], reports: phase === 2 ? [{ agentRunId: 'r1', roleId: 'A09', status: 'REVIEWED', summary: 'பக்கத்தில் உள்ள பொத்தானை விசைப்பலகை மூலம் சோதிக்க வேண்டும்.', findings: [{ title: 'Button interaction review', priority: 'LOW', explanation: 'The supplied source contains a Save button.', recommendation: 'Run a separate keyboard interaction test.', evidence: [{ path: 'page.tsx', startLine: 1, endLine: 1, quote: '<button>Save</button>' }] }], limitations: ['Runtime and browser tests were not run.'], nextSteps: ['Review the suggested interaction checks.'] }] : [] } });
    if (path.includes('/review-plans/') && path.endsWith('/approve')) { approval = route.request().postDataJSON(); phase = 2; return route.fulfill({ json: { state: 'QUEUED' } }); }
    return route.fallback();
  });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/customer/websites/${id}`);
  await page.getByRole('button', { name: 'Review source with AI team' }).click();
  const form = page.getByRole('form', { name: 'New source review' });
  await expect(form.getByRole('checkbox', { checked: true })).toHaveCount(24);
  await form.getByLabel('What should the team review?').fill('Review this source with all roles');
  await form.getByLabel('Expected outcome').fill('Return cited source observations and missing checks');
  await form.getByLabel('Report language').selectOption('ta');
  await form.getByLabel('Reviewed text source files').setInputFiles({ name: 'page.tsx', mimeType: 'text/plain', buffer: Buffer.from('<button>Save</button>') });
  await expect(form.getByRole('button', { name: 'Prepare team review plan' })).toBeDisabled();
  await form.getByLabel('I reviewed these files').check(); await form.getByRole('button', { name: 'Prepare team review plan' }).click();
  await expect(page.getByRole('button', { name: 'Open team review' })).toBeVisible();
  expect(prepared).toMatchObject({ roleIds: roles.map((role) => role.id), language: 'ta', privacyReviewed: true }); expect(approval).toBeUndefined();
  await page.getByRole('button', { name: 'Open team review' }).click();
  await page.getByRole('button', { name: /Approve source review/ }).click();
  expect(approval).toEqual({ sourceDigest: revision.sourceDigest, planFingerprint: revision.plan.requestFingerprint, version: 1, budgetMicros: 5000000, authorizeSourceReview: true });
  await expect(page.getByText('பக்கத்தில் உள்ள பொத்தானை விசைப்பலகை மூலம் சோதிக்க வேண்டும்.')).toBeVisible();
  await page.getByText('LOW · Button interaction review').click();
  await expect(page.locator('.care-review-quote')).toHaveText('<button>Save</button>');
  await expect(page.locator('.care-review-quote button')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/care-team-review-mobile.png', fullPage: true });
});

test('changing environment clears the source-review upload and description', async ({ page }) => {
  await page.route('**/care', async (route) => route.fulfill({ json: { credentials: [], accessRequests: [], jobs: [], roles: [{ id: 'A09', name: 'Accessibility Reviewer', implementation: 'SOURCE_REVIEW' }], capabilities: { sourceReview: true, maximumReviewBudgetMicros: 5000000 } } }));
  await page.goto(`/customer/websites/${id}`); await page.getByRole('button', { name: 'Review source with AI team' }).click();
  await page.getByLabel('What should the team review?').fill('This draft belongs only to production');
  await page.getByLabel('Reviewed text source files').setInputFiles({ name: 'page.tsx', mimeType: 'text/plain', buffer: Buffer.from('production-only-source') });
  await page.getByLabel('Environment', { exact: true }).selectOption('STAGING');
  await expect(page.getByRole('form', { name: 'New source review' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review source with AI team' }).click();
  await expect(page.getByLabel('What should the team review?')).toHaveValue('');
  await expect(page.getByLabel('Source path 1', { exact: true })).toHaveCount(0);
});
test('repair requires file consent and exact plan approval, then shows opaque protected previews', async ({ page }) => {
  const jobId = '31d7b8b9-79a0-4025-a2fb-9d5908e31ee5'; const artifactId = 'eb334a71-5cff-448c-a5ce-e6ae286a5f40';
  const sourceDigest = 'a'.repeat(64); const candidateDigest = 'b'.repeat(64); let phase = 0; let approved: unknown;
  const artifact = { id: artifactId, kind: 'SOURCE', filename: 'index.html', digest: sourceDigest, sizeBytes: 200, expiresAt: new Date(Date.now() + 86400000).toISOString() };
  const revision = { id: 'd855909b-f762-40a2-b474-2d69206b752c', version: 1, state: 'AWAITING_APPROVAL', sourceId: artifactId, sourceDigest, candidateId: null, candidateDigest: null, budgetMicros: 500000, chargedMicros: 0, budgetState: 'UNRESERVED', plan: { boundary: 'Prepare one static HTML candidate.', expectedBehavior: 'Show the corrected heading', configuration: { model: 'Fixture model' } }, verification: { checks: ['static-policy','title'], limitations: ['Visual review is required.'] } };
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/care')) return route.fulfill({ json: { credentials: [], accessRequests: [], jobs: [{ id: jobId, kind: 'REPAIR', summary: 'Correct the standalone page heading', state: 'WAITING_FOR_INPUT', environment: 'PRODUCTION', agents: [], createdAt: new Date().toISOString() }], capabilities: { attachments: true, isolatedRepair: true, deployment: false } } });
    if (path.endsWith('/workflow')) return route.fulfill({ json: { job: { state: 'AWAITING_APPROVAL', planVersion: 1 }, artifacts: phase ? [artifact] : [], revisions: phase >= 2 ? [{ ...revision, ...(phase === 3 ? { state: 'VERIFIED', candidateId: 'candidate', candidateDigest, budgetState: 'SETTLED', chargedMicros: 130 } : {}) }] : [], releases: [], capabilities: { release: false, maximumBudgetMicros: 500000 } } });
    if (path.endsWith('/artifacts')) { expect(route.request().postDataJSON().privacyReviewed).toBe(true); phase = 1; return route.fulfill({ status: 201, json: artifact }); }
    if (path.endsWith('/change-plan')) { expect(route.request().postDataJSON().sourceId).toBe(artifactId); phase = 2; return route.fulfill({ status: 201, json: revision }); }
    if (path.includes('/change-plans/') && path.endsWith('/approve')) { approved = route.request().postDataJSON(); phase = 3; return route.fulfill({ json: { state: 'QUEUED' } }); }
    if (path.endsWith('/preview')) return route.fulfill({ json: { html: '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'"><h1>Preview content</h1><script>parent.previewScriptRan=true</script><img src="https://invalid.example.test/tracker">' } });
    return route.fallback();
  });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/customer/websites/${id}`);
  await page.getByRole('button', { name: 'Open repair workspace' }).click();
  await expect(page.getByLabel('Upload HTML, screenshot, or redacted log')).toBeDisabled();
  await page.getByLabel('I removed credentials and private information.').check();
  await page.getByLabel('Upload HTML, screenshot, or redacted log').setInputFiles({ name: 'index.html', mimeType: 'text/html', buffer: Buffer.from('<h1>Reviewed source</h1>') });
  await page.getByRole('button', { name: 'Prepare approval plan' }).click();
  await page.getByRole('button', { name: /Approve candidate preparation/ }).click();
  expect(approved).toEqual({ version: 1, sourceDigest, budgetMicros: 500000, authorizeRepair: true });
  const blocked: string[] = []; const received: string[] = []; page.on('requestfailed', (request) => { if (request.url().includes('invalid.example.test')) blocked.push(request.failure()?.errorText ?? 'unknown'); }); page.on('response', (response) => { if (response.url().includes('invalid.example.test')) received.push(response.url()); });
  await page.getByRole('button', { name: 'Compare before and after' }).click();
  await expect(page.locator('iframe[title="Candidate page preview"]')).toHaveAttribute('sandbox', '');
  await expect(page.frameLocator('iframe[title="Candidate page preview"]').getByRole('heading', { name: 'Preview content' })).toBeVisible();
  expect(await page.evaluate(() => 'previewScriptRan' in window)).toBe(false); await expect.poll(() => blocked.length).toBe(2); expect(blocked.every((value) => /csp/i.test(value))).toBe(true); expect(received).toEqual([]);
  expect(await page.evaluate(() => { try { return Boolean(document.querySelector('iframe')!.contentWindow!.document); } catch { return false; } })).toBe(false);
  await expect(page.getByText('Production release is disabled.')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  await page.screenshot({ path: 'test-results/care-repair-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Close repair workspace' }).click(); await expect(page.locator('iframe')).toHaveCount(0);
});
test.beforeEach(async ({ page }) => {
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith('/auth/me') ? { roles: ['Customer'], displayName: 'UI test customer' } : path.endsWith('/care') ? { credentials: [], accessRequests: [], jobs: [], capabilities: { attachments: false, isolatedRepair: false, deployment: false } } : path.endsWith(`/websites/${id}`) ? site : [];
    if (path.endsWith('/activity/stream')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': connected\n\n' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
});
test('secure capture never renders submitted credentials as a bubble', async ({ page }) => {
  let submitted: Record<string, unknown> | undefined;
  await page.route('**/chat/ingest', async (route) => { submitted = route.request().postDataJSON(); return route.fulfill({ status: 201, contentType: 'application/json', body: '{"connectionStatus":"NOT_CHECKED"}' }); });
  await page.goto(`/customer/websites/${id}`);
  await expect(page.getByRole('heading', { name: 'Care UI fixture' })).toBeVisible();
  await page.getByLabel('Secure access details').fill('Host: server.example.test\nUsername: deploy\nPassword: synthetic-browser-marker');
  await expect(page.getByRole('button', { name: 'Store securely' })).toBeDisabled();
  await page.getByLabel('I’m authorized to provide').check();
  await page.getByRole('button', { name: 'Store securely' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Access stored securely' })).toBeVisible();
  expect(submitted).toMatchObject({ mode: 'SECURE', authorizationConfirmed: true });
  await expect(page.getByLabel('Conversation history')).not.toContainText('synthetic-browser-marker');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('synthetic-browser-marker');
});
test('mobile, reduced motion and Tamil content remain within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/customer/websites/${id}`);
  await page.getByRole('button', { name: 'Secure capture' }).click();
  await page.getByLabel('Message ZeroRoot').fill('என் இணையதளத்தில் மொபைல் மெனு சரியாக வேலை செய்யவில்லை.');
  await expect(page.getByRole('button', { name: 'Send', exact: false })).toBeVisible();
  const overflow = await page.evaluate(() => ({ width: innerWidth, pageWidth: document.documentElement.scrollWidth, elements: Array.from(document.querySelectorAll('body *')).filter((element) => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== 'absolute').slice(0, 8).map((element) => ({ tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right })) }));
  expect(overflow.pageWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width);
  await page.screenshot({ path: 'test-results/care-mobile.png', fullPage: true });
});
test('environment changes clear draft and receipt context', async ({ page }) => {
  await page.goto(`/customer/websites/${id}`); await page.getByLabel('Secure access details').fill('sensitive draft');
  await page.getByLabel('Environment', { exact: true }).selectOption('STAGING');
  await expect(page.getByLabel('Secure access details')).toHaveValue('');
  await page.getByRole('button', { name: /Your AI team/ }).click();
  await expect(page.getByText('No AI role has been assigned yet.')).toBeVisible();
  await page.screenshot({ path: 'test-results/care-desktop.png', fullPage: true });
});
test('untrusted Markdown cannot load remote images or render raw HTML', async ({ page }) => {
  await page.route('**/chat?**', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'fixture-message', type: 'AI', content: '<button>Forged approval</button>\n\n![tracking](https://invalid.example.test/pixel)\n\n[unsafe](javascript:alert(1))', createdAt: new Date().toISOString() }]) }));
  await page.goto(`/customer/websites/${id}`);
  await expect(page.getByLabel('Conversation history')).toContainText('Image omitted');
  await expect(page.getByRole('button', { name: 'Forged approval' })).toHaveCount(0);
  await expect(page.locator('.care-message img')).toHaveCount(0);
  await expect(page.locator('.care-message a[href^="javascript:"]')).toHaveCount(0);
});

for (const width of [390, 768, 1280, 1440]) {
  test(`chat fits ${width}px and keeps navigation accessible`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/customer/websites/${id}`);
    await expect(page.getByLabel('Secure access details')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width < 1024) {
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
      await expect(page.getByRole('navigation', { name: 'Customer navigation' })).toBeVisible();
      await page.getByRole('button', { name: 'Close menu', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('.care-chat')).toHaveClass(/care-theme-dark/);
  });
}
test('IME Enter does not submit a message', async ({ page }) => {
  let submitted = 0;
  await page.route('**/chat/ingest', (route) => { submitted += 1; return route.fulfill({ contentType: 'application/json', body: '{}' }); });
  await page.goto(`/customer/websites/${id}`);
  await page.getByRole('button', { name: 'Secure capture' }).click();
  const input = page.getByLabel('Message ZeroRoot'); await input.fill('தமிழ் composing input');
  await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
  await expect(input).toHaveValue('தமிழ் composing input'); expect(submitted).toBe(0);
  await input.press('Shift+Enter'); expect(submitted).toBe(0);
});
test('specialist reveal stays hidden until requested and clears on blur', async ({ page }) => {
  const grantId = 'approved-fixture-grant';
  await page.route('**/auth/me', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ roles: ['Cybersecurity Specialist'], displayName: 'Assigned specialist' }) }));
  await page.route('**/specialist/care/access', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tickets: [], credentials: [], grants: [{ id: grantId, status: 'APPROVED', reason: 'Inspect approved configuration', expiresAt: new Date(Date.now() + 600000).toISOString(), credential: { id: 'account', websiteId: id, kind: 'SSH', host: 'server.example.test', environment: 'PRODUCTION', version: 1 } }] }) }));
  await page.route(`**/credential-grants/${grantId}/reveal`, (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ secret: 'synthetic-disclosure-marker' }) }));
  await page.goto('/specialist/access');
  await expect(page.getByRole('button', { name: 'Reveal approved credential' })).toBeVisible();
  await expect(page.getByLabel('Approved credential', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Reveal approved credential' }).click();
  await expect(page.getByLabel('Approved credential', { exact: true })).toHaveValue('synthetic-disclosure-marker');
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByLabel('Approved credential', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('synthetic-disclosure-marker');
});
