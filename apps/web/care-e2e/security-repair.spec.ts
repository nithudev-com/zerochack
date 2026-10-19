import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Synthetic API fixtures verify browser behavior only. They do not demonstrate
// a customer SSH connection, registered adapter or remote permission change.
const websiteId = 'c43690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const enrollmentId = 'c43690a6-6d5e-4f7b-9e86-5f8f7913d2eb';
const runId = 'c43690a6-6d5e-4f7b-9e86-5f8f7913d2ec';
const planId = 'c43690a6-6d5e-4f7b-9e86-5f8f7913d2ed';
const proposalId = 'c43690a6-6d5e-4f7b-9e86-5f8f7913d2ee';
const restoreId = 'c43690a6-6d5e-4f7b-9e86-5f8f7913d2ef';
const stamp = '2026-10-19T04:00:00.000Z';
const expiry = '2099-10-19T04:00:00.000Z';
const base = `/websites/${websiteId}/security-repair`;
const url = `/customer/websites/${websiteId}?service=security`;
async function fixture(page: Page, options: { available?: boolean; saved?: boolean; completed?: boolean; sessionBound?: boolean; mfa?: boolean; createUncertain?: boolean; cancelUnconfirmed?: boolean } = {}) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const state = { exists: options.saved ?? false, currentRunId: runId, operation: 'HARDEN' as 'HARDEN' | 'RESTORE', phase: options.completed ? 'COMPLETED' : 'AWAITING_APPROVAL', awaiting: (options.completed ? null : 'CANDIDATE') as 'CANDIDATE' | 'CHANGE' | null, denied: false, requiresMfa: options.mfa ?? false, planDigest: 'a'.repeat(64) };
  const run = () => ({ id: state.currentRunId, environment: 'STAGING', phase: state.phase, errorCode: null, allowanceMicros: 10000, reservedMicros: 0, chargedMicros: 0, createdAt: stamp, expiresAt: expiry, sessionBound: options.sessionBound ?? true });
  const evidence = (proposal: boolean) => ({ artifactId: proposal ? proposalId : planId, digest: proposal ? 'b'.repeat(64) : state.planDigest, version: 1, kind: proposal ? 'PROPOSAL' : 'PLAN', adapter: 'MANAGED_STATIC_PERMISSION_V1', summary: 'Synthetic exact enrolled staging permission change.', environment: 'STAGING', enrollmentId, enrollmentRevision: 7, change: { action: state.operation, targetLabel: 'Synthetic staging index file', beforeMode: state.operation === 'HARDEN' ? 438 : 436, afterMode: state.operation === 'HARDEN' ? 436 : 438, contentDigest: 'c'.repeat(64), preimageDigest: 'd'.repeat(64) }, recovery: { digest: 'e'.repeat(64), encrypted: true, verified: proposal }, checks: [{ name: 'Synthetic immutable content verification', passed: true }] });
  await page.route('**/v1/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname.slice(3);
    const headers = { 'access-control-allow-origin': new URL(page.url()).origin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type,prefer' };
    const send = (body: unknown, status = 200) => route.fulfill({ headers, status, json: body });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    if (request.method() !== 'GET') writes.push({ path, body: request.postDataJSON() ?? {} });
    if (path === '/auth/me') return send({ roles: ['Customer'] });
    if (path === `/websites/${websiteId}`) return send({ id: websiteId, name: 'Synthetic security fixture', url: 'https://example.test', connectionStatus: 'VERIFIED' });
    if (path.endsWith('/access')) return send(null);
    if (path.endsWith('/care')) return send({ capabilities: { secureCapture: true }, jobs: [], accessRequests: [] });
    if (path.endsWith('/chat')) return send([{ id: 'saved-message', type: 'CUSTOMER', content: 'Keep my saved security conversation.', createdAt: stamp }]);
    if (path.endsWith('/assessment')) return send({ scan: null });
    if (path === `${base}/capabilities`) return send({ environment: 'STAGING', productionWrites: false, tracks: [{ id: 'managed-static-permission-v1', label: 'Managed staging file permission', available: options.available !== false }], enrollments: options.available === false ? [] : [{ id: enrollmentId, revision: 7, label: 'Synthetic enrolled target', environment: 'STAGING', adapter: 'MANAGED_STATIC_PERMISSION_V1' }], blockers: options.available === false ? [{ code: 'SECURITY_MANAGED_ADAPTER_UNAVAILABLE', message: 'A trusted managed adapter is not registered. No work can run.' }] : [], authority: { canCreate: options.available !== false && !state.requiresMfa, requiresRecentMfa: state.requiresMfa } });
    if (path === '/auth/mfa/step-up') { state.requiresMfa = false; return send({ verified: true }); }
    if (path === `${base}/runs` && request.method() === 'GET') return send({ runs: state.exists ? [run()] : [] });
    if (path === `${base}/runs` && request.method() === 'POST') {
      state.exists = true;
      if (request.postDataJSON().operation === 'RESTORE') { state.currentRunId = restoreId; state.operation = 'RESTORE'; state.phase = 'AWAITING_APPROVAL'; state.awaiting = 'CANDIDATE'; }
      if (options.createUncertain) return send({ error: { code: 'UNAVAILABLE', message: 'Synthetic response interruption' } }, 503);
      return send({ run: run(), created: true }, 201);
    }
    if (path === `${base}/runs/${state.currentRunId}`) {
      if (state.denied) return send({ error: { code: 'FORBIDDEN', message: 'Synthetic revoked authority' } }, 403);
      return send({ run: run(), awaitingDecision: state.awaiting, attempts: [{ stepKey: 'plan', state: 'SUCCEEDED', errorCode: null, artifactId: planId, artifactDigest: state.planDigest, completedAt: stamp }], decisions: [], plan: evidence(false), proposal: state.awaiting === 'CHANGE' || state.phase === 'COMPLETED' ? evidence(true) : null, result: state.phase === 'COMPLETED' ? { ...evidence(true), kind: 'RESULT' } : null });
    }
    if (path.endsWith('/candidate-decisions')) { const body = request.postDataJSON(); state.awaiting = body.status === 'APPROVED' ? 'CHANGE' : null; state.phase = body.status === 'APPROVED' ? 'AWAITING_APPROVAL' : 'CANCELLED'; return send({ decisionId: planId }); }
    if (path.endsWith('/change-decisions')) { state.awaiting = null; state.phase = 'COMPLETED'; return send({ decisionId: proposalId }); }
    if (path.endsWith('/cancel')) { if (options.cancelUnconfirmed) return send({ phase: state.phase, recorded: false, effectsUndone: false }); state.awaiting = null; state.phase = 'CANCELLED'; return send({ phase: state.phase, recorded: true, effectsUndone: false }); }
    return send([]);
  });
  return { writes, state };
}
async function open(page: Page) { await page.goto(url); await page.getByRole('button', { name: /Review security repairs/ }).click(); }

