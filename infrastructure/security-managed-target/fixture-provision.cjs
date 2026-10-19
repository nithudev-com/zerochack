'use strict';

// Trusted test provisioner. Constant fresh fixture location, no supplied customer path.
const fs = require('node:fs');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { utils } = require('ssh2');
const { canonical } = require('./recovery-codec.cjs');
const ROOT = '/fixture-private';
const PROFILE = createHash('sha256').update('codebandage/managed-static-v1/fresh-root0700/site0755/index.html/root-owner/readonly-publisher/one-helper/no-docker-socket').digest('hex');
function identity(path) { const info = fs.statSync(path, { bigint: true }); return { device: String(info.dev), inode: String(info.ino) }; }
function file(path, bytes, mode) {
  const fd = fs.openSync(path, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, bytes); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function directory(path, mode) { fs.mkdirSync(path, { mode }); fs.chmodSync(path, mode); }
if (process.getuid() !== 0 || process.env.MANAGED_TARGET_DISPOSABLE_FIXTURE !== '1') throw new Error('FIXTURE_ONLY');
const root = fs.lstatSync(ROOT);
if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== 0 || root.gid !== 0 || (root.mode & 0o7777) !== 0o700 || fs.readdirSync(ROOT).length !== 0) throw new Error('FRESH_FIXTURE_REQUIRED');
process.umask(0o077);
for (const name of ['backing','state','config','ssh','control']) directory(`${ROOT}/${name}`, 0o700);
directory(`${ROOT}/backing/site`, 0o755);
file(`${ROOT}/backing/site/index.html`, '<!doctype html><title>Managed static fixture</title><p>Synthetic CodeBandage fixture. No customer data.</p>\n', 0o666);
file(`${ROOT}/state/lock`, '', 0o600);
const namespaceId = randomUUID(); const targetId = randomUUID();
const scope = { tenantId: randomUUID(), websiteId: randomUUID(), environment: 'STAGING', runId: randomUUID() };
const permitKey = randomBytes(32); const recoveryKey = randomBytes(32);
if (permitKey.equals(recoveryKey)) throw new Error('INDEPENDENT_KEYS_REQUIRED');
file(`${ROOT}/config/permit.key`, permitKey, 0o400);
file(`${ROOT}/config/recovery.key`, recoveryKey, 0o400);
// Control copy is mounted ONLY into the trusted test client, never the publisher/model.
file(`${ROOT}/control/permit.key`, permitKey, 0o400);
permitKey.fill(0); recoveryKey.fill(0);
const host = utils.generateKeyPairSync('ed25519'); const client = utils.generateKeyPairSync('ed25519');
file(`${ROOT}/ssh/host.key`, host.private, 0o400);
file(`${ROOT}/ssh/client.pub`, client.public, 0o400);
file(`${ROOT}/control/client.key`, client.private, 0o400);
const parsed = utils.parseKey(host.public);
if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('FIXTURE_HOST_KEY_INVALID');
const fingerprint = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/, '')}`;
const manifest = { version: 1, adapter: 'MANAGED_STATIC_PERMISSION_V1', namespaceId, targetId,
  scope: { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: 'STAGING' }, profileDigest: PROFILE,
  root: identity(`${ROOT}/backing`), site: identity(`${ROOT}/backing/site`), state: identity(`${ROOT}/state`), target: identity(`${ROOT}/backing/site/index.html`) };
file(`${ROOT}/config/manifest.json`, canonical(manifest), 0o400);
file(`${ROOT}/control/fixture.json`, canonical({ namespaceId, targetId, scope, fingerprint }), 0o400);
for (const name of ['backing/site','backing','state','config','ssh','control','']) {
  const fd = fs.openSync(`${ROOT}/${name}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
process.stdout.write('FRESH_MANAGED_STATIC_FIXTURE_PROVISIONED\n');
