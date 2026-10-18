import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import type { AssessmentActivity } from '../lib/security-activity';

const websiteId = '8c042f3f-809a-49c9-8ad9-b38aeb5d3259';
const workspace = `/customer/websites/${websiteId}?service=security`;
const stamp = '2026-10-18T06:00:00.000Z';

const inspectionId = 'b26e8d75-c936-4ec6-9544-6ce8f3728d8b';
function runningScan(stage = 'CONNECTING'): NonNullable<AssessmentActivity['scan']> {
  return { id: inspectionId, status: 'RUNNING', stage, updatedAt: stamp, errorCode: null, repairApplied: false, coverageState: 'BOUNDED', coverageLimitations: [] };
}

async function pendingResponseFixture(page: Page, options: { scan?: AssessmentActivity['scan']; cancelFailure?: boolean } = {}) {
  const writes: string[] = [];
  let releaseResponse: (() => void) | undefined;
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  let releaseCancel: (() => void) | undefined;
  const cancellationGate = new Promise<void>(resolve => { releaseCancel = resolve; });
  let scan = options.scan ?? null;
  const messages = [{ id: 'question-before', type: 'CUSTOMER', content: 'My homepage has an unexpected redirect.', createdAt: stamp }];
  await page.route('**/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type,prefer' };
    const send = (body: unknown) => route.fulfill({ headers, json: body });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (request.method() !== 'GET') writes.push(path);
    if (path.endsWith('/auth/me')) return send({ roles: ['Customer'] });
    if (path === `/v1/websites/${websiteId}`) return send({ id: websiteId, name: 'Activity fixture', url: 'https://example.test', connectionStatus: 'VERIFIED' });
    if (path.endsWith('/access')) return send({ status: 'READY_FOR_SECURE_SESSION', secretStored: true, lastCheckedAt: stamp, lastErrorCode: null, authorizationExpiresAt: null });
    if (path.endsWith('/care')) return send({ capabilities: { secureCapture: true }, jobs: [], accessRequests: [] });
    if (path.endsWith('/assessment') && request.method() === 'GET') return send({ scan });
    if (path === `/v1/websites/${websiteId}/assessment/${inspectionId}/cancel` && request.method() === 'POST') {
      await cancellationGate;
      if (options.cancelFailure) return route.fulfill({ headers, status: 503, json: { error: { code: 'CANCELLATION_UNAVAILABLE', message: 'Cancellation could not be confirmed. The saved inspection is still running.' } } });
      scan = { ...runningScan('CANCELLED'), status: 'FAILED', errorCode: 'ASSESSMENT_CANCELLED' };
      return send({ cancelled: true });
    }
    if (path.endsWith('/chat')) return send(messages);
    if (path.endsWith('/chat/ingest')) {
      await responseGate;
      messages.push({ id: 'reply-after', type: 'AI', content: 'The response is saved. No inspection or repair was started.', createdAt: stamp });
      return send({});
    }
    return send([]);
  });
  return { writes, release: () => releaseResponse?.(), releaseCancel: () => releaseCancel?.(), setScan: (next: AssessmentActivity['scan']) => { scan = next; } };
}

