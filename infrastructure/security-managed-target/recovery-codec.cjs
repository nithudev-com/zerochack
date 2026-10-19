'use strict';

// Fixed trusted helper, not a general-purpose decryption API. Never put this key in argv/env.
const { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } = require('node:crypto');
const fs = require('node:fs');
const KEY_FILE = '/run/managed-target/recovery.key';
const MAX_INPUT = 786432;
const MAX_FILE = 200000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const hex = /^[0-9a-f]{64}$/;
const decimal = /^(0|[1-9][0-9]{0,23})$/;

function fail() { throw new Error('RECOVERY_INVALID'); }
function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) fail();
}
function canonical(value) {
  const chunks = []; const ancestors = new Set(); let nodes = 0; let bytes = 0;
  function append(token) { bytes += token.length; if (bytes > MAX_INPUT) fail(); chunks.push(token); }
  function walk(item, depth) {
    if (++nodes > 512 || depth > 12) fail();
    if (item === null || typeof item === 'boolean') { append(JSON.stringify(item)); return; }
    if (typeof item === 'string') {
      if (item.length > 600000 || /[^\x20-\x7e]/.test(item)) fail();
      append(JSON.stringify(item)); return;
    }
    if (typeof item === 'number' && Number.isSafeInteger(item)) { append(String(item)); return; }
    if (!item || typeof item !== 'object' || ancestors.has(item)) fail();
    ancestors.add(item);
    if (Array.isArray(item)) {
      if (item.length > 64 || Reflect.ownKeys(item).length !== item.length + 1) fail();
      append('['); for (let index = 0; index < item.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
        if (index) append(','); walk(descriptor.value, depth + 1);
      } append(']');
    } else {
      if (![Object.prototype, null].includes(Object.getPrototypeOf(item))) fail();
      const descriptors = Object.getOwnPropertyDescriptors(item); const names = Object.keys(descriptors).sort();
      if (names.length > 64 || Reflect.ownKeys(item).length !== names.length) fail();
      append('{'); names.forEach((key, index) => {
        if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key) || !Object.hasOwn(descriptors[key], 'value')) fail();
        if (index) append(','); append(JSON.stringify(key)); append(':'); walk(descriptors[key].value, depth + 1);
      }); append('}');
    }
    ancestors.delete(item);
  }
  walk(value, 0); return chunks.join('');
}
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
function snapshot(value) {
  keys(value, ['device','inode','uid','gid','mode','size','mtimeNs','ctimeNs','digest']);
  for (const field of ['device','inode','mtimeNs','ctimeNs']) if (typeof value[field] !== 'string' || !decimal.test(value[field])) fail();
  for (const field of ['uid','gid','mode','size']) if (!Number.isSafeInteger(value[field]) || value[field] < 0) fail();
  if (value.uid !== 0 || value.gid !== 0 || value.size > MAX_FILE || value.mode > 0o666 || (value.mode & ~0o666) || (value.mode & 0o604) !== 0o604 || !hex.test(value.digest)) fail();
  return value;
}
function aad(value) {
  keys(value, ['protocol','namespaceId','targetId','operationId','scope','snapshotDigest']);
  if (value.protocol !== 1 || !hex.test(value.snapshotDigest)) fail();
  for (const field of ['namespaceId','targetId','operationId']) if (!uuid.test(value[field])) fail();
  keys(value.scope, ['tenantId','websiteId','environment','runId']);
  for (const field of ['tenantId','websiteId','runId']) if (!uuid.test(value.scope[field])) fail();
  if (value.scope.environment !== 'STAGING') fail();
  return value;
}
function b64(value, max) {
  if (typeof value !== 'string' || value.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > max || bytes.toString('base64') !== value) fail();
  return bytes;
}
function loadKey() {
  const fd = fs.openSync(KEY_FILE, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || info.gid !== 0 || info.nlink !== 1 || (info.mode & 0o7777) !== 0o400 || info.size !== 32) fail();
    const key = fs.readFileSync(fd);
    if (key.length !== 32) fail();
    return key;
  } finally { fs.closeSync(fd); }
}
function verify(envelope, expectedAad, expectedSnapshot, key) {
  keys(envelope, ['version','algorithm','aad','iv','ciphertext','tag']);
  if (envelope.version !== 1 || envelope.algorithm !== 'AES-256-GCM' || canonical(aad(envelope.aad)) !== canonical(aad(expectedAad))) fail();
  const iv = b64(envelope.iv, 12); const tag = b64(envelope.tag, 16);
  if (iv.length !== 12 || tag.length !== 16) fail();
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(canonical(envelope.aad))); decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(b64(envelope.ciphertext, 400000)), decipher.final()]);
  let payload;
  try { payload = JSON.parse(plaintext.toString('utf8')); } finally { plaintext.fill(0); }
  keys(payload, ['snapshot','bytes']);
  snapshot(payload.snapshot); snapshot(expectedSnapshot);
  if (canonical(payload.snapshot) !== canonical(expectedSnapshot) || digest(canonical(payload.snapshot)) !== expectedAad.snapshotDigest) fail();
  const bytes = b64(payload.bytes, MAX_FILE);
  try {
    if (bytes.length !== payload.snapshot.size || !timingSafeEqual(Buffer.from(digest(bytes), 'hex'), Buffer.from(payload.snapshot.digest, 'hex'))) fail();
    return { verified: true, snapshotDigest: expectedAad.snapshotDigest, digest: payload.snapshot.digest };
  } finally { bytes.fill(0); payload.bytes = ''; }
}
function run(mode, request, key) {
  if (mode === 'seal') {
    keys(request, ['aad','snapshot','bytes']); aad(request.aad); snapshot(request.snapshot);
    if (digest(canonical(request.snapshot)) !== request.aad.snapshotDigest) fail();
    const bytes = b64(request.bytes, MAX_FILE);
    if (bytes.length !== request.snapshot.size || digest(bytes) !== request.snapshot.digest) fail();
    bytes.fill(0);
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(canonical(request.aad)));
    const plaintext = Buffer.from(canonical({ snapshot: request.snapshot, bytes: request.bytes }));
    let ciphertext;
    try { ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); } finally { plaintext.fill(0); }
    const envelope = { version: 1, algorithm: 'AES-256-GCM', aad: request.aad, iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
    verify(envelope, request.aad, request.snapshot, key);
    return envelope;
  }
  if (mode === 'verify') {
    keys(request, ['envelope','expectedAad','expectedSnapshot']);
    return verify(request.envelope, request.expectedAad, request.expectedSnapshot, key);
  }
  fail();
}
if (require.main === module) {
  let bytes = 0; const chunks = [];
  const timer = setTimeout(() => process.exit(3), 8000); timer.unref();
  process.stdin.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_INPUT) process.exit(2); chunks.push(chunk); });
  process.stdin.on('end', () => {
    let key;
    try {
      if (process.argv.length !== 3 || process.getuid() !== 0) fail();
      key = loadKey(); const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      process.stdout.write(`${canonical(run(process.argv[2], request, key))}\n`);
    } catch { process.stderr.write('RECOVERY_INVALID\n'); process.exitCode = 2; }
    finally { clearTimeout(timer); key?.fill(0); }
  });
}
module.exports = { canonical, run };