test.describe('synthetic staging security workflow UI (no remote execution)', () => {
  for (const width of [320, 1440]) test(`unavailable repair stays honest and accessible at ${width}px`, async ({ page }) => {
    const { writes } = await fixture(page, { available: false }); await page.setViewportSize({ width, height: 900 }); await open(page);
    const workspace = page.getByRole('region', { name: 'Security repair workspace', exact: true });
    await expect(workspace).toContainText('A trusted managed adapter is not registered. No work can run.');
    await expect(workspace.getByRole('button', { name: 'Prepare staging plan', exact: true })).toBeDisabled();
    await expect(workspace.getByText('No saved staging security runs yet. Opening this panel starts no work.')).toBeVisible();
    await expect(page.getByText('Keep my saved security conversation.')).toBeVisible();
    expect((await new AxeBuilder({ page }).include('[aria-label="Security repair workspace"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(writes).toEqual([]);
  });
  for (const width of [320, 1440]) test(`exact evidence is readable without losing the composer at ${width}px`, async ({ page }) => {
    const { writes } = await fixture(page, { saved: true }); await page.setViewportSize({ width, height: 900 }); await open(page);
    const evidence = page.getByRole('region', { name: 'Exact staging plan', exact: true }); await expect(evidence).toContainText('666 → 664');
    await evidence.getByLabel('Exact staging plan permission difference', { exact: true }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await expect(page.getByLabel('Message CodeBandage', { exact: true })).toBeInViewport();
    expect((await new AxeBuilder({ page }).include('[aria-label="Security repair workspace"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `/tmp/codebandage-security-repair-evidence-${width}.png`, fullPage: true }); expect(writes).toEqual([]);
  });
  test('MFA and two exact approvals are separate explicit actions and preserve the chat draft', async ({ page }) => {
    const { writes } = await fixture(page, { mfa: true }); await open(page);
    await page.getByLabel('Message CodeBandage', { exact: true }).fill('Keep this draft while I review the change.');
    const prepare = page.getByRole('button', { name: 'Prepare staging plan', exact: true }); await expect(prepare).toBeDisabled();
    await page.getByLabel('Six-digit authenticator code', { exact: true }).fill('123456'); await page.getByRole('button', { name: 'Verify identity for repair actions', exact: true }).click();
    await expect(page.getByLabel('Six-digit authenticator code', { exact: true })).toHaveValue('');
    await page.getByRole('combobox', { name: 'Enrolled staging target', exact: true }).selectOption(enrollmentId);
    await page.getByLabel('I authorize a read-only plan for this enrolled staging target.', { exact: false }).check(); await prepare.click();
    const candidate = page.getByRole('region', { name: 'Candidate work approval', exact: true });
    await expect(candidate).toBeVisible(); await expect(page.getByRole('region', { name: 'Exact staging plan', exact: true })).toContainText('666 → 664');
    await expect(candidate.getByRole('button', { name: 'Approve candidate work only', exact: true })).toBeDisabled();
    await candidate.getByRole('checkbox').check(); await candidate.getByRole('button', { name: 'Approve candidate work only', exact: true }).click();
    const change = page.getByRole('region', { name: 'Staging change approval', exact: true }); await expect(change).toBeVisible();
    await expect(change.getByRole('checkbox')).not.toBeChecked(); await expect(change.getByRole('button', { name: 'Approve exact staging change', exact: true })).toBeDisabled();
    await expect(page.getByRole('region', { name: 'Verified change proposal', exact: true })).toContainText('Encrypted · verified');
    await change.getByRole('checkbox').check(); await change.getByRole('button', { name: 'Approve exact staging change', exact: true }).click();
    await expect(page.getByText('The server recorded this bounded staging workflow as completed.', { exact: false })).toBeVisible();
    await expect(page.getByLabel('Message CodeBandage', { exact: true })).toHaveValue('Keep this draft while I review the change.');
    expect(writes.map(write => write.path)).toEqual(['/auth/mfa/step-up', `${base}/runs`, `${base}/runs/${runId}/candidate-decisions`, `${base}/runs/${runId}/change-decisions`]);
    expect(writes[1]!.body).toMatchObject({ enrollmentId, enrollmentRevision: 7, authorizationConfirmed: true });
    expect(Object.keys(writes[1]!.body).sort()).toEqual(['authorizationConfirmed', 'enrollmentId', 'enrollmentRevision', 'requestKey']);
    expect(writes[2]!.body).toMatchObject({ artifactId: planId, digest: 'a'.repeat(64), status: 'APPROVED' });
    expect(writes[3]!.body).toMatchObject({ artifactId: proposalId, digest: 'b'.repeat(64), status: 'APPROVED' });
    expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain('123456');
  });
  test('cancellation is confirmed by the server and never claims to undo effects', async ({ page }) => {
    const { writes } = await fixture(page, { saved: true }); await open(page);
    await page.getByRole('button', { name: 'Cancel security run', exact: true }).click();
    await expect(page.getByText('Cancellation is confirmed in the run journal.', { exact: false })).toBeVisible();
    await expect(page.getByText('Cancellation was recorded.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Cancel security run', exact: true })).toHaveCount(0);
    expect(writes).toHaveLength(1); expect(writes[0]!.path).toBe(`${base}/runs/${runId}/cancel`); expect(Object.keys(writes[0]!.body)).toEqual(['requestKey']);
  });
  test('an unconfirmed cancellation remains active and is never replayed automatically', async ({ page }) => {
    const { writes } = await fixture(page, { saved: true, cancelUnconfirmed: true }); await page.clock.install(); await open(page);
    await page.getByRole('button', { name: 'Cancel security run', exact: true }).click();
    await expect(page.getByText('Cancellation could not be confirmed.', { exact: false })).toBeVisible();
    await expect(page.getByText('Cancellation was recorded.', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel security run', exact: true })).toBeEnabled(); await page.clock.fastForward(31000); expect(writes).toHaveLength(1);
  });
  test('an unavailable adapter blocks approvals while keeping explicit cancellation available', async ({ page }) => {
    const { writes } = await fixture(page, { saved: true, available: false }); await open(page);
    await expect(page.getByRole('button', { name: 'Approve candidate work only', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Decline this plan', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Cancel security run', exact: true })).toBeEnabled(); expect(writes).toEqual([]);
  });
  test('restoration creates a new exact plan and requires two fresh approvals', async ({ page }) => {
    const { writes } = await fixture(page, { saved: true, completed: true }); await open(page);
    const recovery = page.getByRole('region', { name: 'Separate staging restoration', exact: true });
    await expect(recovery.getByRole('button', { name: 'Prepare separate restoration plan', exact: true })).toBeDisabled();
    await recovery.getByRole('checkbox').check(); await recovery.getByRole('button', { name: 'Prepare separate restoration plan', exact: true }).click();
    const candidate = page.getByRole('region', { name: 'Candidate work approval', exact: true }); await expect(candidate).toBeVisible();
    await expect(page.getByRole('region', { name: 'Exact staging plan', exact: true })).toContainText('664 → 666');
    expect(writes).toHaveLength(1); expect(writes[0]!.body).toMatchObject({ operation: 'RESTORE', recoveryRunId: runId, enrollmentId, enrollmentRevision: 7, authorizationConfirmed: true });
    await candidate.getByRole('checkbox').check(); await candidate.getByRole('button', { name: 'Approve candidate work only', exact: true }).click();
    const change = page.getByRole('region', { name: 'Staging change approval', exact: true }); await expect(change.getByRole('checkbox')).not.toBeChecked();
    await expect(change).toContainText('I authorize only this staging file permission restoration.'); await change.getByRole('checkbox').check(); await change.getByRole('button', { name: 'Approve exact staging restoration', exact: true }).click();
    await expect(page.getByText('The server recorded this bounded staging workflow as completed.', { exact: false })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Separate staging restoration', exact: true })).toHaveCount(0);
    expect(writes.map(write => write.path)).toEqual([`${base}/runs`, `${base}/runs/${restoreId}/candidate-decisions`, `${base}/runs/${restoreId}/change-decisions`]);
  });
  test('a different session can review evidence without authorizing actions', async ({ page }) => {
    const { writes } = await fixture(page, { saved: true, sessionBound: false }); await open(page);
    await expect(page.getByText('This run belongs to a different sign-in session.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Approve candidate work only', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Cancel security run', exact: true })).toBeDisabled(); expect(writes).toEqual([]);
  });
  test('revoked authority removes cached exact evidence and blocks approvals', async ({ page }) => {
    const { writes, state } = await fixture(page, { saved: true }); await page.clock.install(); await open(page);
    await expect(page.getByRole('region', { name: 'Exact staging plan', exact: true })).toBeVisible(); state.denied = true;
    await page.clock.fastForward(4100);
    await expect(page.getByText('This run could not be refreshed.', { exact: false })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Exact staging plan', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve candidate work only', exact: true })).toHaveCount(0); expect(writes).toEqual([]);
  });
  test('a replaced approval artifact clears existing consent', async ({ page }) => {
    const { state, writes } = await fixture(page, { saved: true }); await page.clock.install(); await open(page);
    const candidate = page.getByRole('region', { name: 'Candidate work approval', exact: true }); await candidate.getByRole('checkbox').check(); state.planDigest = 'f'.repeat(64);
    await page.clock.fastForward(4100);
    await expect(candidate.getByRole('checkbox')).not.toBeChecked(); await expect(candidate.getByRole('button', { name: 'Approve candidate work only', exact: true })).toBeDisabled(); expect(writes).toEqual([]);
  });
  test('an uncertain create response never automatically retries and still loads the saved run', async ({ page }) => {
    const { writes } = await fixture(page, { createUncertain: true }); await page.clock.install(); await open(page);
    await page.getByRole('combobox', { name: 'Enrolled staging target', exact: true }).selectOption(enrollmentId); await page.getByLabel('I authorize a read-only plan for this enrolled staging target.', { exact: false }).check(); await page.getByRole('button', { name: 'Prepare staging plan', exact: true }).click();
    await expect(page.getByText('The action could not be confirmed.', { exact: false })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Saved security run', exact: true })).toBeVisible(); await page.clock.fastForward(31000);
    expect(writes).toHaveLength(1); expect(writes[0]!.path).toBe(`${base}/runs`);
  });
});
