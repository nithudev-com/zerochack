"""Apply this reviewed source increment only to its exact baseline files."""
from pathlib import Path
import hashlib

updates = []
def change(name, expected, edits, result):
    path = Path(name)
    text = path.read_text(encoding='utf-8')
    if hashlib.sha256(text.encode()).hexdigest() != expected:
        raise RuntimeError('Baseline changed: ' + name)
    for start, end, replacement in reversed(edits):
        text = text[:start] + replacement + text[end:]
    if hashlib.sha256(text.encode()).hexdigest() != result:
        raise RuntimeError('Patch integrity failed: ' + name)
    updates.append((path, text))

change('.env.example', 'b9b54760406f3e2132a53d35096eaf1913e9af805f4647a1c72045108e489bd1', [
    (869, 869, r'''# Separately opt in to explicit website observations / package metadata sharing.
CARE_OBSERVATIONS_ENABLED=false
CARE_ADVISORIES_ENABLED=false
''' ),
], '207726f7e58eabe7a8cad8c5e9068656f843929975903b69fba09d5326976361')

change('apps/api/src/app.ts', '9c8c2534cb61f30534a42990201b80ddd8c7e4a70c1db433a9e6250c9373ce81', [
    (852, 852, r'''type { ObservationAdapters } from './modules/care/external-observations.js';
import ''' ),
    (1903, 1903, r'''; careObservations?: ObservationAdapters''' ),
    (7282, 7282, r''', ...(dependencies?.careObservations ? { observationAdapters: dependencies.careObservations } : {})''' ),
], '93ea05fd89ee9640c0386a40deabd98b647586bbaabb01e7db960d118d4e4d61')

change('apps/api/src/modules/care/routes.ts', 'c825244b1ddc7813bfc2ef4be19777278bb9f790dc4c0d6ec2da79f57c5e8d23', [
    (618, 618, r'''s.js';
import { careObservationRoutes } from './observation-routes.js';
import type { ObservationAdapters } from './external-observation''' ),
    (1785, 1785, r'''; observationAdapters?: ObservationAdapters''' ),
    (2349, 2349, r''' });
  await app.register(careObservationRoutes, { environment: options.environment, ...(options.observationAdapters ? { adapters: options.observationAdapters } : {})''' ),
    (3219, 3238, r'''...scope''' ),
    (3363, 3363, r''', ...(environment ? { credential: { environment } } : {})''' ),
    (21992, 21992, r'''ED' : tool.id === 'T20' ? options.environment.CARE_ADVISORIES_ENABLED ? 'EXPLICIT_PACKAGE_CONSENT_REQUIRED' : 'DISABLED' : ['T23','T24'].includes(tool.id) ? options.environment.CARE_OBSERVATIONS_ENABLED ? 'VERIFIED_TARGET_AND_CONSENT_REQUIRED' : 'DISABL''' ),
], '01b4a17b24c68e08d6d8ac0f270098f76e36f7cea2ecbe8204c2e0f32232bc65')

change('apps/api/src/scripts/care-preflight.ts', '84dae030304ac1679483fc56f7845df1618d0638a16097b61245e313190601d4', [
    (2366, 2366, r'''observationTable = await database.$queryRaw<Array<{ relation: string | null }>>`SELECT to_regclass('public.care_tool_observations')::text AS relation`;
  checks.push({ name: 'observation_schema', state: observationTable[0]?.relation ? 'PASS' : 'BLOCKED', detail: 'Apply migration 20260928000000_care_observations before enabling approved external observations.' });
  checks.push({ name: 'external_observation_activation', state: 'NOT_VERIFIED', detail: `Website observations flag: ${env.CARE_OBSERVATIONS_ENABLED}; advisory flag: ${env.CARE_ADVISORIES_ENABLED}. Each call still needs customer consent; this preflight makes no live request.` });
  const ''' ),
], 'cb30859840233466ffd22880c1b25eb6327f1ef405090193fdb877f11334698d')

change('apps/web/care-e2e/chat.spec.ts', 'a223ac34205975d8326cef72fdfea821b96fb2f4671deffde5588ee9bbe80e8b', [
    (33905, 33905, r'''
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
''' ),
], '11433ade5b96f3b9a46b9acfe165c823fee14a43cc14bfff8ec8fcde3dfdaa9e')

change('apps/web/care-e2e/home.spec.ts', 'e2740092f7c752e6bf2b0a082e10cb62b0cfb2baee492362824b998c9ab47d27', [
    (2050, 2052, r'''52''' ),
], 'b1ed98583600f948b1aa9528b10572c16686253996df07fd6ead5bfcd4d2508f')

