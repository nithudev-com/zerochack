import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const id = 'c43690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const base = `/customer/websites/${id}`; const url = `${base}?service=security`;
const stamp = '2026-10-10T06:00:00.000Z';
async function fixture(page: Page, options: { ready?: boolean; expired?: boolean; disabled?: boolean; checkFailure?: boolean; captureFailure?: boolean; chatFailure?: boolean; statusFailure?: boolean; savedJobs?: boolean; rich?: boolean; assessmentFailure?: boolean; sendRateLimit?: 'before-save' | 'after-save' } = {}) {
  let stored = options.ready ?? false; let checked = options.ready ?? false;
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const messages = [{ id: 'old-1', type: 'CUSTOMER', content: 'A saved question from yesterday.', createdAt: stamp }];
  if (options.rich) messages.push(...Array.from({ length: 12 }, (_, index) => ({ id: `notice-${index}`, type: 'SYSTEM', content: 'SSH authentication succeeded. No changes started. Synthetic notice details.', createdAt: stamp })), { id: 'long-reply', type: 'AI', content: '## Redirect inspection\n\nI will check the saved website, then explain the evidence.\n\n- Check the destination\n- Review the affected configuration\n\n```text\nNo live changes have been approved.\n' + 'synthetic-long-code-value-'.repeat(30) + '\n```\n\n| Check | Evidence |\n| --- | --- |\n| Redirect destination | A synthetic evidence value for the selected website only |\n\n' + 'Evidence is required before proposing a fix. '.repeat(35) + '\n\nEnd of the complete saved reply.', createdAt: stamp });
  await page.route('**/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type,prefer' };
    const send = (body: unknown, status = 200) => route.fulfill({ headers, status, json: body });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (request.method() !== 'GET') writes.push({ path, body: request.postData() ? request.postDataJSON() : {} });
    const metadata = { status: checked ? 'READY_FOR_SECURE_SESSION' : 'CONFIGURED', secretStored: true, lastCheckedAt: checked ? stamp : null, lastErrorCode: null, authorizationExpiresAt: options.expired ? '2020-01-01T00:00:00Z' : null };
    if (path.endsWith('/auth/me')) return send({ roles: ['Customer'] });
    if (path === `/v1/websites/${id}`) return send({ id, name: 'Security fixture', url: 'https://example.test', connectionStatus: 'VERIFIED' });
    if (path.endsWith('/access')) return options.statusFailure ? send({ error: { code: 'UNAVAILABLE', message: 'Unavailable' } }, 503) : send(stored ? metadata : null);
    if (path.endsWith('/care')) return options.disabled ? send({ error: { code: 'CAPABILITY_DISABLED', message: 'Care disabled' } }, 503) : send({ capabilities: { secureCapture: true }, jobs: options.savedJobs ? [{ id: 'saved-job' }] : [], accessRequests: [] });
    if (path.endsWith('/chat')) return send(messages);
    if (path.endsWith('/chat/ingest')) {
      const body = request.postDataJSON();
      if (body.mode === 'SECURE') {
        if (options.captureFailure) return send({ error: { code: 'INVALID', message: 'synthetic-sensitive-error-never-render' } }, 400);
        stored = true; checked = false; return send({ stored: true }, 201);
      }
      if (options.chatFailure) return send({ error: { code: 'AI_UNAVAILABLE', message: 'An AI provider is not configured. No assistant response was generated.' } }, 503);
      if (options.sendRateLimit) {
        if (options.sendRateLimit === 'after-save') messages.push({ id: 'saved-before-provider-limit', type: 'CUSTOMER', content: body.content, createdAt: stamp });
        return route.fulfill({ status: 429, headers: { ...headers, 'access-control-expose-headers': 'retry-after', 'retry-after': '30' }, json: { error: { code: 'RATE_LIMITED', message: 'Too Many Requests' } } });
      }
      messages.push({ id: `customer-${messages.length}`, type: 'CUSTOMER', content: body.content, createdAt: stamp }, { id: `assistant-${messages.length}`, type: 'AI', content: 'Which pages changed, and when did you first notice?', createdAt: stamp });
      return send({}, 201);
    }
    if (path.endsWith('/access/check')) {
      if (options.checkFailure) { checked = false; return send({ error: { code: 'HOST_KEY_MISMATCH', message: 'synthetic-sensitive-error-never-render' } }, 409); }
      checked = true; return send({ ...metadata, status: 'READY_FOR_SECURE_SESSION', lastCheckedAt: stamp });
    }
    if (path.endsWith('/assessment') && request.method() === 'GET') return send({ scan: null });
    if (path.endsWith('/assessment') && request.method() === 'POST') {
      if (options.assessmentFailure) return send({ error: { code: 'SCAN_ALREADY_ACTIVE', message: 'An inspection is already queued or running. Review saved progress before starting another.' } }, 409);
      messages.push({ id: 'inspection-completed', type: 'AI', content: 'Synthetic inspection completed. Two evidence-backed findings saved. No files were changed.', createdAt: stamp });
      return send({ scanId: id, findingCount: 2 }, 201);
    }
    return send([]);
  });
  return writes;
}
async function fillSsh(page: Page) {
  await page.getByRole('button', { name: 'Connect SSH securely', exact: true }).click();
  await page.getByLabel('Server host', { exact: true }).fill('ssh.provider.example');
  await page.getByLabel('SSH username', { exact: true }).fill('deployment');
  await page.getByLabel('SSH password', { exact: true }).fill('synthetic-test-only-not-a-real-secret');
}

