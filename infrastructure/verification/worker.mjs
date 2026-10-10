/** Trusted harness. Execute customer inputs ONLY inside the rootless, offline runner image. */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdir, readFile, writeFile, copyFile, rm, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const policy = 'offline-verification-v1';
const ids = ['T35','T36','T37','T39','T40','T41','T42','T43','T44','T46','T48'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (code) => { throw new Error(code); };
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const same = (left, right) => canonical(left) === canonical(right);
const safePath = (path) => typeof path === 'string' && path.length <= 180 && /^[A-Za-z0-9_@./-]+$/.test(path) && path.split('/').every((part) => part && part !== '.' && part !== '..') && !path.split('/').some((part) => ['node_modules', '.git'].includes(part));
function checkFiles(files) {
  if (!Array.isArray(files) || !files.length || files.length > 30 || Buffer.byteLength(JSON.stringify(files)) > 250000) fail('SOURCE_LIMIT');
  const paths = new Set();
  for (const file of files) {
    if (!safePath(file.path) || typeof file.content !== 'string' || paths.has(file.path.toLowerCase())) fail('SOURCE_PATH_INVALID');
    paths.add(file.path.toLowerCase());
  }
  return files;
}
const content = (files, path) => files.find((file) => file.path === path)?.content ?? fail('PROFILE_FILE_REQUIRED');
const json = (files, path) => JSON.parse(content(files, path));
async function materialize(files, root) {
  await mkdir(root, { recursive: true });
  for (const file of files) { const path = join(root, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.content, { flag: 'wx', mode: 0o600 }); }
}
const childEnvironment = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp', LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' };
function childProcess(args, cwd, extraEnv = {}) {
  const child = spawn(process.execPath, args, { cwd, env: { ...childEnvironment, ...extraEnv }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let size = 0; let output = ''; let oversized = false;
  const stop = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
  child.stdout.on('data', (data) => { size += data.length; if (size <= 64000) output += data; else { oversized = true; stop(); } });
  child.stderr.on('data', (data) => { size += data.length; if (size > 64000) { oversized = true; stop(); } });
  const done = new Promise((resolve) => { child.once('error', () => resolve({ exitCode: -1, output: '', oversized })); child.once('exit', (code) => resolve({ exitCode: code ?? -1, output, oversized })); });
  return { child, done, stop };
}
async function runTests(root, path) {
  const child = childProcess(['--test', '--test-reporter=tap', '--test-timeout=10000', path], root);
  const timer = setTimeout(child.stop, 12000);
  try {
    const result = await child.done;
    const registered = [...result.output.matchAll(/^# Subtest: (.+)$/gm)].some((match) => ![path, join(root, path)].includes(match[1]));
    const tests = Number(/^# tests (\d+)$/m.exec(result.output)?.[1] ?? 0);
    const passed = Number(/^# pass (\d+)$/m.exec(result.output)?.[1] ?? 0);
    const skipped = Number(/^# skipped (\d+)$/m.exec(result.output)?.[1] ?? 0);
    const todo = Number(/^# todo (\d+)$/m.exec(result.output)?.[1] ?? 0);
    return { outcome: result.exitCode === 0 && registered && tests > 0 && passed === tests && skipped === 0 && todo === 0 && !result.oversized ? 'PASSED' : 'FAILED', checks: [{ name: 'node-test-summary', passed: result.exitCode === 0 && registered && passed > 0 }], metrics: { tests, passed, skipped, todo, exitCode: result.exitCode, outputTruncated: result.oversized }, limitations: ['Test counts are emitted by the supplied test process and are not independent proof of coverage. Raw logs are not retained.'] };
  } finally { clearTimeout(timer); child.stop(); }
}
async function build(files, root, work) {
  const ts = (await import('typescript')).default;
  if (ts.version !== '5.9.3') fail('COMPILER_VERSION_INVALID');
  const roots = files.filter((file) => /\.ts$/.test(file.path) && !file.path.startsWith('test/')).map((file) => join(root, file.path));
  if (!roots.length) fail('PROFILE_FILE_REQUIRED');
  const outDir = join(work, 'build');
  const program = ts.createProgram(roots, { strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, moduleResolution: ts.ModuleResolutionKind.Bundler, rootDir: root, outDir, types: [], noEmitOnError: true, declaration: true, sourceMap: false, skipLibCheck: false, incremental: false });
  const diagnostics = ts.getPreEmitDiagnostics(program); const emitted = program.emit();
  const outputs = [];
  async function walk(dir, prefix = '') { for (const name of (await readdir(dir)).sort()) { const path = join(dir, name); if ((await stat(path)).isDirectory()) await walk(path, `${prefix}${name}/`); else { const bytes = await readFile(path); outputs.push({ path: `${prefix}${name}`, bytes: bytes.length, sha256: hash(bytes) }); } } }
  if (!emitted.emitSkipped) await walk(outDir);
  return { outcome: diagnostics.length || emitted.emitSkipped || !outputs.length ? 'FAILED' : 'PASSED', checks: [{ name: 'strict-typescript-build', passed: !diagnostics.length && !emitted.emitSkipped && outputs.length > 0 }], metrics: { compiler: ts.version, emittedFiles: outputs, diagnostics: diagnostics.slice(0, 100).map((item) => ({ code: item.code, category: item.category })) }, limitations: ['Only supplied .ts files and compiler standard libraries are supported. No dependency installation or project scripts. This run records build hashes, not a deployment artifact.'] };
}
async function startServer(root, extraEnv = {}) {
  const child = childProcess(['app/server.mjs'], root, { HOST: '127.0.0.1', PORT: '18765', PAYMENTS_URL: 'http://127.0.0.1:18766', ...extraEnv });
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      const ready = await new Promise((resolve) => { const socket = connect({ host: '127.0.0.1', port: 18765 }); socket.setTimeout(50); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); socket.once('timeout', () => { socket.destroy(); resolve(false); }); });
      if (ready) return child;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    fail('FIXTURE_SERVER_NOT_READY');
  } catch (error) { child.stop(); await child.done; throw error; }
}
async function request(path, method = 'GET', body) {
  if (!/^\/[A-Za-z0-9/_-]*$/.test(path) || !['GET','POST'].includes(method)) fail('FIXTURE_ROUTE_INVALID');
  const response = await fetch(`http://127.0.0.1:18765${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(1000), headers: { 'content-type': 'application/json', connection: 'close' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const chunks = []; let size = 0; const reader = response.body.getReader();
  try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 32000) fail('FIXTURE_RESPONSE_LIMIT'); chunks.push(value); } }
  finally { await reader.cancel(); }
  const text = Buffer.concat(chunks).toString('utf8');
  let decoded; try { decoded = JSON.parse(text); } catch { decoded = null; }
  return { status: response.status, json: decoded };
}
function apiCases(files) {
  const cases = json(files, 'care/api.json');
  if (!Array.isArray(cases) || !cases.length || cases.length > 10) fail('FIXTURE_INVALID');
  for (const item of cases) if (!same(Object.keys(item).sort(), Object.keys(item).filter((key) => ['path','method','body','status','json'].includes(key)).sort()) || !/^\/[A-Za-z0-9/_-]*$/.test(item.path) || !['GET','POST'].includes(item.method) || !Number.isInteger(item.status) || item.status < 100 || item.status > 599 || !Object.hasOwn(item, 'json') || (item.method === 'GET' && item.body !== undefined)) fail('FIXTURE_INVALID');
  return cases;
}
async function apiChecks(files, root) {
  const cases = apiCases(files); const child = await startServer(root);
  try { const checks = []; for (const [index, item] of cases.entries()) { const actual = await request(item.path, item.method, item.body); checks.push({ name: `api-case-${index + 1}`, passed: same(actual, { status: item.status, json: item.json }) }); } return { checks, outcome: checks.every((item) => item.passed) ? 'PASSED' : 'FAILED' }; }
  finally { child.stop(); await child.done; }
}
async function performanceChecks(files, baseline, root, work) {
  if (!baseline || !same(json(files, 'care/performance.json'), json(baseline, 'care/performance.json'))) fail('BASELINE_PROFILE_MISMATCH');
  const paths = json(files, 'care/performance.json');
  if (!Array.isArray(paths) || !paths.length || paths.length > 3 || paths.some((path) => !/^\/[A-Za-z0-9/_-]*$/.test(path)) || new Set(paths).size !== paths.length) fail('FIXTURE_INVALID');
  const baselineRoot = join(work, 'baseline'); await materialize(baseline, baselineRoot);
  async function measure(dir) {
    const server = await startServer(dir);
    try {
      const values = [];
      for (const path of paths) {
        const times = [];
        for (let i = 0; i < 23; i++) { const start = performance.now(); const result = await request(path); if (result.status !== 200) fail('PERFORMANCE_RESPONSE_INVALID'); if (i >= 3) times.push(performance.now() - start); }
        times.sort((a, b) => a - b); values.push({ path, meanMs: times.reduce((a,b) => a+b, 0) / 20, p95Ms: times[18], samples: 20 });
      }
      return values;
    } finally { server.stop(); await server.done; }
  }
  const before = await measure(baselineRoot); const after = await measure(root);
  return { outcome: 'OBSERVED', checks: [{ name: 'identical-profile-completed', passed: true }], metrics: { baseline: before, candidate: after, deltas: after.map((value, index) => ({ path: value.path, meanPercent: (value.meanMs / before[index].meanMs - 1) * 100, p95Percent: (value.p95Ms / before[index].p95Ms - 1) * 100 })) }, limitations: ['One sequential baseline/candidate experiment; host noise and ordering affect measurements. No statistical confidence, regression gate or production performance claim.'] };
}
const version = (value) => { if (typeof value !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/.test(value)) fail('WORDPRESS_VERSION_INVALID'); return value.split('.').map(Number); };
const atLeast = (actual, minimum) => { const a = version(actual), b = version(minimum); for (let i=0;i<3;i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); } return true; };
const wpVersion = (files) => { const result = /\$wp_version\s*=\s*['"]([0-9.]+)['"]\s*;/.exec(content(files, 'wp-includes/version.php'))?.[1]; version(result); return result; };
function inventory(files) {
  const declarations = [];
  for (const file of files) {
    const plugin = /^wp-content\/plugins\/[^/]+\/[^/]+\.php$/.test(file.path); const theme = /^wp-content\/themes\/[^/]+\/style\.css$/.test(file.path);
    if (!plugin && !theme) continue;
    const header = file.content.slice(0, 8192); const field = (key) => new RegExp(`^[ \\t/*#@]*${key}:[ \\t]*(.{1,160})$`, 'im').exec(header)?.[1]?.trim() ?? null;
    const name = field(plugin ? 'Plugin Name' : 'Theme Name');
    if (name) declarations.push({ path: file.path, kind: plugin ? 'PLUGIN' : 'THEME', name, version: field('Version'), requiresPhp: field('Requires PHP'), requiresWordPress: field('Requires at least') });
  }
  return { outcome: 'OBSERVED', checks: [{ name: 'wordpress-version-declaration', passed: true }], metrics: { coreVersion: wpVersion(files), declarations }, limitations: ['Saved file declarations only. Activation status, completeness, authenticity and deployed versions are not established.'] };
}
async function trustedReference(path) {
  let bytes; try { bytes = await readFile(path); } catch { fail('TRUSTED_REFERENCE_REQUIRED'); }
  if (bytes.length > 20000000) fail('TRUSTED_REFERENCE_INVALID');
  const data = JSON.parse(bytes);
  if (data.schema !== 1 || data.reviewedByOperator !== true || !/^https:\/\/wordpress\.org\/wordpress-[0-9.]+\.zip$/.test(data.provenance?.url) || !/^[a-f0-9]{64}$/.test(data.provenance?.archiveSha256) || !Array.isArray(data.files) || !data.files.length || data.files.length > 3000) fail('TRUSTED_REFERENCE_INVALID');
  version(data.wordpressVersion); version(data.phpMinimum);
  if (data.provenance.url !== `https://wordpress.org/wordpress-${data.wordpressVersion}.zip` || wpVersion(data.files) !== data.wordpressVersion) fail('TRUSTED_REFERENCE_INVALID');
  const seen = new Set();
  for (const file of data.files) { if (!safePath(file.path) || file.path.startsWith('wp-content/') || typeof file.content !== 'string' || seen.has(file.path.toLowerCase()) || hash(file.content) !== file.sha256) fail('TRUSTED_REFERENCE_INVALID'); seen.add(file.path.toLowerCase()); }
  return { ...data, referenceDigest: hash(bytes) };
}
async function wordpress(toolId, files, referencePath, work) {
  if (toolId === 'T41') return inventory(files);
  const reference = await trustedReference(referencePath);
  const core = files.filter((file) => !file.path.startsWith('care/'));
  if (!core.length || core.some((file) => !reference.files.some((trusted) => trusted.path === file.path))) fail('WORDPRESS_SCOPE_UNSUPPORTED');
  const current = wpVersion(core);
  const provenance = { ...reference.provenance, referenceDigest: reference.referenceDigest, trust: reference.synthetic === true ? 'SYNTHETIC_TEST_REFERENCE' : 'OPERATOR_REVIEWED_IMMUTABLE_IMAGE', currentVersion: current, referenceVersion: reference.wordpressVersion };
  if (toolId === 'T42') {
    if (current !== reference.wordpressVersion) fail('WORDPRESS_REFERENCE_VERSION_MISMATCH');
    const checks = core.map((file) => ({ name: file.path, passed: hash(file.content) === reference.files.find((trusted) => trusted.path === file.path).sha256 }));
    return { outcome: checks.every((item) => item.passed) ? 'PASSED' : 'FAILED', checks, metrics: provenance, limitations: ['Only the selected normalized UTF-8 core files were compared. Missing files, plugins, themes, binary files and the live site are not verified.'] };
  }
  const approval = json(files, 'care/wordpress.json');
  if (!same(Object.keys(approval).sort(), ['approveCoreSubset','phpVersion','targetVersion']) || approval.approveCoreSubset !== true || approval.targetVersion !== reference.wordpressVersion || current === reference.wordpressVersion || !atLeast(reference.wordpressVersion, current)) fail('WORDPRESS_UPDATE_SCOPE_INVALID');
  if (!atLeast(approval.phpVersion, reference.phpMinimum)) fail('WORDPRESS_PHP_INCOMPATIBLE');
  const candidateFiles = core.map((file) => ({ path: file.path, content: reference.files.find((trusted) => trusted.path === file.path).content }));
  const restore = join(work, 'restore'); await materialize(core, restore);
  for (const file of candidateFiles) await writeFile(join(restore, file.path), file.content);
  for (const file of core) await writeFile(join(restore, file.path), file.content);
  for (const file of core) if (hash(await readFile(join(restore, file.path))) !== hash(file.content)) fail('WORDPRESS_RECOVERY_FAILED');
  return { outcome: 'PREPARED', checks: [{ name: 'declared-php-version-compatible', passed: true }, { name: 'exact-snapshot-file-restore', passed: true }], metrics: { ...provenance, declaredPhpVersion: approval.phpVersion, phpMinimum: reference.phpMinimum, changes: candidateFiles.map((file) => ({ path: file.path, before: hash(content(core, file.path)), after: hash(file.content) })) }, candidateFiles, limitations: ['A partial core-file candidate, not an installable full WordPress update. PHP and database compatibility, complete packages, live backups and restore drills require separate verification. Nothing was installed.'] };
}
async function databaseChecks(files, work) {
  const { DatabaseSync } = await import('node:sqlite');
  const assertions = json(files, 'care/database.json');
  if (!same(Object.keys(assertions).sort(), ['after', 'before'])) fail('DATABASE_FIXTURE_INVALID');
  for (const list of [assertions.before, assertions.after]) if (!Array.isArray(list) || !list.length || list.length > 10 || list.some((item) => typeof item.query !== 'string' || item.query.length > 2000 || !/^SELECT\s/i.test(item.query) || !Array.isArray(item.rows) || item.rows.length > 20 || !same(Object.keys(item).sort(), ['query','rows']))) fail('DATABASE_FIXTURE_INVALID');
  const path = join(work, 'fixture.sqlite'); const backupPath = join(work, 'backup.sqlite');
  const open = () => new DatabaseSync(path, { allowExtension: false });
  let db = open();
  const assertionsMatch = (list) => list.every((item) => { const rows = db.prepare(item.query).all(); return rows.length <= 20 && same(rows, item.rows); });
  try {
    db.exec(content(files, 'database/setup.sql')); db.exec(content(files, 'database/seed.sql'));
    if (!assertionsMatch(assertions.before)) fail('DATABASE_BASELINE_FAILED');
    db.close(); await copyFile(path, backupPath); const beforeHash = hash(await readFile(path));
    let migrationPassed = false;
    db = open(); try { db.exec(content(files, 'database/migrate.sql')); migrationPassed = assertionsMatch(assertions.after); } catch { migrationPassed = false; }
    db.close(); await copyFile(backupPath, path); const bytesRestored = hash(await readFile(path)) === beforeHash; db = open(); const restored = bytesRestored && assertionsMatch(assertions.before);
    return { outcome: migrationPassed && restored ? 'PASSED' : 'FAILED', checks: [{ name: 'before-migration-assertions', passed: true }, { name: 'after-migration-assertions', passed: migrationPassed }, { name: 'backup-byte-and-row-restoration', passed: restored }], metrics: { engine: 'SQLite', sqliteVersion: db.prepare('SELECT sqlite_version() AS version').get().version, beforeHash }, limitations: ['Synthetic fixtures only; restoring a file backup is not a reversible SQL migration or a production restore drill. No other database dialect is certified.'] };
  } finally { try { db.close(); } catch { /* Already closed. */ } }
}
async function commerceChecks(root, toolId) {
  let charges = 0; let balanceCalls = 0; let malformed = false; const intents = new Map();
  const mock = createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    try {
      if (req.method === 'GET' && req.url === '/v1/balance') { balanceCalls++; if (malformed) { res.end('{malformed'); return; } if (balanceCalls === 1) { res.statusCode = 429; res.setHeader('retry-after', '0'); res.end(JSON.stringify({ error: { code: 'rate_limit' } })); return; } res.end(JSON.stringify({ object: 'balance', livemode: false, available: [{ amount: 1200, currency: 'usd' }] })); return; }
      if (req.method !== 'POST' || req.url !== '/v1/payment_intents') { res.statusCode = 404; res.end('{}'); return; }
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 8192) throw new Error('limit'); }
      const input = JSON.parse(body); const key = req.headers['idempotency-key'];
      if (input.amount !== 1200 || input.currency !== 'usd' || typeof key !== 'string' || !['fixture-success','fixture-decline'].includes(key)) { res.statusCode = 400; res.end('{}'); return; }
      if (input.payment_method === 'fixture_declined') { res.statusCode = 402; res.end(JSON.stringify({ error: { code: 'card_declined' } })); return; }
      if (input.payment_method !== 'fixture_ok') { res.statusCode = 400; res.end('{}'); return; }
      if (!intents.has(key)) { charges++; intents.set(key, { id: 'pi_fixture', status: 'succeeded', amount: 1200, currency: 'usd', livemode: false }); }
      res.end(JSON.stringify(intents.get(key)));
    } catch { res.statusCode = 400; res.end('{}'); }
  });
  await new Promise((resolve, reject) => { mock.once('error', reject); mock.listen(18766, '127.0.0.1', resolve); });
  let child;
  try {
    child = await startServer(root); const checks = [];
    if (toolId === 'T44') {
      const input = { cart: [{ sku: 'fixture-item', quantity: 2, unitAmount: 600 }], paymentToken: 'fixture_ok', idempotencyKey: 'fixture-success' };
      const first = await request('/checkout', 'POST', input); const second = await request('/checkout', 'POST', input);
      const decline = await request('/checkout', 'POST', { ...input, paymentToken: 'fixture_declined', idempotencyKey: 'fixture-decline' });
      checks.push({ name: 'successful-checkout', passed: first.status === 200 && first.json?.status === 'paid' && first.json?.total === 1200 && typeof first.json?.orderId === 'string' }, { name: 'duplicate-is-idempotent', passed: second.status === 200 && same(first.json, second.json) && charges === 1 }, { name: 'decline-is-not-paid', passed: decline.status === 402 && decline.json?.status === 'declined' });
    } else {
      const retry = await request('/integration/balance'); malformed = true; const invalid = await request('/integration/balance');
      checks.push({ name: 'throttle-retry-and-balance', passed: retry.status === 200 && same(retry.json, { amount: 1200, currency: 'usd', testMode: true }) && balanceCalls >= 3 && balanceCalls <= 5 }, { name: 'malformed-provider-response', passed: invalid.status === 502 && same(invalid.json, { error: 'provider_invalid' }) });
    }
    return { outcome: checks.every((item) => item.passed) ? 'PASSED' : 'FAILED', checks, metrics: { provider: 'REGISTERED_OFFLINE_PAYMENT_MOCK_V1', charges, balanceCalls }, limitations: ['This mock tests the documented fixture contract only. It does not emulate all Stripe behavior or certify a live commerce/CMS integration.'] };
  } finally { if (child) { child.stop(); await child.done; } mock.closeAllConnections(); await new Promise((resolve) => mock.close(resolve)); }
}
export async function runProfile(input, { work, referencePath = '/opt/runner/trusted-wordpress.json' }) {
  if (input.policy !== policy || !ids.includes(input.toolId)) fail('PROFILE_INVALID');
  const files = checkFiles(input.files); if (input.baseline) checkFiles(input.baseline);
  if (Boolean(input.baseline) !== (input.toolId === 'T40')) fail('BASELINE_SELECTION_INVALID');
  const root = join(work, 'project'); await materialize(files, root);
  let result;
  try {
    switch (input.toolId) {
      case 'T35': content(files, 'test/unit.test.mjs'); result = await runTests(root, 'test/unit.test.mjs'); break;
      case 'T36': content(files, 'test/integration.test.mjs'); result = await runTests(root, 'test/integration.test.mjs'); break;
      case 'T37': result = await build(files, root, work); break;
      case 'T39': content(files, 'app/server.mjs'); result = await apiChecks(files, root); break;
      case 'T40': content(files, 'app/server.mjs'); content(input.baseline, 'app/server.mjs'); result = await performanceChecks(files, input.baseline, root, work); break;
      case 'T41': case 'T42': case 'T43': result = await wordpress(input.toolId, files, referencePath, work); break;
      case 'T44': case 'T48': content(files, 'app/server.mjs'); result = await commerceChecks(root, input.toolId); break;
      case 'T46': result = await databaseChecks(files, work); break;
    }
    return { policy, toolId: input.toolId, nodeVersion: process.version, ...result, limitations: [...(result.limitations ?? []), 'Offline supplied-source fixture evidence only. No live system, production safety or full application correctness is certified.'] };
  } finally { await rm(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = ''; const deadline = setTimeout(() => process.exit(124), 45000);
  try {
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 550000) fail('INPUT_LIMIT'); }
    const result = await runProfile(JSON.parse(input), { work: '/work' });
    const output = JSON.stringify(result); if (Buffer.byteLength(output) > 500000) fail('OUTPUT_LIMIT');
    process.stdout.write(output);
  } catch (error) { process.stdout.write(JSON.stringify({ error: /^[A-Z_]+$/.test(error.message) ? error.message : 'PROFILE_FAILED' })); process.exitCode = 1; }
  finally { clearTimeout(deadline); }
}
