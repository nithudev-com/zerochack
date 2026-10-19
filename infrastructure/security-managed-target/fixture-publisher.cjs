'use strict';
// DISPOSABLE trusted static publication fixture. Never executes PHP/customer source.
const fs = require('node:fs');
const http = require('node:http');
const { createHash } = require('node:crypto');
if (process.env.MANAGED_TARGET_DISPOSABLE_FIXTURE !== '1' || process.getuid() === 0) throw new Error('FIXTURE_ONLY');
const status = fs.readFileSync('/proc/self/status', 'ascii');
if (!/^CapEff:\s+0+$/m.test(status) || !/^NoNewPrivs:\s+1$/m.test(status)) throw new Error('PUBLISHER_BOUNDARY_INVALID');
const target = '/published/index.html';
const original = fs.readFileSync(target);
const before = fs.statSync(target, { bigint: true });
const proof = {};
function denied(name, callback) {
  try { callback(); throw new Error('PUBLISHER_WRITABLE'); }
  catch (error) { if (error.code !== 'EROFS') throw new Error('READONLY_MOUNT_NOT_PROVEN'); proof[name] = 'EROFS'; }
}
denied('write', () => { const fd = fs.openSync(target, fs.constants.O_WRONLY); try { fs.writeSync(fd, Buffer.from('x'), 0, 1, 0); } finally { fs.closeSync(fd); } });
denied('chmod', () => fs.chmodSync(target, 0o600));
denied('rename', () => fs.renameSync(target, '/published/changed.html'));
denied('hardlink', () => fs.linkSync(target, '/published/link.html'));
const after = fs.statSync(target, { bigint: true });
if (before.ino !== after.ino || before.dev !== after.dev || after.nlink !== 1n || !original.equals(fs.readFileSync(target))) throw new Error('PUBLISHER_CHANGED_TARGET');
const server = http.createServer((request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') { response.writeHead(405).end(); return; }
  if (request.url === '/fixture-readonly-proof') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ proof, uid: process.getuid(), initialDigest: createHash('sha256').update(original).digest('hex') })); return;
  }
  if (request.url !== '/') { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(fs.readFileSync(target));
});
server.listen(8080, '0.0.0.0', () => process.stdout.write('MANAGED_STATIC_READONLY_PUBLICATION_READY\n'));
process.once('SIGTERM', () => server.close(() => process.exit(0)));
