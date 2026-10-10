import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const id = 'e33690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
const site = { id, name: 'Care UI fixture', url: 'https://example.test', normalizedHost: 'example.test', connectionStatus: 'PENDING', findings: [], scans: [], tickets: [], backups: [], reports: [] };
test('staging text workspace requires consent, saves versions and static checks, and retains history after reload and closure', async ({ page }) => {
  const reviewId = 'a13690a6-6d5e-4f7b-9e86-5f8f7913d2ea'; const workspaceId = 'b13690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
  let created = false; let version = 1; let closed = false; let checked = false;
  const revision = { id: 'c13690a6-6d5e-4f7b-9e86-5f8f7913d2ea', version: 1, sourceDigest: 'a'.repeat(64), state: 'COMPLETED', budgetMicros: 1000, chargedMicros: 0, budgetState: 'SETTLED', plan: { roleIds: ['A01'], language: 'en', boundary: 'Review supplied source only.', requestFingerprint: 'b'.repeat(64), configuration: { model: 'Fixture' } } };
  const timestamp = new Date().toISOString();
  const result = { version: 2, sourceDigest: 'b'.repeat(64), output: { state: 'NO_ISSUES_DETECTED', check: 'snapshot-typescript-types', limitation: 'No runtime tests were run.' } };
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const reviewJob = { id: reviewId, kind: 'REVIEW', summary: 'Source selected for text edits', environment: 'STAGING', state: 'COMPLETED', agents: [], createdAt: timestamp, errorCode: null };
    if (path.endsWith('/care')) return route.fulfill({ json: { credentials: [], accessRequests: [], roles: [], jobs: [reviewJob, ...(created ? [{ id: workspaceId, kind: 'WORKSPACE', summary: 'Text workspace: source changes', environment: 'STAGING', state: closed ? 'CANCELLED' : 'WAITING_FOR_INPUT', agents: [], createdAt: timestamp }] : [])], capabilities: { sourceReview: true } } });
    if (path.endsWith('/review')) return route.fulfill({ json: { job: reviewJob, revision, reports: [], agents: [], totalSteps: 1, completedSteps: 0, capabilities: { enabled: true } } });
    if (path.endsWith(`/jobs/${reviewId}/workspaces`)) { expect(route.request().postDataJSON()).toMatchObject({ revisionId: revision.id, sourceDigest: revision.sourceDigest, authorizeTextWorkspace: true }); created = true; return route.fulfill({ status: 201, json: { jobId: workspaceId } }); }
    if (path.endsWith(`/workspaces/${workspaceId}`)) return route.fulfill({ json: { job: { id: workspaceId, state: closed ? 'CANCELLED' : 'WAITING_FOR_INPUT' }, revision: { id: `revision-${version}`, version, sourceDigest: (version === 1 ? 'a' : 'b').repeat(64) }, files: [{ path: 'src/value.ts', content: `export const count = ${version};` }], history: Array.from({ length: version }, (_, i) => ({ id: `revision-${i + 1}`, version: i + 1, createdAt: timestamp })), checks: checked ? [{ id: 'check-1', filename: 'T34-check.json', createdAt: timestamp }] : [] } });
    if (path.endsWith('/patches')) { expect(route.request().postDataJSON()).toMatchObject({ version: 1, sourceDigest: 'a'.repeat(64), authorizeTextPatch: true, patches: [{ path: 'src/value.ts', before: 'count = 1', after: 'count = 2' }] }); version = 2; return route.fulfill({ status: 201, json: { revision: { version: 2 } } }); }
    if (path.endsWith('/checks/T34')) { expect(route.request().postDataJSON()).toMatchObject({ version: 2, sourceDigest: 'b'.repeat(64) }); checked = true; return route.fulfill({ status: 201, json: result }); }
    if (path.endsWith('/check-results/check-1')) return route.fulfill({ json: result });
    if (path.endsWith(`/jobs/${workspaceId}/cancel`)) { closed = true; return route.fulfill({ json: { state: 'CANCELLED' } }); }
    if (path.endsWith('/versions/1')) return route.fulfill({ json: { files: [{ path: 'src/value.ts', content: 'export const count = 1;' }] } });
    return route.fallback();
  });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/customer/websites/${id}`);
  await page.getByLabel('Environment', { exact: true }).selectOption('STAGING');
  await page.getByRole('button', { name: 'Open team review' }).click();
  await page.getByText('Create a text workspace', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Create text workspace', exact: true })).toBeDisabled();
  await page.getByLabel('I authorize copying this exact source selection into a text workspace.').check();
  await page.getByRole('button', { name: 'Create text workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Open text workspace' }).click();
  const panel = page.getByRole('region', { name: 'Text workspace', exact: true });
  await panel.getByLabel('Workspace file').selectOption('src/value.ts');
  await panel.getByLabel('Original text to replace').fill('count = 1'); await panel.getByLabel('Replacement text').fill('count = 2');
  await expect(panel.getByRole('button', { name: 'Save text version' })).toBeDisabled();
  await panel.getByLabel('I reviewed this exact text change and authorize saving a new version.').check();
  await panel.getByRole('button', { name: 'Save text version' }).click();
  await expect(panel.getByRole('heading', { name: 'Saved version 2 · Open for text edits' })).toBeVisible();
  await panel.getByRole('button', { name: 'Run snapshot type check' }).click(); await expect(panel.getByText(/No runtime tests were run/)).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Text workspace"]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze(); expect(accessibility.violations).toEqual([]);
  await page.reload(); await page.getByLabel('Environment', { exact: true }).selectOption('STAGING'); await page.getByRole('button', { name: 'Open text workspace' }).click();
  await expect(panel.getByRole('heading', { name: 'Saved version 2 · Open for text edits' })).toBeVisible();
  await panel.getByText('Saved static checks · 1', { exact: true }).click(); await panel.getByRole('button', { name: /^T34 ·/ }).click(); await expect(panel.getByText(/No runtime tests were run/)).toBeVisible();
  await panel.getByRole('button', { name: 'Close workspace and keep history' }).click(); await expect(panel.getByRole('heading', { name: 'Saved version 2 · Closed; history retained' })).toBeVisible();
  await panel.getByText('Saved versions · 2', { exact: true }).click();
  const download = page.waitForEvent('download'); await panel.getByRole('button', { name: 'Download version 1' }).click(); expect((await download).suggestedFilename()).toBe('workspace-v1.json');
});
test('stored screenshot comparison sends only selected artifact IDs and displays measurement limitations', async ({ page }) => {
  const jobId = '31d7b8b9-79a0-4025-a2fb-9d5908e31ee5'; const baseline = 'a13690a6-6d5e-4f7b-9e86-5f8f7913d2ea'; const candidate = 'b13690a6-6d5e-4f7b-9e86-5f8f7913d2ea';
  await page.route('**/care?**', (route) => route.fulfill({ json: { credentials: [], accessRequests: [], roles: [], jobs: [{ id: jobId, kind: 'REPAIR', summary: 'Compare stored screenshots', state: 'WAITING_FOR_INPUT', environment: 'PRODUCTION', agents: [], createdAt: new Date().toISOString() }], capabilities: {} } }));
  await page.route('**/tools/T29', (route) => { expect(route.request().postDataJSON()).toEqual({ baselineArtifactId: baseline, candidateArtifactId: candidate }); return route.fulfill({ json: { output: { state: 'PIXEL_DIFFERENCES', changedPixels: 20, limitation: 'Renderer provenance is not verified.' } } }); });
  await page.goto(`/customer/websites/${id}`); await page.getByText('Saved evidence & source tools', { exact: true }).click(); await page.getByLabel('Evidence to read').selectOption('T29');
  await page.getByLabel('Baseline screenshot artifact ID').fill(baseline); await page.getByLabel('Candidate screenshot artifact ID').fill(candidate); await page.getByRole('button', { name: 'Read evidence', exact: true }).click();
  await expect(page.getByText(/Renderer provenance is not verified/)).toBeVisible();
});
test('saved evidence tools show real states and retain monitoring proposals without activating them', async ({ page }) => {
  const jobId = '31d7b8b9-79a0-4025-a2fb-9d5908e31ee5';
  const proposalId = 'a941c1ca-782a-4104-8819-fde9b1b97c7b';
  let saved = false;
  await page.route('**/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/care')) return route.fulfill({ json: { credentials: [], accessRequests: [], roles: [], jobs: [{ id: jobId, kind: 'REPAIR', summary: 'Review the saved issue', state: 'WAITING_FOR_INPUT', environment: 'PRODUCTION', agents: [], createdAt: new Date().toISOString() }, ...(saved ? [{ id: proposalId, kind: 'MONITOR_PLAN', summary: 'Monitoring schedule proposal requires customer review', expectedBehavior: JSON.stringify({ intervalMinutes: 60, activation: 'NOT_SCHEDULED' }), state: 'WAITING_FOR_INPUT', environment: 'PRODUCTION', agents: [], createdAt: new Date().toISOString() }] : [])], capabilities: { attachments: false, isolatedRepair: false, deployment: false } } });
    if (path.endsWith('/tools/T58')) { expect(route.request().postDataJSON()).toEqual({}); return route.fulfill({ json: { toolId: 'T58', output: { state: 'NOT_OBSERVED', limitation: 'No recorded monitoring check exists.' } } }); }
    if (path.endsWith('/monitoring-plan')) { expect(route.request().postDataJSON()).toMatchObject({ intervalMinutes: 60, expectedStatus: 200 }); saved = true; return route.fulfill({ status: 201, json: { proposalJobId: proposalId, proposal: { activation: 'NOT_SCHEDULED' } } }); }
    return route.fallback();
  });
  await page.goto(`/customer/websites/${id}`);
  await page.getByText('Saved evidence & source tools', { exact: true }).click();
  await page.getByLabel('Evidence to read').selectOption('T58');
  await page.getByRole('button', { name: 'Read evidence', exact: true }).click();
  await expect(page.getByText(/No recorded monitoring check exists/)).toBeVisible();
  const accessibility = await new AxeBuilder({ page }).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  await expect(page.getByRole('button', { name: 'Save monitoring proposal' })).toBeDisabled();
  await page.getByLabel('Save this proposal for review; do not activate monitoring.').check();
  await page.getByRole('button', { name: 'Save monitoring proposal' }).click();
  await expect(page.getByRole('heading', { name: 'Monitoring schedule proposal requires customer review' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Monitoring schedule proposal requires customer review' })).toBeVisible();
  await expect(page.getByText('waiting for input · No monitoring was activated by this proposal.')).toBeVisible();
});
test('technology team presets use available roles and invalid upload paths are blocked before submission', async ({ page }) => {
  const roles = ['A01','A03','A05','A08','A09','A12','A14','A18'].map(id => ({ id, name: `Review role ${id}`, implementation: 'SOURCE_REVIEW' }));
  await page.route('**/care?**', async route => route.fulfill({ json: { credentials: [], accessRequests: [], jobs: [], roles, capabilities: { sourceReview: true, maximumReviewBudgetMicros: 5000000 } } }));
  await page.goto(`/customer/websites/${id}`);
  await page.getByRole('button', { name: 'Review source with AI team' }).click();
  const form = page.getByRole('form', { name: 'New source review' });
  await form.getByLabel('Technology area · suggested team').selectOption('devops');
  await expect(form.getByRole('checkbox', { checked: true })).toHaveCount(6);
  await expect(form.getByText(/YAML syntax and duplicate keys/)).toBeVisible();
  await form.getByLabel('Reviewed text source files').setInputFiles({ name: 'secrets.yaml', mimeType: 'text/plain', buffer: Buffer.from('sanitized: example') });
  await expect(form.getByRole('alert')).toContainText('credential files');
  await form.getByLabel('I reviewed these files').check();
  await expect(form.getByRole('button', { name: 'Prepare team review plan' })).toBeDisabled();
  await form.getByLabel('Source path 1', { exact: true }).fill('deploy.yaml');
  await expect(form.getByRole('alert')).toHaveCount(0);
  await expect(form.getByLabel('I reviewed these files')).not.toBeChecked();
  await form.getByRole('button', { name: 'Select all 8 roles' }).click();
  await expect(form.getByRole('checkbox', { checked: true })).toHaveCount(8);
  await expect(form.getByLabel('Technology area · suggested team')).toHaveValue('');
});
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
  await page.route('**/care?**', async (route) => route.fulfill({ json: { credentials: [], accessRequests: [], jobs: [], roles: [{ id: 'A09', name: 'Accessibility Reviewer', implementation: 'SOURCE_REVIEW' }], capabilities: { sourceReview: true, maximumReviewBudgetMicros: 5000000 } } }));
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
  await page.getByRole('button', { name: 'Message assistant' }).click();
  await page.getByLabel('Secure access details').fill('Host: server.example.test\nUsername: deploy\nPassword: synthetic-browser-marker');
  await expect(page.getByRole('button', { name: 'Store securely' })).toBeDisabled();
  await page.getByLabel('I’m authorized to provide').check();
  await page.getByRole('button', { name: 'Store securely' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Access stored securely' })).toBeVisible();
  expect(submitted).toMatchObject({ mode: 'SECURE', authorizationConfirmed: true });
  await expect(page.getByLabel('Conversation history')).not.toContainText('synthetic-browser-marker');
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('synthetic-browser-marker');
});

test('disabled Care shows truthful tools and saves a development brief without starting AI work', async ({ page }) => {
  let submitted: { subject: string; message: string } | undefined; let aiCalls = 0;
  await page.route('**/care?**', route => route.fulfill({ status: 503, json: { error: { code: 'CAPABILITY_DISABLED', message: 'The new care workspace is not enabled.' } } }));
  await page.route('**/support/conversations', route => { submitted = route.request().postDataJSON(); return route.fulfill({ status: 201, json: { id: 'request-fixture' } }); });
  await page.route('**/chat/ingest', route => { aiCalls++; return route.fulfill({ json: {} }); });
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`/customer/websites/${id}`);
  await expect(page.getByLabel('Message CodeBandage')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Connections →' })).toHaveAttribute('href', `/customer/websites/${id}/access`);
  await page.getByText('Workspace controls', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Report an issue', exact: true })).toBeDisabled();
  await page.getByText('Tools & availability', { exact: true }).click();
  await expect(page.getByText(/Care workflows are disabled on this server/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prepare AI source review' })).toBeDisabled();
  await page.getByRole('button', { name: 'Full-stack web development', exact: true }).click();
  await page.getByLabel('Requested work', { exact: true }).fill('Add a mobile-friendly contact form on the homepage.');
  await page.getByLabel('How should we verify success?').fill('Keyboard navigation works and submitted messages show a receipt.');
  const save = page.getByRole('button', { name: 'Save request for human review' }); await expect(save).toBeDisabled();
  await page.getByLabel('I reviewed this brief').check(); await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Request saved in Support' })).toBeVisible();
  expect(submitted?.subject).toBe('Develop a feature: Care UI fixture'); expect(submitted?.message).toContain('Environment: PRODUCTION');
  expect(submitted?.message).toContain('No permission to execute code'); expect(aiCalls).toBe(0);
  expect((await new AxeBuilder({ page }).include('.care-chat').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([]);
});

test('task briefs clear on environment changes and refuse apparent credentials', async ({ page }) => {
  let writes = 0; await page.route('**/support/conversations', route => { writes++; return route.fulfill({ json: {} }); });
  await page.goto(`/customer/websites/${id}`); await page.getByRole('button', { name: 'Website redesign', exact: true }).click();
  await page.getByLabel('Requested work', { exact: true }).fill('password: synthetic-test-only-marker');
  await page.getByLabel('How should we verify success?').fill('Mobile layout must fit the viewport.');
  await page.getByLabel('I reviewed this brief').check(); await page.getByRole('button', { name: 'Save request for human review' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This appears to contain access information' })).toBeVisible(); expect(writes).toBe(0);
  await page.getByLabel('Environment', { exact: true }).selectOption('STAGING'); await expect(page.getByRole('form', { name: 'Website task brief' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Fix an issue', exact: true }).click(); await expect(page.getByLabel('Requested work', { exact: true })).toHaveValue('');
});

test('message mode redirects apparent secrets to consent-gated capture before any request', async ({ page }) => {
  let writes = 0; await page.route('**/chat/ingest', route => { writes++; return route.fulfill({ json: {} }); });
  await page.goto(`/customer/websites/${id}`); await page.getByLabel('Message CodeBandage').fill('password: synthetic-test-only-marker');
  await page.getByRole('button', { name: 'Send ↑', exact: true }).click();
  await expect(page.getByLabel('Secure access details')).toBeVisible(); await expect(page.getByRole('button', { name: 'Store securely' })).toBeDisabled(); expect(writes).toBe(0);
});

for (const width of [390, 1280]) {
  test(`automated WCAG checks for workspace panels in light and dark at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/customer/websites/${id}`);
    await expect(page.getByLabel('Message CodeBandage')).toBeVisible();
    await page.getByText('Workspace controls', { exact: true }).click();
    await page.getByRole('button', { name: 'Report an issue', exact: true }).click();
    await page.getByRole('button', { name: /Your AI team/ }).click();
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark') await page.getByRole('button', { name: 'Switch to dark theme' }).click();
      const result = await new AxeBuilder({ page }).include('.care-chat').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
      expect(result.violations, JSON.stringify(result.violations, null, 2)).toEqual([]);
    }
  });
}

test('older messages and jobs remain reachable after a workspace reload', async ({ page }) => {
  const recent = Array.from({ length: 200 }, (_, index) => ({ id: `recent-${index}`, type: 'SYSTEM', content: `Recent conversation ${index}`, createdAt: new Date().toISOString() }));
  await page.route('**/chat?**', (route) => route.fulfill({ json: new URL(route.request().url()).searchParams.has('before') ? [{ id: 'old-message', type: 'SYSTEM', content: 'Saved oldest conversation', createdAt: new Date().toISOString() }] : recent }));
  await page.route('**/care?**', (route) => {
    const older = new URL(route.request().url()).searchParams.has('before');
    return route.fulfill({ json: { credentials: [], accessRequests: [], jobs: older ? [{ id: 'old-job', kind: 'REPAIR', summary: 'Saved oldest repair request', state: 'WAITING_FOR_INPUT', environment: 'PRODUCTION', agents: [], createdAt: new Date().toISOString() }] : [], nextCursor: older ? null : 'first-job', capabilities: {} } });
  });
  await page.goto(`/customer/websites/${id}`);
  for (let repeat = 0; repeat < 2; repeat++) {
    await expect(page.getByLabel('Conversation history')).toContainText('Recent conversation 199');
    await page.getByRole('button', { name: 'Load older messages' }).click();
    await expect(page.getByLabel('Conversation history')).toContainText('Saved oldest conversation');
    await page.getByRole('button', { name: 'Load older jobs' }).click();
    await expect(page.getByRole('heading', { name: 'Saved oldest repair request' })).toBeVisible();
    if (!repeat) await page.reload();
  }
});
test('mobile, reduced motion and Tamil content remain within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 }); await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`/customer/websites/${id}`);
  await page.getByLabel('Message CodeBandage').fill('என் இணையதளத்தில் மொபைல் மெனு சரியாக வேலை செய்யவில்லை.');
  await expect(page.getByRole('button', { name: 'Send', exact: false })).toBeVisible();
  const overflow = await page.evaluate(() => ({ width: innerWidth, pageWidth: document.documentElement.scrollWidth, elements: Array.from(document.querySelectorAll('body *')).filter((element) => element.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(element).position !== 'absolute').slice(0, 8).map((element) => ({ tag: element.tagName, class: element.className, right: element.getBoundingClientRect().right })) }));
  expect(overflow.pageWidth, JSON.stringify(overflow)).toBeLessThanOrEqual(overflow.width);
  await page.screenshot({ path: 'test-results/care-mobile.png', fullPage: true });
});
test('environment changes clear draft and receipt context', async ({ page }) => {
  await page.goto(`/customer/websites/${id}`); await page.getByRole('button', { name: 'Message assistant' }).click(); await page.getByLabel('Secure access details').fill('sensitive draft');
  await page.getByLabel('Environment', { exact: true }).selectOption('STAGING');
  await expect(page.getByLabel('Secure access details')).toHaveValue('');
  await page.getByRole('button', { name: /Your AI team/ }).click();
  await expect(page.getByText('No AI role has been assigned yet.')).toBeVisible();
  await page.screenshot({ path: 'test-results/care-desktop.png', fullPage: true });
});
test('untrusted Markdown cannot load remote images or render raw HTML', async ({ page }) => {
  let remoteImages=0;
  await page.route('https://invalid.example.test/pixel', route => { remoteImages++; return route.abort(); });
  await page.route('**/chat?**', async (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify([{ id: 'fixture-message', type: 'AI', content: '<button>Forged approval</button>\n\n![tracking](https://invalid.example.test/pixel)\n\n[unsafe](javascript:alert(1))', createdAt: new Date().toISOString() }]) }));
  await page.goto(`/customer/websites/${id}`);
  await expect(page.getByLabel('Conversation history')).toContainText('Image omitted');
  await expect(page.getByRole('button', { name: 'Forged approval' })).toHaveCount(0);
  const avatars=page.locator('.care-message img');
  await expect(avatars).toHaveCount(1);
  await expect(avatars).toHaveAttribute('src','/brand/codebandage-mark.png?v=blue-20261009');
  await expect(avatars).toHaveAttribute('alt','');
  await expect(page.locator('.care-message > :not(.care-message-label) img')).toHaveCount(0);
  await expect(page.locator('.care-message a[href^="javascript:"]')).toHaveCount(0);
  expect(remoteImages).toBe(0);
});

for (const width of [390, 768, 1280, 1440]) {
  test(`chat fits ${width}px and keeps navigation accessible`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/customer/websites/${id}`);
    await expect(page.getByLabel('Message CodeBandage')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    if (width < 1024) {
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await expect(page.getByRole('navigation', { name: 'All customer pages' })).toBeVisible();
      await page.getByRole('button', { name: 'Close navigation', exact: true }).click();
      await page.locator('.care-composer').scrollIntoViewIfNeeded();
      const composer = await page.locator('.care-composer').boundingBox();
      const navigation = await page.getByRole('navigation', { name: 'Customer mobile navigation' }).boundingBox();
      expect(composer!.y + composer!.height).toBeLessThanOrEqual(navigation!.y);
    }
    await page.getByRole('button', { name: 'Switch to dark theme' }).click();
    await expect(page.locator('.care-chat')).toHaveClass(/care-theme-dark/);
  });
}
test('IME Enter does not submit a message', async ({ page }) => {
  let submitted = 0;
  await page.route('**/chat/ingest', (route) => { submitted += 1; return route.fulfill({ contentType: 'application/json', body: '{}' }); });
  await page.goto(`/customer/websites/${id}`);
  const input = page.getByLabel('Message CodeBandage'); await input.fill('தமிழ் composing input');
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

test('consented HTTP observation shows retained results and never reruns when the page reloads', async ({ page }) => {
  const jobId = '31d7b8b9-79a0-4025-a2fb-9d5908e31ee5'; const runId = 'a941c1ca-782a-4104-8819-fde9b1b97c7b'; let calls = 0;
  await page.route('**/care?**', route => route.fulfill({ json: { credentials: [], accessRequests: [], roles: [], jobs: [{ id: jobId, kind: 'REPAIR', summary: 'Observe the approved website', state: 'COMPLETED', environment: 'PRODUCTION', agents: [], createdAt: new Date().toISOString() }], capabilities: {} } }));
  await page.route('**/observation-options', route => route.fulfill({ json: { target: 'https://example.org/', environment: 'PRODUCTION', networkAvailable: true, advisoriesAvailable: false, revisionId: null, sourceDigest: null, inventory: null, history: calls ? [{ id: runId, toolId: 'T23', state: 'COMPLETED', createdAt: new Date().toISOString() }] : [], nextCursor: null } }));
  await page.route(`**/observations/${runId}`, route => route.fulfill({ json: { state: 'COMPLETED', result: { status: 200, limitation: 'No application-security assessment was performed.' } } }));
  await page.route('**/observations', route => { calls++; expect(route.request().postDataJSON()).toEqual({ requestKey: expect.any(String), toolId: 'T23', confirmTarget: 'https://example.org/', authorizeReadOnlyObservation: true }); return route.fulfill({ status: 201, json: { runId, state: 'COMPLETED' } }); });
  await page.goto(`/customer/websites/${id}`);
  await page.getByText('Authorized website observations & advisory matching', { exact: true }).click();
  const run = page.getByRole('button', { name: 'Run this observation', exact: true });
  await expect(run).toBeDisabled(); await page.getByLabel('I am authorized for this website and approve this single read-only observation of the displayed target.').check(); await run.click();
  await expect(page.getByText(/No application-security assessment was performed/)).toBeVisible(); expect(calls).toBe(1);
  await page.reload(); await page.getByText('Authorized website observations & advisory matching', { exact: true }).click();
  await page.getByRole('button', { name: /^T23 · COMPLETED ·/ }).click();
  await expect(page.getByText(/No application-security assessment was performed/)).toBeVisible(); expect(calls).toBe(1);
});

test('advisory matching requires selected exact packages and separate disclosure consent', async ({ page }) => {
  const jobId = '31d7b8b9-79a0-4025-a2fb-9d5908e31ee5'; const runId = 'a941c1ca-782a-4104-8819-fde9b1b97c7b'; const revisionId = 'b941c1ca-782a-4104-8819-fde9b1b97c7b'; let calls = 0;
  await page.route('**/care?**', route => route.fulfill({ json: { credentials: [], accessRequests: [], roles: [], jobs: [{ id: jobId, kind: 'REVIEW', summary: 'Review exact dependencies', state: 'COMPLETED', environment: 'PRODUCTION', agents: [], createdAt: new Date().toISOString() }], capabilities: {} } }));
  await page.route('**/observation-options', route => route.fulfill({ json: { target: 'https://example.org/', environment: 'PRODUCTION', networkAvailable: false, advisoriesAvailable: true, revisionId, sourceDigest: 'a'.repeat(64), inventory: { entries: [{ ecosystem: 'npm', name: 'sample', version: '1.2.3', evidence: 'LOCKFILE', path: 'package-lock.json' }, { ecosystem: 'npm', name: 'private-package', version: '2.0.0', evidence: 'LOCKFILE', path: 'package-lock.json' }], skipped: 1, truncated: false, limitation: 'Declared versions only.' }, history: [], nextCursor: null } }));
  await page.route('**/observations', route => { calls++; expect(route.request().postDataJSON()).toEqual({ requestKey: expect.any(String), toolId: 'T20', revisionId, sourceDigest: 'a'.repeat(64), packages: [{ ecosystem: 'npm', name: 'sample', version: '1.2.3' }], consentToSharePackageVersions: true }); return route.fulfill({ status: 201, json: { runId, state: 'COMPLETED' } }); });
  await page.route(`**/observations/${runId}`, route => route.fulfill({ json: { state: 'COMPLETED', result: { state: 'NO_MATCHES_REPORTED', limitation: 'Not proof of a vulnerability-free website.' } } }));
  await page.goto(`/customer/websites/${id}`); await page.getByText('Authorized website observations & advisory matching', { exact: true }).click();
  await page.getByLabel('Observation', { exact: true }).selectOption('T20');
  const consent = page.getByLabel('I approve sharing only these selected package versions with OSV for this lookup.');
  await expect(consent).toBeDisabled(); await page.getByLabel('sample 1.2.3 (npm; lockfile)').check();
  await expect(page.getByRole('button', { name: 'Run this observation', exact: true })).toBeDisabled(); await consent.check();
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Approved observations"]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze(); expect(accessibility.violations).toEqual([]);
  await page.getByRole('button', { name: 'Run this observation', exact: true }).click();
  await expect(page.getByText(/Not proof of a vulnerability-free website/)).toBeVisible(); expect(calls).toBe(1);
});

test('observation consent becomes invalid when the displayed target changes after refresh', async ({ page }) => {
  const jobId = '31d7b8b9-79a0-4025-a2fb-9d5908e31ee5'; let currentTarget = 'https://example.org/';
  await page.route('**/care?**', route => route.fulfill({ json: { credentials: [], accessRequests: [], roles: [], jobs: [{ id: jobId, kind: 'REPAIR', summary: 'Review target binding', state: 'COMPLETED', environment: 'PRODUCTION', agents: [], createdAt: new Date().toISOString() }], capabilities: {} } }));
  await page.route('**/observation-options', route => route.fulfill({ json: { target: currentTarget, environment: 'PRODUCTION', networkAvailable: true, advisoriesAvailable: false, revisionId: null, sourceDigest: null, inventory: null, history: [], nextCursor: null } }));
  await page.goto(`/customer/websites/${id}`); const details = page.getByText('Authorized website observations & advisory matching', { exact: true }); await details.click();
  const consent = page.getByLabel('I am authorized for this website and approve this single read-only observation of the displayed target.'); await consent.check();
  await expect(page.getByRole('button', { name: 'Run this observation', exact: true })).toBeEnabled();
  await details.click(); currentTarget = 'https://changed.example.org/'; await details.click();
  await expect(page.getByText(currentTarget, { exact: true })).toBeVisible();
  await expect(consent).not.toBeChecked(); await expect(page.getByRole('button', { name: 'Run this observation', exact: true })).toBeDisabled();
});

test('offline browser tools bind consent to the source and viewport, retain evidence and never replay on reload', async ({ page }) => {
  const jobId = '31d7b8b9-79a0-4025-a2fb-9d5908e31ee5'; const runId = 'a941c1ca-782a-4104-8819-fde9b1b97c7b'; let calls = 0;
  const selected = { revisionId: 'b941c1ca-782a-4104-8819-fde9b1b97c7b', artifactId: 'c941c1ca-782a-4104-8819-fde9b1b97c7b', sourceDigest: 'a'.repeat(64), path: 'index.html', label: 'Version 1: index.html' };
  await page.route('**/care?**', route => route.fulfill({ json: { credentials: [], accessRequests: [], roles: [], jobs: [{ id: jobId, kind: 'REVIEW', summary: 'Browser fixture', state: 'COMPLETED', environment: 'PRODUCTION', agents: [], createdAt: new Date().toISOString() }], capabilities: {} } }));
  await page.route('**/browser-options', route => route.fulfill({ json: { enabled: true, policy: 'offline-static-browser-v1', sources: [selected], history: calls ? [{ id: runId, toolId: 'T26', state: 'COMPLETED', errorCode: null, createdAt: new Date().toISOString() }] : [], nextCursor: null } }));
  await page.route(`**/browser-runs/${runId}`, route => route.fulfill({ json: { state: 'COMPLETED', result: { accessibilitySnapshot: 'Public fixture heading', boundary: 'Static browser evidence only.' }, screenshot: null } }));
  await page.route('**/browser-runs', route => { calls++; expect(route.request().postDataJSON()).toEqual({ requestKey: expect.any(String), toolId: 'T26', revisionId: selected.revisionId, artifactId: selected.artifactId, sourceDigest: selected.sourceDigest, path: 'index.html', viewport: 'MOBILE', privateIds: ['customer-details'], authorizeStaticBrowser: true, privacyReviewed: true }); return route.fulfill({ status: 201, json: { runId, state: 'COMPLETED' } }); });
  await page.goto(`/customer/websites/${id}`); await page.getByText('Offline HTML browser tools', { exact: true }).click();
  const run = page.getByRole('button', { name: 'Run approved browser check', exact: true }); const consent = page.getByLabel('I reviewed this page for private information', { exact: false });
  await expect(run).toBeDisabled(); await page.getByLabel('Saved HTML version').selectOption({ label: selected.label }); await page.getByLabel('Browser check', { exact: true }).selectOption('T26');
  await consent.check(); await page.getByLabel('Viewport', { exact: true }).selectOption('MOBILE'); await expect(consent).not.toBeChecked();
  await page.getByLabel('Private region HTML IDs (optional)').fill('customer-details'); await consent.check();
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Offline browser check"]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze(); expect(accessibility.violations).toEqual([]);
  await run.click(); await expect(page.getByText(/Public fixture heading/)).toBeVisible(); expect(calls).toBe(1);
  await page.reload(); await page.getByText('Offline HTML browser tools', { exact: true }).click(); await page.getByRole('button', { name: /^Accessibility snapshot · COMPLETED/ }).click();
  await expect(page.getByText(/Public fixture heading/)).toBeVisible(); expect(calls).toBe(1);
});

test('saved browser evidence remains visible with new runs disabled', async ({ page }) => {
  const jobId = '31d7b8b9-79a0-4025-a2fb-9d5908e31ee5'; const runId = 'a941c1ca-782a-4104-8819-fde9b1b97c7b';
  await page.route('**/care?**', route => route.fulfill({ json: { credentials: [], accessRequests: [], roles: [], jobs: [{ id: jobId, kind: 'REPAIR', summary: 'Retained browser evidence', state: 'CANCELLED', environment: 'PRODUCTION', agents: [], createdAt: new Date().toISOString() }], capabilities: {} } }));
  await page.route('**/browser-options', route => route.fulfill({ json: { enabled: false, policy: 'offline-static-browser-v1', sources: [], history: [{ id: runId, toolId: 'T28', state: 'COMPLETED', errorCode: null, createdAt: new Date().toISOString() }], nextCursor: null } }));
  await page.route(`**/browser-runs/${runId}`, route => route.fulfill({ json: { state: 'COMPLETED', result: { journey: { id: 'static-document-v1', passed: false }, boundary: 'This saved check found viewport overflow.' }, screenshot: null } }));
  await page.goto(`/customer/websites/${id}`); await page.getByText('Offline HTML browser tools', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Run approved browser check', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /^Static document journey · COMPLETED/ }).click(); await expect(page.getByText(/This saved check found viewport overflow/)).toBeVisible();
});

test('isolated verification binds approval, displays failed checks and retains history across reload and disabled execution', async ({ page }) => {
  const jobId = '31d7b8b9-79a0-4025-a2fb-9d5908e31ee5'; const runId = 'a941c1ca-782a-4104-8819-fde9b1b97c7b'; let calls = 0; let enabled = true;
  const source = { revisionId: 'b941c1ca-782a-4104-8819-fde9b1b97c7b', artifactId: 'c941c1ca-782a-4104-8819-fde9b1b97c7b', sourceDigest: 'a'.repeat(64), label: 'Version 1: source.json' };
  const imageDigest = `sha256:${'b'.repeat(64)}`;
  await page.route('**/care?**', route => route.fulfill({ json: { credentials: [], accessRequests: [], roles: [], jobs: [{ id: jobId, kind: 'REVIEW', summary: 'Verification fixture', state: 'COMPLETED', environment: 'STAGING', agents: [], createdAt: new Date().toISOString() }], capabilities: {} } }));
  await page.route('**/verification-options', route => route.fulfill({ json: { enabled, policy: 'offline-verification-v1', imageDigest, sources: [source], baselines: [], history: calls ? [{ id: runId, toolId: 'T35', state: 'COMPLETED', errorCode: null, createdAt: new Date().toISOString() }] : [], nextCursor: null } }));
  await page.route(`**/verification-runs/${runId}`, route => route.fulfill({ json: { id: runId, state: 'COMPLETED', errorCode: null, result: { outcome: 'FAILED', checks: [{ name: 'expected-total', passed: false }], limitations: ['Only the supplied offline fixture was checked.'] } } }));
  await page.route('**/verification-runs', route => { calls++; expect(route.request().postDataJSON()).toEqual({ requestKey: expect.any(String), toolId: 'T35', revisionId: source.revisionId, artifactId: source.artifactId, sourceDigest: source.sourceDigest, imageDigest, authorizeVerification: true, syntheticDataOnly: true }); return route.fulfill({ status: 201, json: { runId, state: 'COMPLETED' } }); });
  await page.goto(`/customer/websites/${id}`); await page.getByLabel('Environment', { exact: true }).selectOption('STAGING'); await page.getByText('Isolated verification tools · 11 profiles', { exact: true }).click();
  const run = page.getByRole('button', { name: 'Run approved verification', exact: true }); const consent = page.getByLabel('I authorize this exact saved-source check', { exact: false });
  await expect(run).toBeDisabled(); await page.getByLabel('Saved source version', { exact: true }).selectOption(source.artifactId); await consent.check();
  await page.getByLabel('Verification profile').selectOption('T36'); await expect(consent).not.toBeChecked(); await expect(run).toBeDisabled();
  await page.getByLabel('Verification profile').selectOption('T35'); await consent.check();
  const accessibility = await new AxeBuilder({ page }).include('[aria-label="Isolated source verification"]').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze(); expect(accessibility.violations).toEqual([]);
  await run.click(); await expect(page.getByText('Result: FAILED', { exact: true })).toBeVisible(); await expect(page.getByText('Failed · expected-total', { exact: true })).toBeVisible(); expect(calls).toBe(1);
  enabled = false; await page.reload(); await page.getByLabel('Environment', { exact: true }).selectOption('STAGING'); await page.getByText('Isolated verification tools · 11 profiles', { exact: true }).click(); await expect(run).toBeDisabled();
  await page.getByRole('button', { name: /^T35 · COMPLETED/ }).click(); await expect(page.getByText('Result: FAILED', { exact: true })).toBeVisible(); expect(calls).toBe(1);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Download retained verification result' }).click(); expect((await download).suggestedFilename()).toBe(`verification-${runId}.json`);
});
