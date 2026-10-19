'use strict';
// Real disposable SSH integration, NOT executed by npm/unit tests or production startup.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { createHash, createHmac, randomUUID, timingSafeEqual } = require('node:crypto');
const { Client, utils } = require('ssh2');
const { canonical, run: verifyRecoveryCodec } = require('./recovery-codec.cjs');
const { createManagedTargetBroker, COMMAND, buildRecoveryExportPermitPayload } = require('./broker.cjs');
if (process.getuid() !== 0 || process.env.MANAGED_TARGET_DISPOSABLE_FIXTURE !== '1') throw new Error('FIXTURE_ONLY');
function privateFile(name, maximum = 16384) {
  const fd = fs.openSync(`/fixture-control/${name}`, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    assert.ok(info.isFile() && info.uid === 0 && info.gid === 0 && info.nlink === 1 && info.size <= maximum && (info.mode & 0o7777) === 0o400);
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
const identity = JSON.parse(privateFile('fixture.json'));
const privateKey = privateFile('client.key'); const permitKey = privateFile('permit.key');
const recoveryKey = privateFile('recovery.key', 32);
const binding = { scope: identity.scope, namespaceId: identity.namespaceId, targetId: identity.targetId };
const access = { address: 'managed-target-helper', port: 2222, username: 'codebandage-managed-target', hostKeyFingerprint: identity.fingerprint, privateKey };
async function disconnect(client) {
  await new Promise((resolve) => {
    let timer;
    const finish = () => { clearTimeout(timer); client.removeListener('close', finish); resolve(); };
    client.once('close', finish); timer = setTimeout(finish, 200);
    client.end(); client.destroy();
  });
}
async function fixtureConnect(selected = access) {
  // The only private-network exception is in this disposable test source, not the default broker.
  assert.equal(selected.address, 'managed-target-helper'); assert.equal(selected.port, 2222);
  const client = new Client();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.destroy(); reject(new Error('FIXTURE_CONNECT_TIMEOUT')); }, 5000);
      client.once('ready', () => { clearTimeout(timer); resolve(); });
      client.once('error', (error) => { clearTimeout(timer); reject(error); });
      client.connect({ host: selected.address, port: selected.port, username: selected.username, privateKey: selected.privateKey, readyTimeout: 4000,
        hostVerifier: (key) => {
          const actual = Buffer.from(`SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`);
          const expected = Buffer.from(selected.hostKeyFingerprint);
          return actual.length === expected.length && timingSafeEqual(actual, expected);
        } });
    });
    return client;
  } catch (error) { await disconnect(client); throw error; }
}
let authorityCalls = 0; let lastPermit; let expectedApproval;
async function authorizeAndIssuePermit(prepared) {
  authorityCalls += 1;
  // Fixture approval only. Production actor/session/lease/scope authority remains unregistered.
  assert.deepEqual(prepared.scope, expectedApproval.scope);
  for (const field of ['namespaceId','targetId','action','planDigest','authorityDigest','snapshotDigest']) assert.equal(prepared[field], expectedApproval[field]);
  const issuedAt = Date.now();
  assert.ok(issuedAt >= prepared.preparedAt);
  const payload = { version: 1, adapter: prepared.adapter, scope: prepared.scope, namespaceId: prepared.namespaceId, targetId: prepared.targetId,
    operationId: prepared.operationId, action: prepared.action, planDigest: prepared.planDigest, authorityDigest: prepared.authorityDigest,
    snapshotDigest: prepared.snapshotDigest, recoveryDigest: prepared.recoveryDigest, targetMode: prepared.targetMode, challenge: prepared.challenge,
    issuedAt, expiresAt: issuedAt + 10000 };
  lastPermit = { payload, mac: createHmac('sha256', permitKey).update(canonical(payload)).digest('hex') };
  return lastPermit;
}
let lastExportPermit;
async function authorizeAndIssueRecoveryExportPermit({ prepared, exportId }) {
  assert.deepEqual(prepared.scope, expectedApproval.scope);
  for (const field of ['namespaceId','targetId','action','planDigest','authorityDigest','snapshotDigest']) assert.equal(prepared[field], expectedApproval[field]);
  const issuedAt = Date.now();
  const payload = buildRecoveryExportPermitPayload(prepared, exportId, issuedAt, issuedAt + 10000);
  lastExportPermit = { payload, mac: createHmac('sha256', permitKey).update(canonical(payload)).digest('hex') };
  return lastExportPermit;
}
const broker = createManagedTargetBroker(access, { connectPinned: fixtureConnect, authorizeAndIssuePermit, authorizeAndIssueRecoveryExportPermit });
async function exportAndVerify(prepared) {
  const exportId = randomUUID();
  const result = await broker.exportRecovery(prepared, exportId);
  assert.equal(result.recoveryDigest, createHash('sha256').update(canonical(result.envelope)).digest('hex'));
  assert.deepEqual(result.before, prepared.before);
  assert.deepEqual(verifyRecoveryCodec('verify', { envelope: result.envelope, expectedAad: result.envelope.aad,
    expectedSnapshot: prepared.before }, recoveryKey), { verified: true, snapshotDigest: prepared.snapshotDigest, digest: prepared.before.digest });
  const replay = await raw({ version: 1, command: 'EXPORT_RECOVERY', ...binding, operationId: prepared.operationId, exportId, permit: lastExportPermit });
  assert.deepEqual(replay, { ok: false, errorCode: 'MANAGED_RECOVERY_EXPORT_REPLAY_REFUSED' });
  assert.deepEqual((await broker.observe(binding)).snapshot, prepared.before);
}
async function raw(request, execCommand = COMMAND) {
  const client = await fixtureConnect();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { client.destroy(); reject(new Error('FIXTURE_RAW_TIMEOUT')); }, 28000);
      client.exec(execCommand, (error, channel) => {
        if (error) { clearTimeout(timer); reject(error); return; }
        let output = ''; channel.on('data', (chunk) => { output += chunk.toString('utf8'); if (Buffer.byteLength(output) > 32768) client.destroy(); });
        channel.once('close', () => { clearTimeout(timer); try { resolve(JSON.parse(output)); } catch { reject(new Error('FIXTURE_RAW_INVALID')); } });
        channel.end(`${JSON.stringify(request)}\n`);
      });
    });
  } finally { await disconnect(client); }
}
async function channelRefused(start) {
  const client = await fixtureConnect();
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('FIXTURE_REFUSAL_TIMEOUT')), 4000);
      start(client, (error, channel) => {
        clearTimeout(timer); channel?.end?.();
        if (error) resolve(); else reject(new Error('UNEXPECTED_CHANNEL_AUTHORITY'));
      });
    });
  } finally { await disconnect(client); }
}
async function publication() {
  const response = await fetch('http://managed-target-publisher:8080/', { signal: AbortSignal.timeout(3000) });
  assert.equal(response.status, 200);
  return createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
}
async function prepare(action, observed, recoveryOperationId) {
  const input = { ...binding, operationId: randomUUID(), action, planDigest: createHash('sha256').update(`fixture-plan:${action}`).digest('hex'),
    authorityDigest: createHash('sha256').update(`fixture-authority:${action}`).digest('hex'), expectedSnapshot: observed.snapshot };
  if (recoveryOperationId) input.recoveryOperationId = recoveryOperationId;
  expectedApproval = { ...binding, action, planDigest: input.planDigest, authorityDigest: input.authorityDigest, snapshotDigest: observed.snapshotDigest };
  return broker.prepare(input);
}
async function main() {
  const proofResponse = await fetch('http://managed-target-publisher:8080/fixture-readonly-proof', { signal: AbortSignal.timeout(3000) });
  const proof = await proofResponse.json(); assert.notEqual(proof.uid, 0);
  assert.deepEqual(proof.proof, { write: 'EROFS', chmod: 'EROFS', rename: 'EROFS', hardlink: 'EROFS' });
  await assert.rejects(fixtureConnect({ ...access, hostKeyFingerprint: `SHA256:${'A'.repeat(43)}` }));
  await assert.rejects(fixtureConnect({ ...access, username: 'root' }));
  const wrongKey = Buffer.from(utils.generateKeyPairSync('ed25519').private);
  try { await assert.rejects(fixtureConnect({ ...access, privateKey: wrongKey })); } finally { wrongKey.fill(0); }
  await assert.rejects(raw({}, 'id'));
  await channelRefused((client, done) => client.sftp(done));
  await channelRefused((client, done) => client.shell(done));
  await channelRefused((client, done) => client.exec(COMMAND, { pty: true }, done));
  await channelRefused((client, done) => client.subsys('unapproved-subsystem', done));
  await channelRefused((client, done) => client.forwardOut('127.0.0.1', 1234, '127.0.0.1', 1234, done));
  await channelRefused((client, done) => client.forwardIn('127.0.0.1', 0, done));
  await channelRefused((client, done) => client.openssh_forwardOutStreamLocal('/unapproved-fixture.sock', done));
  const observed = await broker.observe(binding);
  assert.equal(observed.snapshot.mode, 0o666); assert.equal(await publication(), observed.snapshot.digest);
  const wrongScope = await raw({ version: 1, command: 'OBSERVE', ...binding, scope: { ...binding.scope, websiteId: randomUUID() } });
  assert.deepEqual(wrongScope, { ok: false, errorCode: 'MANAGED_SCOPE_MISMATCH' });
  const pathInjection = await raw({ version: 1, command: 'OBSERVE', ...binding, path: '/etc/passwd' });
  assert.equal(pathInjection.ok, false);
  const harden = await prepare('HARDEN', observed);
  await exportAndVerify(harden);
  const beforeBadPermit = await raw({ version: 1, command: 'COMMIT', ...binding, operationId: harden.operationId, permit: { payload: {}, mac: '0'.repeat(64) } });
  assert.equal(beforeBadPermit.ok, false); assert.deepEqual((await broker.observe(binding)).snapshot, observed.snapshot);
  if (process.env.MANAGED_TARGET_FIXTURE_DROP_COMMIT_ACK === '1') {
    await assert.rejects(broker.commit(harden), (error) => error.code === 'OUTCOME_UNKNOWN' && error.uncertain);
    assert.equal(authorityCalls, 1);
    const status = await broker.status({ ...binding, operationId: harden.operationId });
    assert.equal(status.state, 'VERIFIED'); assert.equal(status.after.mode, 0o664); assert.equal(await publication(), observed.snapshot.digest);
    // Observational reconciliation succeeded. Never automatically send another mutation.
    process.stdout.write('MANAGED_STATIC_FIXTURE_LOST_ACK_RECONCILED_WITHOUT_REPLAY\n'); return;
  }
  const changed = await broker.commit(harden);
  assert.equal(changed.state, 'VERIFIED'); assert.equal(changed.after.mode, 0o664); assert.equal(changed.after.digest, observed.snapshot.digest);
  assert.equal(authorityCalls, 1); assert.equal(await publication(), observed.snapshot.digest);
  const replay = await raw({ version: 1, command: 'COMMIT', ...binding, operationId: harden.operationId, permit: lastPermit });
  assert.deepEqual(replay, { ok: false, errorCode: 'MANAGED_REPLAY_REFUSED' });
  const current = await broker.observe(binding);
  const restore = await prepare('RESTORE', current, harden.operationId);
  await exportAndVerify(restore);
  assert.notEqual(restore.operationId, harden.operationId); assert.notEqual(restore.challenge, harden.challenge);
  const restored = await broker.commit(restore);
  assert.equal(authorityCalls, 2); assert.equal(restored.after.mode, 0o666); assert.equal(restored.after.digest, observed.snapshot.digest);
  assert.equal(await publication(), observed.snapshot.digest);
  process.stdout.write('MANAGED_STATIC_FIXTURE_HARDEN_REPLAY_REFUSAL_AND_SEPARATE_RESTORE_VERIFIED\n');
}
main().catch(() => { process.stderr.write('MANAGED_STATIC_FIXTURE_FAILED\n'); process.exitCode = 1; })
  .finally(() => { privateKey.fill(0); permitKey.fill(0); recoveryKey.fill(0); });
