import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const id = 'c43690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const base = `/customer/websites/${id}`; const url = `${base}?service=security`;
const stamp = '2026-10-10T06:00:00.000Z'; const fingerprint = `SHA256:${'a'.repeat(43)}`;
async function fixture(page: Page, options: { ready?: boolean; disabled?: boolean; checkFailure?: boolean; captureFailure?: boolean; chatFailure?: boolean; statusFailure?: boolean; savedJobs?: boolean } = {}) {
  let stored = options.ready ?? false; let checked = options.ready ?? false;
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const messages = [{ id: 'old-1', type: 'CUSTOMER', content: 'A saved question from yesterday.', createdAt: stamp }];
  await page.route('**/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    const send = (body: unknown, status = 200) => route.fulfill({ headers, status, json: body });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (request.method() !== 'GET') writes.push({ path, body: request.postData() ? request.postDataJSON() : {} });
    const metadata = { status: checked ? 'READY_FOR_SECURE_SESSION' : 'CONFIGURED', secretStored: true, lastCheckedAt: checked ? stamp : null, lastErrorCode: null };
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
      messages.push({ id: `customer-${messages.length}`, type: 'CUSTOMER', content: body.content, createdAt: stamp }, { id: `assistant-${messages.length}`, type: 'AI', content: 'Which pages changed, and when did you first notice?', createdAt: stamp });
      return send({}, 201);
    }
    if (path.endsWith('/access/check')) {
      if (options.checkFailure) { checked = false; return send({ error: { code: 'HOST_KEY_MISMATCH', message: 'synthetic-sensitive-error-never-render' } }, 409); }
      checked = true; return send({ ...metadata, status: 'READY_FOR_SECURE_SESSION', lastCheckedAt: stamp });
    }
    return send([]);
  });
  return writes;
}
async function fillSsh(page: Page) {
  await page.getByRole('button', { name: 'Connect SSH securely', exact: true }).click();
  await page.getByLabel('SSH username', { exact: true }).fill('deployment');
  await page.getByLabel('Authentication method', { exact: true }).selectOption('PASSWORD');
  await page.getByLabel('Trusted host fingerprint', { exact: true }).fill(fingerprint);
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
  await expect(page.getByRole('heading', { name: 'What suspicious changes have you noticed?' })).toBeVisible();
  await expect(page.getByText('A saved question from yesterday.')).toBeVisible(); await expect(page.getByText(/No assessment or cleanup has started/)).toBeVisible();
  await page.getByLabel('Message CodeBandage').fill('My homepage redirects to another site. I noticed it this morning.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByText('Which pages changed, and when did you first notice?')).toBeVisible();
  expect(writes).toHaveLength(1); expect(writes[0]!.body).toMatchObject({ mode: 'MESSAGE', content: 'My homepage redirects to another site. I noticed it this morning.' }); expect(writes[0]!.path).toBe(`/v1/websites/${id}/chat/ingest`);
  await page.reload(); await expect(page.getByText('Which pages changed, and when did you first notice?')).toBeVisible(); expect(writes).toHaveLength(1);
});
test('SSH requires consent and trusted fingerprint; success asks the next question without starting jobs', async ({ page }) => {
  const writes = await fixture(page); await page.goto(url); await fillSsh(page);
  const submit = page.getByRole('button', { name: 'Save securely & check SSH', exact: true }); await expect(submit).toBeDisabled();
  await page.getByLabel('I own or administer this server').check(); await page.getByLabel('SSH port', { exact: true }).fill('2222'); await expect(page.getByLabel('I own or administer this server')).not.toBeChecked(); await page.getByLabel('I own or administer this server').check();
  expect((await new AxeBuilder({ page }).include('[aria-label="Secure SSH connection"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  await submit.click(); await expect(page.getByRole('heading', { name: 'What suspicious changes have you noticed?' })).toBeVisible();
  expect(writes.map(row => row.path)).toEqual([`/v1/websites/${id}/chat/ingest`, `/v1/websites/${id}/access/check`]); expect(writes[0]!.body).toMatchObject({ mode: 'SECURE', authorizationConfirmed: true, environment: 'PRODUCTION' });
  expect(JSON.parse(writes[0]!.body.content as string)).toMatchObject({ kind: 'SSH', port: 2222, username: 'deployment', authMethod: 'PASSWORD', hostKeyFingerprint: fingerprint }); expect(await page.locator('body').innerText()).not.toContain('synthetic-test-only-not-a-real-secret');
  await page.reload(); await expect(page.getByRole('heading', { name: 'What suspicious changes have you noticed?' })).toBeVisible(); expect(writes).toHaveLength(2);
});
test('missing fingerprint prevents submission; cancelling discards credentials and consent', async ({ page }) => {
  const writes = await fixture(page); await page.goto(url); await fillSsh(page); await page.getByLabel('Trusted host fingerprint').fill(''); await page.getByLabel('I own or administer this server').check();
  await expect(page.getByRole('button', { name: 'Save securely & check SSH' })).toBeDisabled(); await page.getByRole('button', { name: 'Cancel SSH setup' }).click(); await page.getByRole('button', { name: 'Connect SSH securely' }).click();
  await page.getByLabel('Authentication method').selectOption('PASSWORD'); await expect(page.getByLabel('SSH password')).toHaveValue(''); await expect(page.getByLabel('I own or administer this server')).not.toBeChecked(); expect(writes).toEqual([]);
});
for (const captureFailure of [false, true]) test(`${captureFailure ? 'capture' : 'connection'} failure stays blocked, hides secrets/errors and never retries automatically`, async ({ page }) => {
  const writes = await fixture(page, { captureFailure, checkFailure: !captureFailure }); await page.goto(url); await fillSsh(page); await page.getByLabel('I own or administer this server').check(); await page.getByRole('button', { name: 'Save securely & check SSH' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'SSH setup or connection check failed' })).toBeVisible(); await expect(page.getByLabel('SSH password')).toHaveValue(''); await expect(page.getByRole('heading', { name: 'What suspicious changes have you noticed?' })).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain('synthetic-sensitive-error-never-render'); expect(writes).toHaveLength(captureFailure ? 1 : 2);
});
test('disabled secure capture locks secret entry instead of pretending a connection works', async ({ page }) => {
  const writes = await fixture(page, { disabled: true }); await page.goto(url); await page.getByRole('button', { name: 'Connect SSH securely' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Secure capture is unavailable' })).toBeVisible(); await expect(page.getByLabel('SSH private key')).toBeDisabled(); await expect(page.getByRole('button', { name: 'Save securely & check SSH' })).toBeDisabled(); expect(writes).toEqual([]);
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
  await expect(page.getByText('SSH needed', { exact: true })).toBeVisible(); await expect(page.getByRole('alert').filter({ hasText: 'SSH status could not be verified' })).toBeVisible(); await expect(page.getByRole('link', { name: 'Review saved jobs & approvals' })).toHaveAttribute('href', base);
  await page.getByLabel('Message CodeBandage').fill('I noticed unexpected users on my site.'); await page.getByRole('button', { name: 'Send message' }).click(); await expect(page.getByRole('alert').filter({ hasText: 'An AI provider is not configured' })).toBeVisible(); expect(writes).toHaveLength(1);
});
