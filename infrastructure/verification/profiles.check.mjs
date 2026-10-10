// Trusted, synthetic fixtures only. This host-side test is not the production adapter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runProfile, policy } from './worker.mjs';
const file = (path, content) => ({ path, content });
const json = (path, value) => file(path, JSON.stringify(value));
const server = file('app/server.mjs', await readFile(new URL('./fixtures/server.mjs', import.meta.url), 'utf8'));
const unit = [file('test/unit.test.mjs', "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { add } from '../app/math.mjs'; test('sum', () => assert.equal(add(2,3),5));"), file('app/math.mjs', 'export const add = (a,b) => a+b;')];
const integration = [file('test/integration.test.mjs', "import { test } from 'node:test'; import assert from 'node:assert/strict'; import { DatabaseSync } from 'node:sqlite'; test('sqlite transaction', () => { const db = new DatabaseSync(':memory:'); try { db.exec('CREATE TABLE items (id INTEGER); INSERT INTO items VALUES (3)'); assert.equal(db.prepare('SELECT id FROM items').get().id,3); } finally { db.close(); } });")];
const database = [file('database/setup.sql', 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL);'), file('database/seed.sql', "INSERT INTO items VALUES (1, 'synthetic');"), file('database/migrate.sql', 'ALTER TABLE items ADD COLUMN count INTEGER NOT NULL DEFAULT 0;'), json('care/database.json', { before: [{ query: 'SELECT id, name FROM items', rows: [{ id: 1, name: 'synthetic' }] }], after: [{ query: 'SELECT id, name, count FROM items', rows: [{ id: 1, name: 'synthetic', count: 0 }] }] })];
const core = [file('wp-includes/version.php', "<?php $wp_version = '6.1.0';"), file('wp-includes/example.php', '<?php function fixture() { return 1; }')];
async function run(toolId, files, extra = {}, reference = core) {
  if (process.env.CARE_PROFILE_TEST_IMAGE) {
    const image = reference ? process.env.CARE_PROFILE_TEST_IMAGE : process.env.CARE_PROFILE_TEST_BASE_IMAGE;
    assert.match(image, /^sha256:[a-f0-9]{64}$/);
    const response = await new Promise((resolve, reject) => {
      const child = spawn('docker', ['run','--rm','-i','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=65532:65532','--pids-limit=64','--memory=256m','--memory-swap=256m','--cpus=1','--tmpfs=/work:rw,nosuid,nodev,noexec,size=64m,mode=1777','--tmpfs=/tmp:rw,nosuid,nodev,noexec,size=16m,mode=1777',image], { stdio: ['pipe','pipe','pipe'] });
      let output = ''; let errors = ''; child.stdout.on('data', (bytes) => { output += bytes; }); child.stderr.on('data', (bytes) => { errors += bytes; });
      child.on('error', reject); child.on('close', () => { try { resolve(JSON.parse(output)); } catch { reject(new Error(errors || output)); } });
      child.stdin.end(JSON.stringify({ policy, toolId, files, ...extra }));
    });
    if (response.error) throw new Error(response.error);
    return response;
  }
  const work = await mkdtemp(join(tmpdir(), 'care-profile-'));
  const referencePath = join(work, 'trusted-wordpress.json');
  // Explicit synthetic reference: this tests the comparator, not authentic WordPress packages.
  if (reference) await writeFile(referencePath, JSON.stringify({ schema: 1, reviewedByOperator: true, synthetic: true, wordpressVersion: '6.1.0', phpMinimum: '7.4', provenance: { url: 'https://wordpress.org/wordpress-6.1.0.zip', archiveSha256: 'f'.repeat(64) }, files: reference.map((item) => ({ ...item, sha256: createHash('sha256').update(item.content).digest('hex') })) }));
  try { return await runProfile({ policy, toolId, files, ...extra }, { work, referencePath }); }
  finally { await rm(work, { recursive: true, force: true }); }
}
test('T35 executes customer module assertions and does not call an empty or skipped suite passing', async () => {
  assert.equal((await run('T35', unit)).outcome, 'PASSED');
  if (process.env.CARE_PROFILE_TEST_IMAGE) {
    const preflight = await readFile(new URL('../../apps/api/src/scripts/care-verification-preflight.ts', import.meta.url), 'utf8');
    const source = preflight.match(/content: `([\s\S]*?)` \}/)[1].replaceAll('\\\\', '\\');
    assert.equal((await run('T35', [file('test/unit.test.mjs', source)])).outcome, 'PASSED');
  }

  assert.equal((await run('T35', [file('test/unit.test.mjs', '// No registered tests')])).outcome, 'FAILED');
  assert.equal((await run('T35', [unit[0], file('app/math.mjs', 'export const add = () => 0;')])).outcome, 'FAILED');
  assert.equal((await run('T35', [file('test/unit.test.mjs', "import { test } from 'node:test'; test.skip('pending', () => {});")])).outcome, 'FAILED');
});
test('T36 executes a real disposable SQLite integration test', async () => { const result = await run('T36', integration); assert.equal(result.outcome, 'PASSED'); assert.equal(result.metrics.tests, 1); });
test('T37 emits repeatable JS/declaration hashes and rejects type errors', async () => {
  const source = [file('app/example.ts', 'export const count: number = 2;')]; const first = await run('T37', source); const second = await run('T37', source);
  assert.equal(first.outcome, 'PASSED'); assert.deepEqual(first.metrics.emittedFiles, second.metrics.emittedFiles); assert.equal(first.metrics.emittedFiles.length, 2);
  assert.equal((await run('T37', [file('app/example.ts', 'export const count: number = "wrong";')])).outcome, 'FAILED');
});
test('T39 starts the supplied HTTP server and compares explicit outcomes', async () => {
  assert.equal((await run('T39', [server, json('care/api.json', [{ path: '/health', method: 'GET', status: 200, json: { ok: true } }])])).outcome, 'PASSED');
  assert.equal((await run('T39', [server, json('care/api.json', [{ path: '/health', method: 'GET', status: 201, json: { ok: true } }])])).outcome, 'FAILED');
  await assert.rejects(run('T39', [server, json('care/api.json', [{ path: 'https://example.test', method: 'GET', status: 200, json: {} }])]), /FIXTURE_INVALID/);
});
test('T40 measures both selected snapshots with matching fixed profiles', async () => {
  const files = [server, json('care/performance.json', ['/health'])]; const result = await run('T40', files, { baseline: files });
  assert.equal(result.outcome, 'OBSERVED'); assert.equal(result.metrics.baseline[0].samples, 20); assert.equal(result.metrics.candidate[0].samples, 20); assert.ok(Number.isFinite(result.metrics.deltas[0].meanPercent));
  await assert.rejects(run('T40', files, { baseline: [server, json('care/performance.json', ['/different'])] }), /BASELINE_PROFILE_MISMATCH/);
});
test('T41 inventories WordPress declarations without executing PHP', async () => {
  const result = await run('T41', [...core, file('wp-content/plugins/example/example.php', '<?php\n/*\nPlugin Name: Example\nVersion: 1.2.3\nRequires PHP: 7.4\n*/'), file('wp-content/themes/example/style.css', '/*\nTheme Name: Example Theme\nVersion: 2.0\n*/')]);
  assert.equal(result.outcome, 'OBSERVED'); assert.equal(result.metrics.declarations.length, 2); assert.equal(result.metrics.declarations[0].version, '1.2.3');
});
test('T42 requires the image reference, version and actual file hashes', async () => {
  assert.equal((await run('T42', core)).outcome, 'PASSED');
  assert.equal((await run('T42', [core[0], file(core[1].path, '<?php changed();')])).outcome, 'FAILED');
  await assert.rejects(run('T42', core, {}, null), /TRUSTED_REFERENCE_REQUIRED/);
  await assert.rejects(run('T42', [file(core[0].path, "<?php $wp_version = '6.0.0';")]), /WORDPRESS_REFERENCE_VERSION_MISMATCH/);
});
test('T43 prepares the approved subset and verifies restoration without changing its input', async () => {
  const original = file(core[0].path, "<?php $wp_version = '6.0.0';"); const before = structuredClone(original);
  const result = await run('T43', [original, json('care/wordpress.json', { targetVersion: '6.1.0', phpVersion: '8.3', approveCoreSubset: true })]);
  assert.equal(result.outcome, 'PREPARED'); assert.deepEqual(result.candidateFiles, [core[0]]); assert.deepEqual(original, before); assert.ok(result.checks.every((item) => item.passed));
  await assert.rejects(run('T43', [original, json('care/wordpress.json', { targetVersion: '6.1.0', phpVersion: '5.6', approveCoreSubset: true })]), /WORDPRESS_PHP_INCOMPATIBLE/);
});
test('T44 runs success, idempotent duplicate and declined checkout against the fixed payment mock', async () => { const result = await run('T44', [server]); assert.equal(result.outcome, 'PASSED'); assert.equal(result.metrics.charges, 1); });
test('T46 runs real SQL, checks data preservation and restores a failed migration', async () => {
  assert.equal((await run('T46', database)).outcome, 'PASSED');
  const result = await run('T46', database.map((item) => item.path === 'database/migrate.sql' ? file(item.path, 'DROP TABLE items;') : item));
  assert.equal(result.outcome, 'FAILED'); assert.equal(result.checks.find((item) => item.name === 'backup-byte-and-row-restoration').passed, true);
});
test('T48 checks a real customer retry and malformed mock-provider error handling', async () => { const result = await run('T48', [server]); assert.equal(result.outcome, 'PASSED'); assert.equal(result.metrics.balanceCalls, 3); });
test('rejects invalid profiles, missing fixtures and ambiguous paths before execution', async () => {
  await assert.rejects(run('T00', unit), /PROFILE_INVALID/);
  await assert.rejects(run('T35', [file('../test/unit.test.mjs', 'bad')]), /SOURCE_PATH_INVALID/);
  await assert.rejects(run('T35', [file('app/math.mjs', 'export const x=1')]), /PROFILE_FILE_REQUIRED/);
  await assert.rejects(run('T35', [unit[0], { ...unit[0], path: 'TEST/unit.test.mjs' }]), /SOURCE_PATH_INVALID/);
});
