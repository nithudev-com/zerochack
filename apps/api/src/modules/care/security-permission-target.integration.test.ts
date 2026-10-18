import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync, chmodSync, statSync, fstatSync, openSync, readSync, fchmodSync, closeSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, Server, type SFTPWrapper } from 'ssh2';
import type { SshAccess } from '../customer/ssh-toolkit.js';
import { digestBytes, openSecret, sealSecret } from '@zerochack/care';
import { executeSecurityPermissionChange, permissionSnapshotDigest, type PermissionApproval, type PermissionSnapshot } from './security-permission-target.js';

/** Disposable loopback SSH/SFTP protocol fixture; never a customer target or production database.
 * The virtual /srv/www/permission-fixture tree maps to this test's mkdtemp directory only.
 */
let directory: string; let file: string; let server: Server; let port: number;
const virtualRoot = '/srv/www/permission-fixture'; const virtualFile = `${virtualRoot}/index.html`;
const handles = new Map<string, number>(); const clients = new Set<Client>();
let nextHandle = 0; let changedIdentity = false;
const expectedFingerprint = (key: Buffer) => `SHA256:${createHash('sha256').update(key).digest('base64')}`;
let publicFingerprint: string;
function serve(channel: SFTPWrapper) {
  const attrs = (fd?: number) => { const info = fd === undefined ? statSync(file) : fstatSync(fd); return { mode: info.mode, uid: info.uid, gid: info.gid, size: info.size, atime: Math.floor(info.atimeMs / 1000), mtime: Math.floor(info.mtimeMs / 1000) }; };
  const status = (id: number, action: () => void) => { try { action(); channel.status(id, 0); } catch { channel.status(id, 4); } };
  channel.on('LSTAT', (id: number, path: string) => {
    if (path === virtualFile) channel.attrs(id, attrs());
    else if (['/srv', '/srv/www', virtualRoot].includes(path)) channel.attrs(id, { mode: 0o40755, uid: 0, gid: 0, size: 0, atime: 100, mtime: 100 });
    else channel.status(id, 2);
  });
  channel.on('REALPATH', (id: number, path: string) => { if ([virtualFile, virtualRoot].includes(path)) channel.name(id, [{ filename: path, longname: path, attrs: path === virtualFile ? attrs() : { mode: 0o40755, uid: 0, gid: 0, size: 0, atime: 100, mtime: 100 } }]); else channel.status(id, 2); });
  channel.on('OPEN', (id: number, path: string, flags: number) => { if (path !== virtualFile || flags !== 1) return channel.status(id, 3); const key = String(++nextHandle); handles.set(key, openSync(file, 'r')); channel.handle(id, Buffer.from(key)); });
  channel.on('FSTAT', (id: number, handle: Buffer) => { const fd = handles.get(handle.toString()); if (fd === undefined) return channel.status(id, 4); channel.attrs(id, attrs(fd)); });
  channel.on('READ', (id: number, handle: Buffer, offset: number, length: number) => { const fd = handles.get(handle.toString()); if (fd === undefined || length > 200001) return channel.status(id, 4); const bytes = Buffer.alloc(length); const count = readSync(fd, bytes, 0, length, offset); if (!count) channel.status(id, 1); else channel.data(id, bytes.subarray(0, count)); });
  channel.on('FSETSTAT', (id: number, handle: Buffer, attributes: { mode?: number }) => status(id, () => { const fd = handles.get(handle.toString()); if (fd === undefined || attributes.mode === undefined || Object.entries(attributes).some(([key, value]) => key !== 'mode' && value !== undefined)) throw new Error('unsupported'); fchmodSync(fd, attributes.mode); }));
  channel.on('CLOSE', (id: number, handle: Buffer) => status(id, () => { const fd = handles.get(handle.toString()); if (fd === undefined) throw new Error('missing'); closeSync(fd); handles.delete(handle.toString()); }));
}
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'codebandage-permission-sftp-')); file = join(directory, 'index.html'); writeFileSync(file, 'approved fixture content'); chmodSync(file, 0o666);
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  server = new Server({ hostKeys: [privateKey] }, (connection) => {
    connection.on('authentication', (context) => { if (context.method === 'password' && context.username === 'fixture' && context.password === 'synthetic-fixture-password') context.accept(); else context.reject(); });
    connection.on('ready', () => connection.on('session', (accept) => { const session = accept(); session.on('sftp', (acceptSftp) => serve(acceptSftp())); session.on('exec', (_accept, reject) => reject()); }));
    connection.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address unavailable'); port = address.port;
  // Pin the fixture's generated public host key independently from the tested connection.
  const { utils } = await import('ssh2'); const key = utils.parseKey(privateKey); if (key instanceof Error || Array.isArray(key)) throw new Error('fixture key unavailable'); publicFingerprint = expectedFingerprint(key.getPublicSSH());
});
afterAll(async () => { for (const client of clients) client.destroy(); for (const fd of handles.values()) try { closeSync(fd); } catch { /* Already closed. */ } handles.clear(); await new Promise<void>((resolve) => server.close(() => resolve())); if (directory) rmSync(directory, { recursive: true, force: true }); });
const access = () => ({ host: '127.0.0.1', port, username: 'fixture', authMethod: 'PASSWORD', secret: 'synthetic-fixture-password', hostKeyFingerprint: publicFingerprint });
async function connectFixture(input: SshAccess) {
  const client = new Client(); clients.add(client);
  await new Promise<void>((resolve, reject) => { client.once('error', reject); client.once('ready', resolve); client.connect({ host: input.host, port: input.port, username: input.username, password: input.secret, hostVerifier: (key: Buffer) => expectedFingerprint(key) === (changedIdentity ? 'wrong-pin' : input.hostKeyFingerprint), readyTimeout: 2000 }); });
  return { client, fingerprint: publicFingerprint };
}
function approval(): PermissionApproval { const info = statSync(file); expect(info.nlink).toBe(1); return { root: virtualRoot, path: virtualFile, uid: info.uid, gid: info.gid, mode: info.mode, size: info.size, mtime: Math.floor(info.mtimeMs / 1000), digest: digestBytes(readFileSync(file)), exclusiveWriterConfirmed: true, singleLinkConfirmed: true }; }
async function recovery(snapshot: PermissionSnapshot, bytes: Buffer) {
  const context = { id: '33a72879-28af-4aa6-806b-c6f3597e194f', tenantId: 'synthetic', websiteId: 'synthetic', environment: 'TEST', version: 1 }; const key = Buffer.alloc(32, 7).toString('base64');
  const encrypted = sealSecret(JSON.stringify({ snapshot, base64: bytes.toString('base64') }), context, key); const restored = JSON.parse(openSecret(encrypted, context, { v1: key }));
  expect(digestBytes(Buffer.from(restored.base64, 'base64'))).toBe(snapshot.digest); expect(restored.snapshot).toEqual(snapshot);
  return { artifactId: context.id, encrypted: true as const, verified: true as const, snapshotDigest: permissionSnapshotDigest(snapshot) };
}
describe.sequential('actual disposable pinned SSH/SFTP permission protocol', () => {
  it('hardens actual filesystem permissions and restores only with a separate authority check and verified encrypted recovery', async () => {
    const approved = approval(); const calls: string[] = []; const authorize = async (operation: string) => { calls.push(operation); };
    expect(await executeSecurityPermissionChange({ access: access(), approved, operation: 'HARDEN', authorize, recovery }, { connect: connectFixture })).toMatchObject({ state: 'VERIFIED', mode: 0o664 });
    expect(statSync(file).mode & 0o777).toBe(0o664); expect(readFileSync(file, 'utf8')).toBe('approved fixture content');
    expect(await executeSecurityPermissionChange({ access: access(), approved, operation: 'RESTORE', authorize, recovery }, { connect: connectFixture })).toMatchObject({ state: 'VERIFIED', mode: 0o666 });
    expect(statSync(file).mode & 0o777).toBe(0o666); expect(calls).toEqual(['HARDEN', 'HARDEN', 'RESTORE', 'RESTORE']); expect(handles.size).toBe(0);
  }, 20_000);
  it('rejects a changed SSH server key without changing the file', async () => {
    changedIdentity = true; try { await expect(executeSecurityPermissionChange({ access: access(), approved: approval(), operation: 'HARDEN', authorize: async () => {}, recovery }, { connect: connectFixture })).rejects.toThrow(); } finally { changedIdentity = false; }
    expect(statSync(file).mode & 0o777).toBe(0o666);
  });
});
