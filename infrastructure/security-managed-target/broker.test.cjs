'use strict';
// In-memory transport fixtures. These do not establish the filesystem/SSH guarantee.
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash, randomUUID } = require('node:crypto');
const { canonical } = require('./recovery-codec.cjs');
const { createManagedTargetBroker, COMMAND } = require('./broker.cjs');
function fixtures() {
  const binding = { scope: { tenantId: randomUUID(), websiteId: randomUUID(), environment: 'STAGING', runId: randomUUID() }, namespaceId: randomUUID(), targetId: randomUUID() };
  const before = { device: '2049', inode: '3344', uid: 0, gid: 0, mode: 0o666, size: 4, mtimeNs: '1792000000000000000', ctimeNs: '1792000000000000000', digest: 'a'.repeat(64) };
  const prepared = { ...binding, adapter: 'MANAGED_STATIC_PERMISSION_V1', state: 'PREPARED', operationId: randomUUID(), action: 'HARDEN',
    planDigest: 'b'.repeat(64), authorityDigest: 'c'.repeat(64), snapshotDigest: createHash('sha256').update(canonical(before)).digest('hex'),
    recoveryDigest: 'd'.repeat(64), challenge: 'e'.repeat(64), preparedAt: Date.now(), before, targetMode: 0o664 };
  return { binding, before, prepared };
}
function reconciliationFixture() {
  const { binding, before, prepared } = fixtures();
  const observation = { ...binding, version: 1, adapter: prepared.adapter, state: 'RECONCILIATION_OBSERVED', operationId: prepared.operationId,
    reconciliationId: randomUUID(), sourceState: 'INTENT', sourceDigest: 'f'.repeat(64), sourceSnapshotDigest: prepared.snapshotDigest,
    recoveryDigest: prepared.recoveryDigest, action: 'HARDEN', targetMode: 0o664, before, current: before,
    currentSnapshotDigest: prepared.snapshotDigest, classification: 'MATCHES_BEFORE', observedAt: Date.now(), challenge: prepared.challenge };
  const body = { version: 1, adapter: prepared.adapter, state: 'RECONCILED_OBSERVATION_ONLY', observation, permitDigest: 'a'.repeat(64), recordedAt: observation.observedAt };
  return { observation, receipt: { ...body, receiptDigest: createHash('sha256').update(canonical(body)).digest('hex') } };
}
function transport(responder) {
  const evidence = { calls: 0, ended: 0, destroyed: 0, commands: [] };
  const connectPinned = async () => {
    const client = new EventEmitter();
    client.end = () => { evidence.ended += 1; };
    client.destroy = () => { evidence.destroyed += 1; client.emit('close'); };
    client.exec = (command, callback) => {
      evidence.commands.push(command); evidence.calls += 1;
      const stream = new EventEmitter(); stream.stderr = new EventEmitter(); stream.destroy = () => {};
      stream.end = (input) => { setImmediate(() => responder({ request: JSON.parse(input), stream, client })); };
      callback(undefined, stream);
    };
    return client;
  };
  return { evidence, connectPinned };
}
function reply(stream, value, code = 0) { stream.emit('data', Buffer.from(`${JSON.stringify(value)}\n`)); stream.emit('exit', code); stream.emit('close'); }
const access = { privateKey: Buffer.alloc(100) };
const permit = async () => ({ payload: {}, mac: 'f'.repeat(64) }); // Mock only; real helper rejects this.
test('broker sends only the fixed exec command and closes a successful observation', async () => {
  const { binding, before, prepared } = fixtures();
  const fixture = transport(({ request, stream }) => {
    assert.equal(request.command, 'OBSERVE');
    reply(stream, { ok: true, result: { adapter: 'MANAGED_STATIC_PERMISSION_V1', state: 'OBSERVED', snapshot: before, snapshotDigest: prepared.snapshotDigest } });
  });
  const result = await createManagedTargetBroker(access, fixture).observe(binding);
  assert.deepEqual(result.snapshot, before); assert.deepEqual(fixture.evidence.commands, [COMMAND]);
  assert.equal(fixture.evidence.ended, 1); assert.equal(fixture.evidence.destroyed, 1);
});
test('lost commit acknowledgement is unknown, has no retry, and closes resources', async () => {
  const { prepared } = fixtures(); const fixture = transport(({ client }) => client.emit('close'));
  await assert.rejects(createManagedTargetBroker(access, { ...fixture, authorizeAndIssuePermit: permit }).commit(prepared), (error) => error.code === 'OUTCOME_UNKNOWN' && error.uncertain);
  assert.equal(fixture.evidence.calls, 1); assert.equal(fixture.evidence.destroyed, 1);
});
test('structured pre-intent refusal remains a refusal but never triggers retry', async () => {
  const { prepared } = fixtures();
  const fixture = transport(({ stream }) => reply(stream, { ok: false, errorCode: 'MANAGED_TARGET_DRIFT' }, 2));
  await assert.rejects(createManagedTargetBroker(access, { ...fixture, authorizeAndIssuePermit: permit }).commit(prepared), (error) => error.code === 'MANAGED_TARGET_DRIFT' && !error.uncertain);
  assert.equal(fixture.evidence.calls, 1);
});
test('malformed or contradictory commit output cannot become success', async () => {
  const { prepared } = fixtures();
  for (const response of [{ ...prepared, state: 'VERIFIED' }, { ...prepared, state: 'VERIFIED', verifiedAt: Date.now(), after: { ...prepared.before, mode: 0o666 } }]) {
    const fixture = transport(({ stream }) => reply(stream, { ok: true, result: response }));
    await assert.rejects(createManagedTargetBroker(access, { ...fixture, authorizeAndIssuePermit: permit }).commit(prepared), (error) => error.code === 'OUTCOME_UNKNOWN' && error.uncertain);
    assert.equal(fixture.evidence.calls, 1);
  }
});
test('oversized output is bounded; cancellation after commit starts is unknown', async () => {
  const { binding, prepared } = fixtures();
  const tooMuch = transport(({ stream }) => stream.emit('data', Buffer.alloc(32769, 65)));
  await assert.rejects(createManagedTargetBroker(access, tooMuch).observe(binding), /MANAGED_OUTPUT_LIMIT/);
  const abort = new AbortController(); const delayed = transport(() => abort.abort());
  await assert.rejects(createManagedTargetBroker(access, { ...delayed, authorizeAndIssuePermit: permit }).commit(prepared, abort.signal), (error) => error.code === 'OUTCOME_UNKNOWN' && error.uncertain);
  assert.equal(delayed.evidence.calls, 1);
});
test('pre-cancelled operation never issues a permit or opens a connection', async () => {
  const { prepared } = fixtures(); const abort = new AbortController(); abort.abort(); let issued = 0;
  const fixture = transport(() => assert.fail('must not connect'));
  await assert.rejects(createManagedTargetBroker(access, { ...fixture, authorizeAndIssuePermit: async () => { issued += 1; return permit(); } }).commit(prepared, abort.signal), /MANAGED_CANCELLED/);
  assert.equal(issued, 0); assert.equal(fixture.evidence.calls, 0);
});
test('authority failure is sanitized and never opens a connection', async () => {
  const { prepared } = fixtures(); const fixture = transport(() => assert.fail('must not connect'));
  await assert.rejects(createManagedTargetBroker(access, { ...fixture, authorizeAndIssuePermit: async () => { throw new Error('synthetic sensitive provider detail'); } }).commit(prepared),
    (error) => error.code === 'MANAGED_AUTHORIZATION_REFUSED' && error.message === 'MANAGED_AUTHORIZATION_REFUSED');
  assert.equal(fixture.evidence.calls, 0);
});
test('reconciliation uses separate authority and fixed exec without claiming original success', async () => {
  const { observation, receipt } = reconciliationFixture(); let issued = 0;
  const fixture = transport(({ request, stream }) => {
    assert.equal(request.command, 'RECONCILE'); assert.deepEqual(request.observation, observation);
    reply(stream, { ok: true, result: receipt });
  });
  const broker = createManagedTargetBroker(access, { ...fixture, authorizeAndIssuePermit: () => assert.fail('mutation authority must not be used'),
    authorizeAndIssueReconciliationPermit: async (selected) => { issued += 1; assert.deepEqual(selected, observation); return permit(); } });
  assert.deepEqual(await broker.reconcile(observation), receipt);
  assert.equal(issued, 1); assert.equal(fixture.evidence.calls, 1); assert.deepEqual(fixture.evidence.commands, [COMMAND]);
  assert.equal(receipt.observation.sourceState, 'INTENT'); assert.equal(receipt.state, 'RECONCILED_OBSERVATION_ONLY');
});
test('reconciliation without distinct authority is unregistered and never connects', async () => {
  const { observation } = reconciliationFixture(); const fixture = transport(() => assert.fail('must not connect'));
  await assert.rejects(createManagedTargetBroker(access, { ...fixture, authorizeAndIssuePermit: permit }).reconcile(observation), /UNREGISTERED_SECURITY_EXECUTOR/);
  assert.equal(fixture.evidence.calls, 0);
});
test('lost reconciliation acknowledgement reports only receipt uncertainty and never retries', async () => {
  const { observation } = reconciliationFixture(); const fixture = transport(({ client }) => client.emit('close'));
  await assert.rejects(createManagedTargetBroker(access, { ...fixture, authorizeAndIssueReconciliationPermit: permit }).reconcile(observation),
    (error) => error.code === 'MANAGED_RECONCILIATION_RECEIPT_UNKNOWN' && error.uncertain);
  assert.equal(fixture.evidence.calls, 1);
});
test('reconciliation inspect/status verify exact binding, snapshot relationships and receipt digest', async () => {
  const { observation, receipt } = reconciliationFixture();
  const input = { scope: observation.scope, namespaceId: observation.namespaceId, targetId: observation.targetId,
    operationId: observation.operationId, reconciliationId: observation.reconciliationId };
  const valid = transport(({ request, stream }) => reply(stream, { ok: true, result: request.command === 'RECONCILE_OBSERVE' ? observation : receipt }));
  const broker = createManagedTargetBroker(access, valid);
  assert.deepEqual(await broker.inspectReconciliation(input), observation);
  assert.deepEqual(await broker.reconciliationStatus(input), receipt);
  for (const result of [{ ...observation, classification: 'MATCHES_EXPECTED_POSTIMAGE' }, { ...observation, sourceState: 'VERIFIED' },
    { ...observation, operationId: randomUUID() }]) {
    const wrong = transport(({ stream }) => reply(stream, { ok: true, result }));
    await assert.rejects(createManagedTargetBroker(access, wrong).inspectReconciliation(input), /MANAGED_PROTOCOL_INVALID/);
  }
  const wrongReceipt = transport(({ stream }) => reply(stream, { ok: true, result: { ...receipt, receiptDigest: '0'.repeat(64) } }));
  await assert.rejects(createManagedTargetBroker(access, wrongReceipt).reconciliationStatus(input), /MANAGED_PROTOCOL_INVALID/);
});