for (const width of [320, 390, 1440]) test(`security chat is simple and accessible at ${width}px with no automatic actions`, async ({ page }) => {
  const writes = await fixture(page); await page.setViewportSize({ width, height: 844 }); await page.goto(url);
  const chat = page.getByRole('region', { name: 'Security recovery conversation' });
  await expect(chat.getByRole('heading', { name: 'First, connect your SSH access securely.' })).toBeVisible();
  await expect(page.getByRole('form', { name: 'Website task brief' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Conversation controls' })).toHaveCount(0);
  await expect(page.getByLabel('Environment', { exact: true })).toHaveCount(0);
  expect((await new AxeBuilder({ page }).include('[aria-label="Security recovery conversation"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  const composer = page.getByLabel('Message CodeBandage', { exact: true }); await composer.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
  expect(await composer.evaluate(element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element; })).toBe(true);
  await page.evaluate(() => { document.activeElement instanceof HTMLElement && document.activeElement.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
  await page.screenshot({ path: `/tmp/codebandage-security-chat-${width}.png`, fullPage: true }); expect(writes).toEqual([]);
});
test('security selection opens chat rather than a support brief', async ({ page }) => {
  const writes = await fixture(page); await page.goto(`${base}/services`);
  await page.getByRole('radio', { name: /Fix hacks & security/ }).check(); await page.getByRole('button', { name: 'Next: open workspace' }).click();
  await expect(page).toHaveURL(url); await expect(page.getByRole('button', { name: 'Connect SSH securely' })).toBeVisible(); expect(writes).toEqual([]);
});
test('checked SSH asks about symptoms; chat saves real replies and never starts an assessment', async ({ page }) => {
  const writes = await fixture(page, { ready: true }); await page.goto(url);
  await expect(page.getByRole('button', { name: 'Inspect website', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Review findings', exact: true })).toHaveAttribute('href', `${base}/findings`);
  await expect(page.getByText('A saved question from yesterday.')).toBeVisible(); await expect(page.getByLabel('Security intake guidance')).toHaveCount(0);
  await page.getByLabel('Message CodeBandage').fill('My homepage redirects to another site. I noticed it this morning.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Which pages changed, and when did you first notice?')).toBeVisible();
  expect(writes).toHaveLength(1); expect(writes[0]!.body).toMatchObject({ mode: 'MESSAGE', content: 'My homepage redirects to another site. I noticed it this morning.' }); expect(writes[0]!.path).toBe(`/v1/websites/${id}/chat/ingest`);
  await page.reload(); await expect(page.getByText('Which pages changed, and when did you first notice?')).toBeVisible(); expect(writes).toHaveLength(1);
});
test('four-field SSH requires consent but no fingerprint; success starts no jobs', async ({ page }) => {
  const writes = await fixture(page); await page.goto(url); await fillSsh(page);
  const submit = page.getByRole('button', { name: 'Connect SSH', exact: true }); await expect(submit).toBeDisabled();
  await page.getByLabel('I own or administer this server').check(); await page.getByLabel('SSH port', { exact: true }).fill('65002'); await expect(page.getByLabel('I own or administer this server')).not.toBeChecked(); await page.getByLabel('I own or administer this server').check();
  expect((await new AxeBuilder({ page }).include('[aria-label="Secure SSH connection"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await submit.click(); await expect(page.getByRole('button', { name: 'Inspect website', exact: true })).toBeVisible();
  expect(writes.map(row => row.path)).toEqual([`/v1/websites/${id}/chat/ingest`, `/v1/websites/${id}/access/check`]); expect(writes[0]!.body).toMatchObject({ mode: 'SECURE', authorizationConfirmed: true, environment: 'PRODUCTION' });
  expect(JSON.parse(writes[0]!.body.content as string)).toMatchObject({ kind: 'SSH', port: 65002, username: 'deployment', authMethod: 'PASSWORD', firstConnectionTrustConfirmed: true }); expect(await page.locator('body').innerText()).not.toContain('synthetic-test-only-not-a-real-secret');
  await page.reload(); await expect(page.getByRole('button', { name: 'Inspect website', exact: true })).toBeVisible(); expect(writes).toHaveLength(2);
});
test('four fields, password default, key alternative and cancellation clears secrets', async ({ page }) => {
  const writes = await fixture(page); await page.goto(url); await fillSsh(page); await expect(page.getByLabel('Trusted host fingerprint')).toHaveCount(0); await expect(page.getByLabel('SSH password')).toHaveAttribute('type', 'password');
  await expect(page.getByRole('button', { name: 'Connect SSH' })).toBeDisabled(); await page.getByRole('button', { name: 'Cancel SSH setup' }).click(); await page.getByRole('button', { name: 'Connect SSH securely' }).click();
  await expect(page.getByLabel('SSH password')).toHaveValue(''); await page.getByRole('button', { name: 'Use a private key instead' }).click(); await expect(page.getByLabel('SSH private key')).toBeVisible(); await page.getByRole('button', { name: 'Use a password instead' }).click(); await expect(page.getByLabel('I own or administer this server')).not.toBeChecked(); expect(writes).toEqual([]);
});
for (const captureFailure of [false, true]) test(`${captureFailure ? 'capture' : 'connection'} failure stays blocked, hides secrets/errors and never retries automatically`, async ({ page }) => {
  const writes = await fixture(page, { captureFailure, checkFailure: !captureFailure }); await page.goto(url); await fillSsh(page); await page.getByLabel('I own or administer this server').check(); await page.getByRole('button', { name: 'Connect SSH' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'SSH setup or connection check failed' })).toBeVisible(); await expect(page.getByLabel('SSH password')).toHaveValue(''); await expect(page.getByRole('heading', { name: 'What suspicious changes have you noticed?' })).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain('synthetic-sensitive-error-never-render'); expect(writes).toHaveLength(captureFailure ? 1 : 2);
});
test('disabled secure capture locks secret entry instead of pretending a connection works', async ({ page }) => {
  const writes = await fixture(page, { disabled: true }); await page.goto(url); await page.getByRole('button', { name: 'Connect SSH securely' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Secure capture is unavailable' })).toBeVisible(); await expect(page.getByLabel('SSH password')).toBeDisabled(); await expect(page.getByRole('button', { name: 'Connect SSH' })).toBeDisabled(); expect(writes).toEqual([]);
});
test('an expired saved authorization is not presented as a usable connection', async ({ page }) => {
  const writes = await fixture(page, { ready: true, expired: true }); await page.goto(url);
  await expect(page.getByRole('heading', { name: 'First, connect your SSH access securely.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'What suspicious changes have you noticed?' })).toHaveCount(0); expect(writes).toEqual([]);
});
test('credential-like chat text is never sent, persisted in storage or kept as a draft', async ({ page }) => {
  const writes = await fixture(page, { ready: true }); await page.goto(url);
  for (const text of ['password: synthetic-chat-marker', 'https://account:synthetic-chat-marker@example.test', '-----BEGIN OPENSSH PRIVATE KEY-----']) {
    await page.getByLabel('Message CodeBandage').fill(text); await page.getByRole('button', { name: 'Send message' }).click(); await expect(page.getByRole('alert').filter({ hasText: 'Access details were not sent' })).toBeVisible(); await expect(page.getByLabel('Message CodeBandage')).toHaveValue('');
  }
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain('synthetic-chat-marker'); expect(writes).toEqual([]);
});
test('provider and status failures stay honest; existing approvals remain reachable', async ({ page }) => {
  const writes = await fixture(page, { chatFailure: true, ready: true, statusFailure: true, savedJobs: true }); await page.goto(url);
  await expect(page.getByText('SSH unverified', { exact: true })).toBeVisible(); await expect(page.getByRole('alert').filter({ hasText: 'SSH status could not be verified' })).toBeVisible(); await expect(page.getByRole('link', { name: 'Review saved jobs & approvals' })).toHaveAttribute('href', base);
  await page.getByLabel('Message CodeBandage').fill('I noticed unexpected users on my site.'); await page.getByRole('button', { name: 'Send message' }).click(); await expect(page.getByRole('alert').filter({ hasText: 'An AI provider is not configured' })).toBeVisible(); expect(writes).toHaveLength(1);
});

for (const width of [390, 1440]) test(`active conversation has a visible composer and collapsed system notices at ${width}px`, async ({ page }) => {
  const writes = await fixture(page, { ready: true, rich: true }); await page.setViewportSize({ width, height: 900 }); await page.goto(url);
  const chat = page.getByRole('region', { name: 'Security recovery conversation' });
  const history = page.getByLabel('Conversation history', { exact: true });
  await expect(chat.getByLabel('Security intake guidance')).toHaveCount(0);
  await expect(chat.getByText('Let’s help secure your website.', { exact: true })).toHaveCount(0);
  await expect(history.locator('details')).toHaveCount(12);
  await expect(history.locator('details[open]')).toHaveCount(0);
  const composer = page.getByLabel('Message CodeBandage', { exact: true }); await expect(composer).toBeInViewport();
  if (width === 390) {
    const formBox = await page.getByRole('form', { name: 'Message security assistant', exact: true }).boundingBox(); const navigationBox = await page.locator('.cw-mobile-nav').boundingBox();
    expect(formBox!.y + formBox!.height).toBeLessThan(navigationBox!.y);
  }
  expect(await composer.evaluate(element => { const box = element.getBoundingClientRect(); return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element; })).toBe(true);
  expect(await history.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await history.evaluate(element => { element.scrollTop = 0; });
  await history.locator('details summary').first().click(); await expect(history.locator('details[open]')).toHaveCount(1);
  const reply = history.getByRole('article').filter({ hasText: 'End of the complete saved reply.' });
  expect(await reply.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
  if (width === 1440) expect(await reply.evaluate(element => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(760);
  expect(await reply.evaluate(element => getComputedStyle(element).maxHeight)).toBe('none');
  expect(await reply.locator('pre').evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(reply.locator('pre')).toHaveAttribute('tabindex', '0');
  await expect(page.getByRole('button', { name: 'Jump to latest message ↓', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Jump to latest message ↓', exact: true }).click();
  expect(await history.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(100);
  await expect(reply.getByText('End of the complete saved reply.', { exact: true })).toBeVisible();
  expect((await new AxeBuilder({ page }).include('[aria-label="Security recovery conversation"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await history.evaluate(element => { const reply = [...element.querySelectorAll('article')].find(article => article.textContent?.includes('End of the complete saved reply.')); if (reply) element.scrollTop += reply.getBoundingClientRect().top - element.getBoundingClientRect().top; });
  await page.screenshot({ path: `/tmp/codebandage-readable-chat-${width}.png`, fullPage: true }); expect(writes).toEqual([]);
});
test('explicit inspection invokes the real assessment endpoint without a model message or repair request', async ({ page }) => {
  const writes = await fixture(page, { ready: true }); await page.goto(url);
  await page.getByText('Scope & safety', { exact: true }).click();
  await expect(page.getByText(/Live security repairs are not enabled in this deployment/)).toBeVisible();
  const admissionRequest = page.waitForRequest(request => request.method() === 'POST' && new URL(request.url()).pathname === `/v1/websites/${id}/assessment`);
  await page.getByRole('button', { name: 'Inspect website', exact: true }).click();
  expect((await admissionRequest).headers().prefer).toBe('respond-async');
  await expect(page.getByText('Synthetic inspection completed. Two evidence-backed findings saved. No files were changed.')).toBeVisible();
  expect(writes).toEqual([{ path: `/v1/websites/${id}/assessment`, body: {} }]);
  await page.reload(); await expect(page.getByText(/Synthetic inspection completed/)).toBeVisible(); expect(writes).toHaveLength(1);
});
test('an inspection failure is actionable and never retried automatically', async ({ page }) => {
  const writes = await fixture(page, { ready: true, assessmentFailure: true }); await page.goto(url);
  await page.getByRole('button', { name: 'Inspect website', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'An inspection is already queued or running' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Inspect website', exact: true })).toBeEnabled();
  expect(writes).toEqual([{ path: `/v1/websites/${id}/assessment`, body: {} }]);
});

test('background rate limiting keeps the thread and draft while respecting Retry-After', async ({ page }) => {
  const writes = await fixture(page, { ready: true }); let chatReads = 1;
  await page.clock.install();
  // Establish the saved thread before injecting a background failure. Initial
  // development-mode requests can be aborted/replaced during Strict Mode.
  await page.goto(url); await expect(page.getByText('A saved question from yesterday.', { exact: true })).toBeVisible();
  await page.route(url => url.pathname === `/v1/websites/${id}/chat`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    chatReads++;
    return route.fulfill({ status: 429, headers: { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'retry-after', 'retry-after': '30' }, json: { error: { code: 'RATE_LIMITED', message: 'Too Many Requests' } } });
  });
  const composer = page.getByLabel('Message CodeBandage', { exact: true }); await composer.fill('Keep this unfinished question in my draft.');
  await page.clock.fastForward(11000);
  await expect(page.getByRole('status').filter({ hasText: 'Updates are taking a short pause.' })).toBeVisible();
  await expect(composer).toHaveValue('Keep this unfinished question in my draft.'); await expect(page.getByText('A saved question from yesterday.', { exact: true })).toBeVisible();
  expect(chatReads).toBe(2);
  await page.clock.fastForward(20000); expect(chatReads).toBe(2);
  await page.clock.fastForward(11000); await expect.poll(() => chatReads).toBe(3);
  await expect(composer).toHaveValue('Keep this unfinished question in my draft.'); expect(writes).toEqual([]);
});

for (const sendRateLimit of ['before-save', 'after-save'] as const) test(`a ${sendRateLimit} send limit is friendly and never resends or duplicates saved text`, async ({ page }) => {
  const writes = await fixture(page, { ready: true, sendRateLimit }); await page.goto(url);
  const composer = page.getByLabel('Message CodeBandage', { exact: true }); const content = 'Please help me understand the unexpected redirect.';
  await composer.fill(content); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This action needs a short pause.' })).toBeVisible();
  await expect(composer).toHaveValue(sendRateLimit === 'before-save' ? content : '');
  await expect(page.getByText('A saved question from yesterday.', { exact: true })).toBeVisible();
  expect(writes).toHaveLength(1); expect(writes[0]!.path).toBe(`/v1/websites/${id}/chat/ingest`);
  if (sendRateLimit === 'after-save') await expect(page.getByText(content, { exact: true })).toHaveCount(1);
});