test('pending assistant activity is accessible and never claims a tool or repair is running', async ({ page }) => {
  const fixture = await pendingResponseFixture(page);
  try {
    await page.setViewportSize({ width: 390, height: 900 }); await page.goto(workspace);
    await expect(page.getByRole('region', { name: 'Agent activity', exact: true })).toHaveCount(0);
    await page.getByLabel('Message CodeBandage', { exact: true }).fill('Help me understand the redirect.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const activity = page.getByRole('region', { name: 'Agent activity', exact: true });
    await expect(activity).toHaveAttribute('data-agent-state', 'response_pending');
    await expect(activity.getByRole('status')).toContainText('Preparing your response');
    await expect(activity).toContainText('This does not mean a website tool is running.');
    await expect(activity.getByRole('progressbar')).toHaveCount(0);
    expect(await activity.innerText()).not.toMatch(/applying|repair complete|streaming|\d+\s*%/iu);
    expect((await new AxeBuilder({ page }).include('[aria-label="Agent activity"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(fixture.writes).toEqual([`/v1/websites/${websiteId}/chat/ingest`]);
    fixture.release();
    await expect(page.getByText('The response is saved. No inspection or repair was started.', { exact: true })).toBeVisible();
    await expect(activity).toHaveCount(0);
  } finally { fixture.release(); }
});

test('reduced-motion preference makes pending activity completely static', async ({ page }) => {
  const fixture = await pendingResponseFixture(page);
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' }); await page.goto(workspace);
    await page.getByLabel('Message CodeBandage', { exact: true }).fill('Please explain the next safe step.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const activity = page.getByRole('region', { name: 'Agent activity', exact: true });
    await expect(activity).toHaveAttribute('data-agent-state', 'response_pending');
    const animationNames = await activity.locator('[aria-hidden="true"] span').evaluateAll(elements => elements.map(element => getComputedStyle(element).animationName));
    expect(animationNames.length).toBeGreaterThan(0); expect(animationNames.every(name => name === 'none')).toBe(true);
    expect(fixture.writes).toEqual([`/v1/websites/${websiteId}/chat/ingest`]);
  } finally { fixture.release(); }
});

test('activity follows saved inspection stages, survives reload and never invents a repair', async ({ page }) => {
  const fixture = await pendingResponseFixture(page, { scan: runningScan() });
  await page.setViewportSize({ width: 390, height: 900 }); await page.goto(workspace);
  const activity = page.getByRole('region', { name: 'Agent activity', exact: true });
  await expect(activity).toHaveAttribute('data-agent-state', 'connecting');
  await expect(page.getByRole('button', { name: 'Inspect website', exact: true })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Review findings', exact: true })).toHaveAttribute('href', `/customer/websites/${websiteId}/findings`);
  for (const [stage, state, title] of [['INSPECTING_SSH', 'inspecting_ssh', 'Inspecting server evidence'], ['CHECKING_PUBLIC_SITE', 'checking_public_site', 'Checking your public website'], ['SAVING_EVIDENCE', 'saving_evidence', 'Saving inspection evidence']] as const) {
    fixture.setScan(runningScan(stage));
    await expect(activity).toHaveAttribute('data-agent-state', state, { timeout: 7000 });
    await expect(activity.getByRole('status')).toContainText(title);
    expect(await activity.innerText()).not.toMatch(/applying|repair complete|\d+\s*%/iu);
  }
  fixture.setScan({ ...runningScan('COMPLETED'), status: 'SUCCEEDED' });
  await expect(activity).toHaveAttribute('data-agent-state', 'completed', { timeout: 7000 });
  await expect(activity).toContainText('no repair was applied.');
  await expect(page.getByRole('button', { name: 'Cancel inspection', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Inspect website', exact: true })).toBeEnabled();
  await page.reload(); await expect(activity).toHaveAttribute('data-agent-state', 'completed');
  expect(fixture.writes).toEqual([]);
});

for (const scenario of [
  { name: 'failed', scan: { ...runningScan('INSPECTING_SSH'), status: 'FAILED', errorCode: 'SSH_AUTH_FAILED' }, state: 'failed', detail: 'Inspection stopped (ssh auth failed)' },
  { name: 'interrupted', scan: runningScan('INTERRUPTED'), state: 'blocked', detail: 'completion is not confirmed.' },
  { name: 'incomplete', scan: { ...runningScan('COMPLETED'), status: 'SUCCEEDED', coverageState: 'INCOMPLETE', coverageLimitations: ['Bounded inspection did not cover every server path'] }, state: 'completed_limited', detail: 'not proof that the website is clean or secured.' },
  { name: 'cancelled', scan: { ...runningScan('CANCELLED'), status: 'FAILED', errorCode: 'ASSESSMENT_CANCELLED' }, state: 'cancelled', detail: 'no repair was authorized.' }
]) test(`${scenario.name} server result is honest instead of becoming a successful repair`, async ({ page }) => {
  const fixture = await pendingResponseFixture(page, { scan: scenario.scan }); await page.goto(workspace);
  const activity = page.getByRole('region', { name: 'Agent activity', exact: true });
  await expect(activity).toHaveAttribute('data-agent-state', scenario.state); await expect(activity).toContainText(scenario.detail);
  expect(await activity.innerText()).not.toMatch(/fix delivered|repair complete|\d+\s*%/iu);
  expect(fixture.writes).toEqual([]);
});

for (const width of [320, 1440]) test(`finished inspection exposes real limited-coverage reasons safely at ${width}px`, async ({ page }) => {
  const reason = 'Antivirus exceeded its deadline; its result is incomplete, not a clean scan.';
  const literal = 'Recorded text: <img src=x onerror="window.coverageXss=true"><script>window.coverageXss=true</script>';
  const longReason = 'A long recorded limitation: ' + 'bounded-path-segment-'.repeat(80);
  const fixture = await pendingResponseFixture(page, { scan: { ...runningScan('COMPLETED'), status: 'SUCCEEDED', coverageState: 'INCOMPLETE', coverageLimitations: [reason, ' ', `  ${reason}  `, literal, longReason] } });
  await page.setViewportSize({ width, height: 900 }); await page.goto(workspace);
  const activity = page.getByRole('region', { name: 'Agent activity', exact: true }); const details = activity.locator('details');
  await expect(activity).toHaveAttribute('data-agent-state', 'completed_limited'); await expect(activity).toHaveAttribute('data-tone', 'attention');
  await expect(activity.getByRole('status')).toContainText('Inspection finished'); await expect(activity.getByRole('status')).toContainText('Limited coverage');
  await expect(activity.getByRole('status')).toContainText('No repair was applied.');
  await expect(details).toHaveJSProperty('open', false); await expect(details.locator('summary')).toHaveText('View coverage limitations (3)');
  await details.locator('summary').focus(); await page.keyboard.press('Enter'); await expect(details).toHaveJSProperty('open', true);
  const reasons = activity.getByRole('list', { name: 'Recorded coverage limitations', exact: true });
  await expect(reasons.getByRole('listitem')).toHaveCount(3); await expect(reasons.getByText(reason, { exact: true })).toHaveCount(1);
  await expect(reasons.getByText(literal, { exact: true })).toBeVisible(); await expect(reasons.getByText(longReason, { exact: true })).toBeVisible();
  await expect(activity.locator('script, img, a')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { coverageXss?: boolean }).coverageXss)).toBeUndefined();
  expect(await activity.getByRole('status').innerText()).not.toContain(reason);
  expect((await new AxeBuilder({ page }).include('[aria-label="Agent activity"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
  await page.getByLabel('Conversation history', { exact: true }).evaluate(element => { const activity = element.querySelector('[aria-label="Agent activity"]'); if (activity) element.scrollTop += activity.getBoundingClientRect().top - element.getBoundingClientRect().top - 12; });
  await page.screenshot({ path: `/tmp/website-scope-limited-${width}.png`, fullPage: true });
  await page.reload(); await expect(details.locator('summary')).toHaveText('View coverage limitations (3)');
  await details.locator('summary').click(); await expect(reasons.getByText(reason, { exact: true })).toBeVisible(); expect(fixture.writes).toEqual([]);
});

test('limited coverage without detailed reasons has an honest fallback rather than an invented cause', async ({ page }) => {
  const fixture = await pendingResponseFixture(page, { scan: { ...runningScan('COMPLETED'), status: 'SUCCEEDED', coverageState: 'INCOMPLETE', coverageLimitations: ['', '   '] } });
  await page.goto(workspace); const activity = page.getByRole('region', { name: 'Agent activity', exact: true });
  await expect(activity).toHaveAttribute('data-agent-state', 'completed_limited'); await activity.locator('summary').click();
  await expect(activity.getByText('No detailed reason was recorded for this inspection. Review the saved findings and coverage before deciding next steps.', { exact: true })).toBeVisible();
  await expect(activity.getByRole('list', { name: 'Recorded coverage limitations', exact: true })).toHaveCount(0); expect(fixture.writes).toEqual([]);
});

test('historical scope warning stays visible as escaped text and never starts a new inspection', async ({ page }) => {
  const warning = 'This historical inspection was not limited to the selected website. It may include other websites on the account. It is preserved for history, not accepted as a current website-only assessment.';
  const completed = { ...runningScan('COMPLETED'), status: 'SUCCEEDED' };
  const fixture = await pendingResponseFixture(page, { scan: { ...completed, scopeWarning: warning } });
  await page.goto(workspace); const activity = page.getByRole('region', { name: 'Agent activity', exact: true });
  await expect(activity.getByText(warning, { exact: true })).toBeVisible(); expect(await activity.getByRole('status').innerText()).not.toContain(warning);
  const literalWarning = warning + ' <script>window.scopeWarningXss=true</script>';
  fixture.setScan({ ...completed, scopeWarning: literalWarning }); await page.reload();
  await expect(activity.getByText(literalWarning, { exact: true })).toBeVisible(); await expect(activity.locator('script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { scopeWarningXss?: boolean }).scopeWarningXss)).toBeUndefined();
  fixture.setScan(completed); await page.reload(); await expect(activity.getByText(warning, { exact: true })).toHaveCount(0);
  expect(fixture.writes).toEqual([]);
});

test('cancel requires one explicit request and remains pending until the server confirms it', async ({ page }) => {
  const fixture = await pendingResponseFixture(page, { scan: runningScan('INSPECTING_SSH') });
  try {
    await page.goto(workspace);
    const activity = page.getByRole('region', { name: 'Agent activity', exact: true });
    const cancel = page.getByRole('button', { name: 'Cancel inspection', exact: true }); await expect(cancel).toBeEnabled();
    await cancel.evaluate(element => { (element as HTMLButtonElement).click(); (element as HTMLButtonElement).click(); });
    const pending = page.getByRole('button', { name: 'Cancelling inspection…', exact: true });
    await expect(pending).toBeDisabled(); await expect(pending).toHaveAttribute('aria-busy', 'true');
    await expect(activity).toHaveAttribute('data-agent-state', 'inspecting_ssh');
    await expect.poll(() => fixture.writes).toEqual([`/v1/websites/${websiteId}/assessment/${inspectionId}/cancel`]);
    fixture.releaseCancel();
    await expect(activity).toHaveAttribute('data-agent-state', 'cancelled');
    await expect(activity).toContainText('An in-flight read-only request may finish; no repair was authorized.');
    await expect(page.getByRole('button', { name: /Cancel.*inspection/ })).toHaveCount(0);
    await page.reload(); await expect(activity).toHaveAttribute('data-agent-state', 'cancelled');
    expect(fixture.writes).toHaveLength(1);
  } finally { fixture.releaseCancel(); }
});

test('failed cancellation does not pretend work stopped or retry automatically', async ({ page }) => {
  const fixture = await pendingResponseFixture(page, { scan: runningScan('INSPECTING_SSH'), cancelFailure: true });
  try {
    await page.goto(workspace); await page.getByRole('button', { name: 'Cancel inspection', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancelling inspection…', exact: true })).toBeDisabled();
    fixture.releaseCancel();
    await expect(page.getByRole('region', { name: 'Security recovery conversation', exact: true }).getByRole('alert')).toContainText('Cancellation could not be confirmed. The saved inspection is still running.');
    await expect(page.getByRole('region', { name: 'Agent activity', exact: true })).toHaveAttribute('data-agent-state', 'inspecting_ssh');
    await expect(page.getByRole('button', { name: 'Cancel inspection', exact: true })).toBeEnabled();
    expect(fixture.writes).toEqual([`/v1/websites/${websiteId}/assessment/${inspectionId}/cancel`]);
  } finally { fixture.releaseCancel(); }
});
