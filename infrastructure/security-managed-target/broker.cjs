'use strict';

// Unregistered server-only adapter. It cannot execute caller/model commands or accept passwords.
const { createHash, timingSafeEqual } = require('node:crypto');
const { isIP } = require('node:net');
const { canonical } = require('./recovery-codec.cjs');
const COMMAND = 'codebandage-managed-target-v1';
const MAX_REQUEST = 32768;
const MAX_RESPONSE = 32768;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const ADAPTER = 'MANAGED_STATIC_PERMISSION_V1';
const RECONCILIATION_PURPOSE = 'OBSERVATION_RECONCILIATION_V1';

class ManagedTargetError extends Error {
  constructor(code, uncertain = false) { super(code); this.code = code; this.uncertain = uncertain; }
}
function requireValue(value, code = 'MANAGED_TARGET_INVALID') { if (!value) throw new ManagedTargetError(code); }
function scope(value) {
  requireValue(value && Object.keys(value).sort().join(',') === 'environment,runId,tenantId,websiteId');
  requireValue(value.environment === 'STAGING' && ['tenantId','websiteId','runId'].every((field) => UUID.test(value[field])));
}
function base(value) {
  scope(value.scope); requireValue(UUID.test(value.namespaceId) && UUID.test(value.targetId));
}
function snapshot(value) {
  requireValue(value && Object.keys(value).sort().join(',') === 'ctimeNs,device,digest,gid,inode,mode,mtimeNs,size,uid', 'MANAGED_PROTOCOL_INVALID');
  requireValue(['device','inode','mtimeNs','ctimeNs'].every((field) => typeof value[field] === 'string' && /^(0|[1-9][0-9]{0,23})$/.test(value[field])), 'MANAGED_PROTOCOL_INVALID');
  requireValue(value.uid === 0 && value.gid === 0 && Number.isSafeInteger(value.size) && value.size >= 0 && value.size <= 200000 &&
    Number.isSafeInteger(value.mode) && value.mode >= 0 && value.mode <= 0o666 && (value.mode & ~0o666) === 0 && (value.mode & 0o604) === 0o604 && HEX.test(value.digest), 'MANAGED_PROTOCOL_INVALID');
}
function exact(value, fields) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...fields].sort().join(','), 'MANAGED_PROTOCOL_INVALID');
}
function hash(value) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function reconciliationObservation(value) {
  exact(value, ['version','adapter','state','scope','namespaceId','targetId','operationId','reconciliationId','sourceState','sourceDigest',
    'sourceSnapshotDigest','recoveryDigest','action','targetMode','before','current','currentSnapshotDigest','classification','observedAt','challenge']);
  base(value);
  requireValue(value.version === 1 && value.adapter === ADAPTER && value.state === 'RECONCILIATION_OBSERVED' &&
    UUID.test(value.operationId) && UUID.test(value.reconciliationId) && value.operationId !== value.reconciliationId &&
    ['INTENT','OUTCOME_UNKNOWN'].includes(value.sourceState), 'MANAGED_PROTOCOL_INVALID');
  for (const field of ['sourceDigest','sourceSnapshotDigest','recoveryDigest','currentSnapshotDigest','challenge']) requireValue(HEX.test(value[field]), 'MANAGED_PROTOCOL_INVALID');
  snapshot(value.before); snapshot(value.current);
  const targetMode = value.action === 'HARDEN' ? value.before.mode & ~0o002 : value.before.mode | 0o002;
  const classification = canonical(value.current) === canonical(value.before) ? 'MATCHES_BEFORE' :
    canonical(value.current) === canonical({ ...value.before, mode: targetMode, ctimeNs: value.current.ctimeNs }) ? 'MATCHES_EXPECTED_POSTIMAGE' : 'DRIFT';
  requireValue(['HARDEN','RESTORE'].includes(value.action) && value.targetMode === targetMode && targetMode !== value.before.mode &&
    value.sourceSnapshotDigest === hash(value.before) && value.currentSnapshotDigest === hash(value.current) && value.classification === classification &&
    Number.isSafeInteger(value.observedAt) && value.observedAt >= 0, 'MANAGED_PROTOCOL_INVALID');
}
function reconciliationReceipt(value) {
  exact(value, ['version','adapter','state','observation','permitDigest','recordedAt','receiptDigest']);
  reconciliationObservation(value.observation);
  const { receiptDigest, ...body } = value;
  requireValue(value.version === 1 && value.adapter === ADAPTER && value.state === 'RECONCILED_OBSERVATION_ONLY' && HEX.test(value.permitDigest) &&
    HEX.test(receiptDigest) && hash(body) === receiptDigest && Number.isSafeInteger(value.recordedAt) && value.recordedAt >= value.observation.observedAt,
  'MANAGED_PROTOCOL_INVALID');
}
function isPublicIpv4(address) {
  if (typeof address !== 'string' || isIP(address) !== 4) return false;
  const [a,b,c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
function validateAccess(access) {
  requireValue(isPublicIpv4(access.address), 'MANAGED_ADDRESS_REFUSED');
  requireValue(Number.isInteger(access.port) && access.port >= 1 && access.port <= 65535);
  requireValue(access.username === 'codebandage-managed-target');
  requireValue(typeof access.hostKeyFingerprint === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(access.hostKeyFingerprint));
  requireValue(Buffer.isBuffer(access.privateKey) && access.privateKey.length >= 100 && access.privateKey.length <= 16384);
}
async function disconnect(client) {
  // A bounded close acknowledgement avoids racing the next fixture connection against
  // a still-counted remote session. Never retry a request to obtain that acknowledgement.
  await new Promise((resolve) => {
    let timer;
    const finish = () => { clearTimeout(timer); client.removeListener('close', finish); resolve(); };
    client.once('close', finish); timer = setTimeout(finish, 200);
    try { client.end(); } catch {}
    try { client.destroy(); } catch {}
  });
}
async function connectPinned(access, signal) {
  validateAccess(access);
  const { Client } = require('ssh2');
  const client = new Client();
  try {
    await new Promise((resolve, reject) => {
      const aborted = () => { client.destroy(); reject(new ManagedTargetError('MANAGED_CANCELLED')); };
      const timer = setTimeout(() => { client.destroy(); reject(new ManagedTargetError('MANAGED_CONNECT_TIMEOUT')); }, 12000);
      const finish = (error) => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); if (error) reject(error); else resolve(); };
      client.once('ready', () => finish());
      client.once('error', () => finish(new ManagedTargetError('MANAGED_CONNECT_REFUSED')));
      client.once('close', () => finish(new ManagedTargetError('MANAGED_CONNECT_REFUSED')));
      if (signal?.aborted) return aborted();
      signal?.addEventListener('abort', aborted, { once: true });
      client.connect({ host: access.address, port: access.port, username: access.username, privateKey: access.privateKey,
        readyTimeout: 11000, keepaliveInterval: 5000, keepaliveCountMax: 1, tryKeyboard: false,
        hostVerifier: (key) => {
          const actual = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
          const left = Buffer.from(actual); const right = Buffer.from(access.hostKeyFingerprint);
          return left.length === right.length && timingSafeEqual(left, right);
        } });
    });
    return client;
  } catch (error) { await disconnect(client); throw error instanceof ManagedTargetError ? error : new ManagedTargetError('MANAGED_CONNECT_REFUSED'); }
}
function validateResponse(request, value) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'MANAGED_PROTOCOL_INVALID');
  if (value.ok === false) {
    requireValue(Object.keys(value).sort().join(',') === 'errorCode,ok' && /^[A-Z][A-Z0-9_]{1,79}$/.test(value.errorCode), 'MANAGED_PROTOCOL_INVALID');
    throw new ManagedTargetError(value.errorCode, ['OUTCOME_UNKNOWN','MANAGED_RECONCILIATION_RECEIPT_UNKNOWN'].includes(value.errorCode));
  }
  requireValue(value.ok === true && Object.keys(value).sort().join(',') === 'ok,result' && value.result?.adapter === ADAPTER,
    'MANAGED_PROTOCOL_INVALID');
  const result = value.result;
  if (request.command === 'RECONCILE_OBSERVE' || request.command === 'RECONCILE' || request.command === 'RECONCILIATION_STATUS') {
    if (request.command === 'RECONCILE_OBSERVE') reconciliationObservation(result); else reconciliationReceipt(result);
    const observation = request.command === 'RECONCILE_OBSERVE' ? result : result.observation;
    requireValue(observation.operationId === request.operationId && observation.namespaceId === request.namespaceId && observation.targetId === request.targetId &&
      canonical(observation.scope) === canonical(request.scope) && observation.reconciliationId === (request.reconciliationId ?? request.observation.reconciliationId),
      'MANAGED_PROTOCOL_INVALID');
    if (request.command === 'RECONCILE') requireValue(canonical(observation) === canonical(request.observation), 'MANAGED_PROTOCOL_INVALID');
    return result;
  }
  if (request.command === 'OBSERVE') {
    snapshot(result.snapshot);
    requireValue(result.state === 'OBSERVED' && HEX.test(result.snapshotDigest) &&
      createHash('sha256').update(canonical(result.snapshot)).digest('hex') === result.snapshotDigest, 'MANAGED_PROTOCOL_INVALID');
  } else {
    requireValue(result.operationId === request.operationId && result.namespaceId === request.namespaceId && result.targetId === request.targetId &&
      canonical(result.scope) === canonical(request.scope) && ['PREPARED','VERIFIED','OUTCOME_UNKNOWN'].includes(result.state), 'MANAGED_PROTOCOL_INVALID');
    for (const field of ['planDigest','authorityDigest','snapshotDigest','recoveryDigest','challenge']) requireValue(HEX.test(result[field]), 'MANAGED_PROTOCOL_INVALID');
    requireValue(['HARDEN','RESTORE'].includes(result.action) && Number.isSafeInteger(result.preparedAt), 'MANAGED_PROTOCOL_INVALID');
    snapshot(result.before);
    requireValue(createHash('sha256').update(canonical(result.before)).digest('hex') === result.snapshotDigest &&
      result.targetMode === (result.action === 'HARDEN' ? result.before.mode & ~0o002 : result.before.mode | 0o002) &&
      result.targetMode !== result.before.mode, 'MANAGED_PROTOCOL_INVALID');
    if (result.state === 'VERIFIED') {
      snapshot(result.after);
      requireValue(Number.isSafeInteger(result.verifiedAt) && canonical(result.after) === canonical({ ...result.before, mode: result.targetMode, ctimeNs: result.after.ctimeNs }), 'MANAGED_PROTOCOL_INVALID');
    }
    if (request.command === 'PREPARE') requireValue(result.state === 'PREPARED' && result.action === request.action &&
      result.planDigest === request.planDigest && result.authorityDigest === request.authorityDigest && canonical(result.before) === canonical(request.expectedSnapshot), 'MANAGED_PROTOCOL_INVALID');
    if (request.command === 'COMMIT') requireValue(result.state === 'VERIFIED', result.state === 'OUTCOME_UNKNOWN' ? 'OUTCOME_UNKNOWN' : 'MANAGED_PROTOCOL_INVALID');
  }
  return result;
}
function command(client, request, signal) {
  const input = `${canonical(request)}\n`;
  requireValue(Buffer.byteLength(input) <= MAX_REQUEST);
  return new Promise((resolve, reject) => {
    let channel; let output = ''; let stderrSize = 0; let exitCode; let ended = false;
    const uncertain = request.command === 'COMMIT' || request.command === 'RECONCILE';
    const uncertainCode = request.command === 'RECONCILE' ? 'MANAGED_RECONCILIATION_RECEIPT_UNKNOWN' : 'OUTCOME_UNKNOWN';
    function finish(error, result) {
      if (ended) return;
      ended = true; clearTimeout(timer); signal?.removeEventListener('abort', aborted);
      if (error) { channel?.destroy(); reject(error); } else resolve(result);
    }
    const failed = (code) => finish(new ManagedTargetError(uncertain ? uncertainCode : code, uncertain));
    const aborted = () => failed('MANAGED_CANCELLED');
    const timer = setTimeout(() => failed('MANAGED_TRANSPORT_TIMEOUT'), 30000);
    if (signal?.aborted) return aborted();
    signal?.addEventListener('abort', aborted, { once: true });
    client.once('error', () => failed('MANAGED_TRANSPORT_FAILED'));
    client.once('close', () => { if (!ended) failed('MANAGED_TRANSPORT_FAILED'); });
    try {
      client.exec(COMMAND, (error, stream) => {
        if (ended) { stream?.destroy(); return; }
        if (error) return failed('MANAGED_COMMAND_REFUSED');
        channel = stream;
        stream.on('data', (chunk) => { output += chunk.toString('utf8'); if (Buffer.byteLength(output) > MAX_RESPONSE) failed('MANAGED_OUTPUT_LIMIT'); });
        stream.stderr.on('data', (chunk) => { stderrSize += chunk.length; if (stderrSize > 1024) failed('MANAGED_OUTPUT_LIMIT'); });
        stream.once('error', () => failed('MANAGED_TRANSPORT_FAILED'));
        stream.once('exit', (code) => { exitCode = code; });
        stream.once('close', () => {
          if (ended) return;
          try {
            requireValue((exitCode === 0 || exitCode === 2) && output.endsWith('\n') && !output.slice(0,-1).includes('\n'), 'MANAGED_PROTOCOL_INVALID');
            const parsed = JSON.parse(output);
            requireValue((parsed.ok === true && exitCode === 0) || (parsed.ok === false && exitCode === 2), 'MANAGED_PROTOCOL_INVALID');
            finish(undefined, validateResponse(request, parsed));
          } catch (error) {
            if (error instanceof ManagedTargetError && /^[A-Z][A-Z0-9_]+$/.test(error.code) && parsedError(output, error.code)) finish(error);
            else failed('MANAGED_PROTOCOL_INVALID');
          }
        });
        stream.end(input);
      });
    } catch { failed('MANAGED_TRANSPORT_FAILED'); }
  });
}
function parsedError(output, code) {
  // Only a complete structured helper refusal can prove failure before its durable INTENT.
  try { const value = JSON.parse(output); return value.ok === false && value.errorCode === code && Object.keys(value).sort().join(',') === 'errorCode,ok'; }
  catch { return false; }
}
function createManagedTargetBroker(access, dependencies = {}) {
  requireValue(access && Buffer.isBuffer(access.privateKey) && access.privateKey.length <= 16384);
  access = Object.freeze({ ...access, privateKey: Buffer.from(access.privateKey) });
  const connect = dependencies.connectPinned ?? connectPinned; // Injection is test-only; production default enforces public-IP pinning.
  async function request(value, signal) {
    if (signal?.aborted) throw new ManagedTargetError('MANAGED_CANCELLED');
    base(value);
    const immutable = JSON.parse(canonical({ ...value, version: 1 }));
    const client = await connect(access, signal);
    try { return await command(client, immutable, signal); }
    finally { await disconnect(client); }
  }
  return Object.freeze({
    observe: (binding, signal) => request({ ...binding, command: 'OBSERVE' }, signal),
    prepare: (input, signal) => request({ ...input, command: 'PREPARE' }, signal),
    status: (input, signal) => request({ ...input, command: 'STATUS' }, signal),
    inspectReconciliation: (input, signal) => request({ ...input, command: 'RECONCILE_OBSERVE' }, signal),
    reconciliationStatus: (input, signal) => request({ ...input, command: 'RECONCILIATION_STATUS' }, signal),
    async reconcile(observation, signal) {
      if (signal?.aborted) throw new ManagedTargetError('MANAGED_CANCELLED');
      observation = JSON.parse(canonical(observation));
      reconciliationObservation(observation);
      requireValue(typeof dependencies.authorizeAndIssueReconciliationPermit === 'function', 'UNREGISTERED_SECURITY_EXECUTOR');
      let timer; let aborted; let permit;
      try {
        permit = await Promise.race([
          dependencies.authorizeAndIssueReconciliationPermit(Object.freeze(JSON.parse(canonical(observation))), signal),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new ManagedTargetError('MANAGED_AUTHORIZATION_TIMEOUT')), 5000);
            aborted = () => reject(new ManagedTargetError('MANAGED_CANCELLED'));
            if (signal?.aborted) aborted(); else signal?.addEventListener('abort', aborted, { once: true }); })
        ]);
      } catch (error) { throw error instanceof ManagedTargetError ? error : new ManagedTargetError('MANAGED_AUTHORIZATION_REFUSED'); }
      finally { clearTimeout(timer); if (aborted) signal?.removeEventListener('abort', aborted); }
      if (signal?.aborted) throw new ManagedTargetError('MANAGED_CANCELLED');
      return request({ scope: observation.scope, namespaceId: observation.namespaceId, targetId: observation.targetId,
        operationId: observation.operationId, command: 'RECONCILE', observation, permit }, signal);
    },
    async commit(prepared, signal) {
      if (signal?.aborted) throw new ManagedTargetError('MANAGED_CANCELLED');
      prepared = JSON.parse(canonical(prepared));
      requireValue(prepared.state === 'PREPARED' && prepared.adapter === ADAPTER && UUID.test(prepared.operationId));
      requireValue(typeof dependencies.authorizeAndIssuePermit === 'function', 'UNREGISTERED_SECURITY_EXECUTOR');
      // Authority implementation is intentionally absent from the application. It must compare
      // durable approval/scope/lease/expiry immediately before signing this exact challenge.
      let timer; let aborted;
      let permit;
      try {
        permit = await Promise.race([
          dependencies.authorizeAndIssuePermit(Object.freeze(JSON.parse(canonical(prepared))), signal),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new ManagedTargetError('MANAGED_AUTHORIZATION_TIMEOUT')), 5000);
            aborted = () => reject(new ManagedTargetError('MANAGED_CANCELLED'));
            if (signal?.aborted) aborted(); else signal?.addEventListener('abort', aborted, { once: true }); })
        ]);
      } catch (error) { throw error instanceof ManagedTargetError ? error : new ManagedTargetError('MANAGED_AUTHORIZATION_REFUSED'); }
      finally { clearTimeout(timer); if (aborted) signal?.removeEventListener('abort', aborted); }
      if (signal?.aborted) throw new ManagedTargetError('MANAGED_CANCELLED');
      return request({ scope: prepared.scope, namespaceId: prepared.namespaceId, targetId: prepared.targetId,
        operationId: prepared.operationId, command: 'COMMIT', permit }, signal);
    }
  });
}
module.exports = { createManagedTargetBroker, ManagedTargetError, COMMAND, isPublicIpv4, RECONCILIATION_PURPOSE };