change('apps/web/components/care-tools.tsx', '155629163bd3346423df33f6234cca5699e4f6765b0523080d4455d1a055fd3e', [
    (101, 101, r'''';
import { CareObservations } from './care-observations''' ),
    (2037, 2037, r'''<><CareObservations key={jobId} jobId={jobId} websiteId={websiteId}/>''' ),
    (4563, 4563, r'''</>''' ),
], '31ee916680858505684133f7c1863f9e5f778bd1081304dff276e3e2e6a1b2d9')

change('docs/CARE-IMPLEMENTATION.md', 'ede6b47c742e1b55bdd90b884a4220556f2bda8b58c3e143cde361fc978bbbe8', [
    (989, 989, r'''Consented observation increment

The current registry has 52 bounded implementations/workflow bindings and 15 unavailable contracts. T20 uses explicit selected-package disclosure consent for the fixed OSV service; T23/T24 make one scoped unauthenticated observation of the verified production website. Source declarations now support exact npm lockfile and Composer coordinates. Credential and specialist-grant metadata follow the selected Care environment. New observations have separate default-off flags, durable consent/result/error records, idempotent retries and post-operation authorization rechecks. See [CARE-OBSERVATIONS.md](CARE-OBSERVATIONS.md). These additions do not provide general autonomous repair or complete the 100-item plan. Dated test totals below describe previous increments, not this change.

## ''' ),
    (5347, 5349, r'''52''' ),
    (5394, 5396, r'''15''' ),
    (13764, 13766, r'''15''' ),
], '16b0816ebe1a0448784e70e1f9e6a40568147d47470db1f4765ce229e267ce90')

change('docs/CARE-OPERATIONS.md', '1eb4eadc20c1ee5bacb6ea76e53941db5553df66ba1e70e6361985c4b4aa8a37', [
    (13015, 13015, r'''

## Explicit-consent advisory and website observations

Apply the additive `20260928000000_care_observations` migration with both new flags off. Keep API/web versions matched. `CARE_OBSERVATIONS_ENABLED=true` enables T23/T24 for verified production website bindings; `CARE_ADVISORIES_ENABLED=true` additionally requires source-review enablement and permits only explicitly selected exact dependency coordinates. Both require CARE_ENABLED and a persistent, distinct CARE_ARTIFACT_KEY. Existing encrypted history is preserved.

Neither flag grants an AI agent network access. Each external request requires a separate affirmative customer action in the job. An idempotency retry returns the prior operation; it never repeats its network call. A crashed call projects INTERRUPTED after its deadline and is not replayed. Inspect saved status before creating a new request. Network requests are unauthenticated and bounded to one root HEAD or verified TLS handshake; OSV receives only approved package coordinates. See [CARE-OBSERVATIONS.md](CARE-OBSERVATIONS.md).

Local fixture tests are not a live OSV availability check or proof that a particular hosting environment is reachable. Validate connectivity and policy on a disposable authorized target before rollout. No live customer server, credential or production data is needed for the new CI tests. The 15 wider unavailable tools still require implementation/evaluation.
''' ),
], 'a10ad3f79ef7a2fad5db4ca4f1cf5b4863bc1565962362b3b908dc50b103477f')

