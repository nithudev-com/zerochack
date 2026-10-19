'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { canonical, run } = require('./recovery-codec.cjs');
const { isPublicIpv4, createManagedTargetBroker } = require('./broker.cjs');
function fixture(bytes = Buffer.from('synthetic fixture')) {
  const snapshot = { device: '2049', inode: '12345', uid: 0, gid: 0, mode: 0o666, size: bytes.length,
    mtimeNs: '1792345678123456789', ctimeNs: '1792345678123456799', digest: createHash('sha256').update(bytes).digest('hex') };
  const aad = { protocol: 1, namespaceId: randomUUID(), targetId: randomUUID(), operationId: randomUUID(),
    scope: { tenantId: randomUUID(), websiteId: randomUUID(), environment: 'STAGING', runId: randomUUID() },
    snapshotDigest: createHash('sha256').update(canonical(snapshot)).digest('hex') };
  return { snapshot, aad, bytes: bytes.toString('base64') };
}
test('real AES-256-GCM recovery encrypts and verifies exact full bytes and metadata', () => {
  const key = randomBytes(32); const input = fixture(randomBytes(200000));
  const envelope = run('seal', input, key);
  assert.equal(envelope.algorithm, 'AES-256-GCM');
  assert.equal(canonical(envelope).includes(input.bytes), false);
  assert.deepEqual(run('verify', { envelope, expectedAad: input.aad, expectedSnapshot: input.snapshot }, key),
    { verified: true, digest: input.snapshot.digest, snapshotDigest: input.aad.snapshotDigest });
  key.fill(0);
});
test('recovery refuses wrong key, ciphertext, tag, namespace, metadata and plaintext digest', () => {
  const key = randomBytes(32); const input = fixture(); const envelope = run('seal', input, key);
  assert.throws(() => run('verify', { envelope, expectedAad: input.aad, expectedSnapshot: input.snapshot }, randomBytes(32)));
  for (const field of ['ciphertext','tag','iv']) {
    const tampered = structuredClone(envelope); const bytes = Buffer.from(tampered[field], 'base64'); bytes[0] ^= 1; tampered[field] = bytes.toString('base64');
    assert.throws(() => run('verify', { envelope: tampered, expectedAad: input.aad, expectedSnapshot: input.snapshot }, key));
  }
  assert.throws(() => run('verify', { envelope, expectedAad: { ...input.aad, targetId: randomUUID() }, expectedSnapshot: input.snapshot }, key));
  assert.throws(() => run('verify', { envelope, expectedAad: input.aad, expectedSnapshot: { ...input.snapshot, mode: 0o664 } }, key));
  assert.throws(() => run('seal', { ...input, bytes: Buffer.from('wrong bytes').toString('base64') }, key));
  key.fill(0);
});
test('recovery rejects oversized/noncanonical/base64/production payloads and executable or owned-by-user files', () => {
  const key = randomBytes(32); const input = fixture();
  for (const change of [{ bytes: '!!!!' }, { extra: 'ignored?' }, { aad: { ...input.aad, scope: { ...input.aad.scope, environment: 'PRODUCTION' } } },
    { snapshot: { ...input.snapshot, uid: 1000 } }, { snapshot: { ...input.snapshot, mode: 0o766 } }]) assert.throws(() => run('seal', { ...input, ...change }, key));
  assert.throws(() => run('seal', fixture(randomBytes(200001)), key)); key.fill(0);
});
test('broker default rejects loopback, private, link-local and documentation addresses', async () => {
  for (const address of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.2','100.64.0.1','198.18.0.1','192.0.2.1','198.51.100.1','203.0.113.1','::1','example.com']) assert.equal(isPublicIpv4(address), false);
  assert.equal(isPublicIpv4('164.68.114.89'), true);
  const broker = createManagedTargetBroker({ address: '127.0.0.1', privateKey: Buffer.alloc(100) });
  const value = fixture();
  await assert.rejects(broker.observe({ scope: value.aad.scope, namespaceId: value.aad.namespaceId, targetId: value.aad.targetId }), /MANAGED_ADDRESS_REFUSED/);
});
test('no production authority exists; commit cannot generate its own permit', async () => {
  const value = fixture();
  const broker = createManagedTargetBroker({ privateKey: Buffer.alloc(100) });
  await assert.rejects(broker.commit({ ...value.aad, adapter: 'MANAGED_STATIC_PERMISSION_V1', state: 'PREPARED' }), /UNREGISTERED_SECURITY_EXECUTOR/);
});
test('canonicalization is bounded and refuses cycles, getters, deep/wide/oversized values', () => {
  const cycle = {}; cycle.self = cycle;
  let deep = {}; for (let count = 0; count < 13; count += 1) deep = { child: deep };
  let getterCalled = false; const getter = {}; Object.defineProperty(getter, 'value', { enumerable: true, get() { getterCalled = true; return 'x'; } });
  for (const value of [cycle, deep, getter, { text: 'x'.repeat(600001) }, { text: 'x'.repeat(500000), other: 'y'.repeat(500000) },
    Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, 1])), { array: Array(65).fill(0) }, { text: '\u2603' }]) assert.throws(() => canonical(value));
  assert.equal(getterCalled, false);
  assert.equal(canonical({ z: 1, a: { text: 'ASCII' } }), '{"a":{"text":"ASCII"},"z":1}');
});