change('docs/CARE-TOOL-CONTRACTS.md', '882f82d5e5e8358edbb5002544b9b1e1de3577a6a12eae4f8d08affe70194b3b', [
    (87, 87, r'''52 have bounded implementations or dedicated workflow bindings; 15 remain unavailable.** The latest increment adds explicit-consent T20 advisory matching and T23/T24 registered-website HTTP/TLS observations to the previous ''' ),
    (89, 260, r'''''' ),
    (561, 562, r'''8''' ),
    (1110, 1121, r'''remains''' ),
    (1156, 1156, r'''. The observation increment adds no new third-party dependencies.

## Explicit-consent external observations

T20/T23/T24 use a separate human-approved workflow, not the generic tool dispatcher or AI loop. Open **Authorized website observations & advisory matching** in a job. Review the exact target or select exact packages''' ),
    (1161, 1171, r'''packages are preselected. Results, failures and idempotenc''' ),
    (1173, 1173, r'''records are retained. See [CARE-OBSERVATIONS.md](CARE-OBSERVATIONS.md) ''' ),
    (1174, 1193, r'''or all limits, flags, migration and live-evaluation requirements''' ),
    (9787, 9788, r'''5''' ),
    (14644, 14662, r'''Exact npm package.json versions, npm''' ),
    (14671, 14694, r''' v1–v3 entries, shrin''' ),
    (14695, 14696, r'''wrap and Composer lockfile entries. Ran''' ),
    (14698, 14707, r'''s, links and unsupported versions are explicitl''' ),
    (14708, 14708, r''' omitted. These are declarations, not deployed facts''' ),
    (14736, 14736, r'''; current source-review approval. |
| T20 | dependencies_match_advisories | Match 1–50 customer-selected exact npm/Packagist coordinates from approved manifests/lockfiles against the fixed OSV batch endpoint. IDs/modified timestamps only; incomplete pagination is explicit. Not installed-version or exploitability verification. | POST /jobs/:id/observations; separate package disclosure consent; CARE_ADVISORIES_ENABLED; exact source approval. |
| T21 | secrets_scan_local | Check authorized source for secrets; return redacted locations only. | POST /jobs/:id/tools/T21''' ),
    (14841, 14857, r'''2 | supplychain''' ),
    (14858, 14863, r'''inventory''' ),
    (14864, 14895, r'''image | Inventory top-level CycloneDX/SPDX JSO''' ),
    (14896, 14906, r''' declarations; no image extraction or''' ),
    (14916, 14924, r'''''' ),
    (14928, 15135, r'''''' ),
    (15162, 15163, r'''2''' ),
    (15268, 15276, r'''3 | http_check_configuration | One unauthenticated HEAD at the verified production website root, pinned to validated public DNS results; no redirects, bodies or cookies. Safe header-presence observations on''' ),
    (15278, 15392, r'''''' ),
    (15411, 15439, r'''observations; separate''' ),
    (15445, 15452, r'''''' ),
    (15453, 15468, r'''target consent''' ),
    (15475, 15475, r'''OBSE''' ),
    (15476, 15477, r'''''' ),
    (15478, 15478, r'''AT''' ),
    (15479, 15481, r'''ONS''' ),
    (15489, 15518, r'''.''' ),
    (15525, 15533, r'''4 | tls''' ),
    (15534, 15538, r'''get_summary | One certificate-validated TLS handsha''' ),
    (15539, 15543, r'''e to the veri''' ),
    (15545, 15587, r'''ed production''' ),
    (15592, 15594, r'''S host with original-hostname checks and pu''' ),
    (15595, 15627, r'''lic-IP pinning''' ),
    (15630, 15637, r'''o cipher enumeration or revocation-status validation. | POST /jobs/:id/observations; separate e''' ),
    (15638, 15650, r'''act-''' ),
    (15656, 15660, r''' consent; CARE_OBSERVATIO''' ),
    (15662, 15716, r'''_ENAB''' ),
    (15717, 15896, r'''ED''' ),
], '31b0a6d0633b8fcb5094c666f27b9c15fca36aee25ce901d5f1afc7f53da911e')

change('packages/care/src/care.test.ts', '774b2d8368081d7c8f0cdad93c32bf0147a237db4e73273815b2cc6edc4832ff', [
    (5246, 5248, r'''52''' ),
], 'c71968e575ad4d15c1b7b352eb8be547cabb77307f5017b9eaf04bea2616970a')

change('packages/care/src/defensive-checks.test.ts', '4d0cb8f47cbd07080b23b61d8dd536f50357985c07e81086243f545cc34d4ed4', [
    (7468, 7470, r'''52''' ),
    (7539, 7540, r'''5''' ),
], 'd2ba395a0eff2a5f563644349743ca2b3aeb74181ce771bdd6133e7ce9b579bd')

change('packages/care/src/index.ts', 'cc095fd1a85118730e41eccb4b78b627e5699706373e260d612b2cc82327ba64', [
    (418, 418, r'''export * from './dependency-inventory.js';
''' ),
], 'cfa10f5bd159c46906d17fe91b8ef0082351c96730415517c4b637de25659556')

change('packages/care/src/review-tools.ts', '6377a06183d9316acdb3e519b80bac11dedda99e6702cc1c312e51274e78e5b3', [
    (0, 0, r'''import { inventoryDependencies } from './dependency-inventory.js';
''' ),
    (5341, 5436, r'''invento''' ),
    (5438, 5614, r'''''' ),
    (5626, 6160, r'''(snapshot''' ),
], 'fd0043c33bed9a600067af5e23445d7ec8a2443468ec127c5471cbcee7e6f736')

change('packages/care/src/source-formats.ts', '41f929853b20ca69e629578b8be050005217f04b99191e0d0051b21c2bb17d7a', [
    (628, 628, r'''','composer.lock''' ),
], '2d1076e03e7bf0eb60fa253ac27fd0db4cecb0546a70fbdc1120bf88780e9259')

change('packages/care/src/source-review.test.ts', '02755419e1a7ea50aca644857c6ea2d0a14c061d1d0d44243c78b411b64cd939', [
    (6012, 6018, r'''MatchObject({ entries: ''' ),
    (6019, 6031, r'''], s''' ),
    (6032, 6096, r'''ipped: ''' ),
    (6097, 6102, r''', truncated: false''' ),
    (6104, 6179, r'''''' ),
], '72741d589610df9f8f6d914d2c9c7f6841f9aafb748bf4c13a2dfd3f531b4204')

change('packages/care/src/tool-support.ts', '013bc3f6dcaa9e59abe8cc26c1825a0cebd8b2727c5d9ec8a6928121a8ca0a9d', [
    (214, 214, r'''
  T20: { entrypoint: 'POST /jobs/:id/observations (T20)', boundary: 'Match explicitly selected exact npm/Composer snapshot versions against OSV; external package-metadata sharing requires separate consent. Not a deployed-version or exploitability claim.', requirements: ['CARE_ADVISORIES_ENABLED and CARE_REVIEW_ENABLED', 'Current exact source-review approval', 'Explicit selection and OSV disclosure consent', 'Retained encrypted result storage'] },
  T23: { entrypoint: 'POST /jobs/:id/observations (T23)', boundary: 'One unauthenticated HEAD request to the verified production website root; fixed ports, pinned public resolution, bounded headers, no redirects or cookies.', requirements: ['CARE_OBSERVATIONS_ENABLED', 'Verified production website binding', 'Explicit target-bound observation consent', 'Retained encrypted result storage'] },
  T24: { entrypoint: 'POST /jobs/:id/observations (T24)', boundary: 'One validated TLS handshake with original-hostname and certificate-chain checks; no cipher enumeration or application testing.', requirements: ['CARE_OBSERVATIONS_ENABLED', 'Verified HTTPS production website', 'Explicit target-bound observation consent', 'Retained encrypted result storage'] },''' ),
    (6589, 7039, r'''''' ),
], 'a0ecd685f7bd16ab68898cbf13b6870bbe99f3e7fcee1b11a3b5471f1bad1287')

change('packages/config/src/index.ts', '51f8c35695d4df1af0010d52bc08b3150bf6d184d4dde7ab476fc9fabd44e07a', [
    (411, 411, r'''_ENABLED: booleanString.default(false),
  CARE_OBSERVATIONS_ENABLED: booleanString.default(false),
  CARE_ADVISORIES''' ),
    (5956, 5956, r''' || result.data.CARE_OBSERVATIONS_ENABLED || result.data.CARE_ADVISORIES_ENABLED''' ),
    (6382, 6382, r'''');
  if ((result.data.CARE_OBSERVATIONS_ENABLED || result.data.CARE_ADVISORIES_ENABLED) && !result.data.CARE_ENABLED) throw new Error('Care observations require CARE_ENABLED.');
  if (result.data.CARE_ADVISORIES_ENABLED && !result.data.CARE_REVIEW_ENABLED) throw new Error('Advisory matching requires CARE_REVIEW_ENABLED.''' ),
], 'c4d535a8629f55162247b297aa53ef58db9d39ab2b003801949f5608c859b384')

change('packages/database/prisma/schema.prisma', 'fbb13357b4de487894045e95133e186bdb3f64bb76fac72dd113bf4322b0abcb', [
    (16472, 16472, r'''observations CareToolObservation[]
  ''' ),
    (104245, 104245, r'''
// Immutable consent/input binding; plaintext source/credentials are never stored here.
model CareToolObservation {
  id String @id @default(uuid()) @db.Uuid
  tenantId String @map("tenant_id") @db.Uuid
  websiteId String @map("website_id") @db.Uuid
  jobId String @map("job_id") @db.Uuid
  actorId String @map("actor_id") @db.Uuid
  requestKey String @map("request_key") @db.Uuid
  toolId String @map("tool_id") @db.VarChar(8)
  inputDigest String @map("input_digest") @db.Char(64)
  targetBinding String @map("target_binding") @db.Char(64)
  state String @db.VarChar(32)
  errorCode String? @map("error_code") @db.VarChar(100)
  resultArtifactId String? @map("result_artifact_id") @db.Uuid
  expiresAt DateTime @map("expires_at") @db.Timestamptz(6)
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  completedAt DateTime? @map("completed_at") @db.Timestamptz(6)
  job CareJob @relation(fields: [tenantId, websiteId, jobId], references: [tenantId, websiteId, id], onDelete: Cascade)
  @@unique([jobId, requestKey])
  @@index([tenantId, websiteId, state])
  @@map("care_tool_observations")
}
''' ),
], '5ba1f8ec7775b70ea6276c2d2b2676fbb80db31bef71630196132f50acd26ef6')

for path, text in updates:
    path.write_text(text, encoding='utf-8')
print(f'Applied {len(updates)} baseline-verified source updates.')
