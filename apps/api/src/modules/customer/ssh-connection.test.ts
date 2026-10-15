import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Server, utils, type Connection } from 'ssh2';
import { resolvePublicTarget } from '@zerochack/scanner';
import { connectSsh, type SshAccess } from './ssh-toolkit.js';

// Only this fixture replaces DNS. The production resolver still rejects private,
// loopback and mixed public/private answers. No fixture port is published.
vi.mock('@zerochack/scanner', () => ({ resolvePublicTarget: vi.fn() }));
const resolver = vi.mocked(resolvePublicTarget);
const key = () => generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
const hostKey = key(); const userKey = key();
const parsed = utils.parseKey(hostKey); if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid fixture key');
const pin = `SHA256:${createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=$/u, '')}`;
let server: Server | undefined; const connections = new Set<Connection>();
afterEach(async () => {
  vi.useRealTimers();
  for (const connection of connections) connection.end(); connections.clear();
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined; resolver.mockReset();
});
async function fixture() {
  let attempts = 0; let commands = 0;
  server = new Server({ hostKeys: [hostKey] }, connection => {
    connections.add(connection); connection.on('error', () => undefined);
    connection.on('close', () => connections.delete(connection));
    connection.on('authentication', context => {
      if (context.method === 'none') return context.reject(['password', 'publickey']);
      attempts++;
      if (context.username !== 'fixture') return context.reject();
      if (context.method === 'password' && context.password === 'synthetic-password') return context.accept();
      if (context.method === 'publickey') {
        const publicKey = utils.parseKey(userKey);
        if (!(publicKey instanceof Error) && !Array.isArray(publicKey) && publicKey.getPublicSSH().equals(context.key.data) && (!context.signature || publicKey.verify(context.blob!, context.signature, context.hashAlgo))) return context.accept();
      }
      context.reject();
    });
    connection.on('session', (_accept, reject) => { commands++; reject(); });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  resolver.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
  const access: SshAccess = { host: 'synthetic-ssh.example.test', port: address.port, username: 'fixture', authMethod: 'PASSWORD', secret: 'synthetic-password', hostKeyFingerprint: pin };
  return { access, attempts: () => attempts, commands: () => commands };
}
describe('pinned SSH protocol against an isolated real ssh2 server', () => {
  it('saves an explicitly approved first identity before sending the password', async () => {
    const target = await fixture(); let saved = '';
    const result = await connectSsh({ ...target.access, hostKeyFingerprint: null }, async observed => { expect(target.attempts()).toBe(0); saved = observed; return true; });
    result.client.end(); expect(saved.replace(/=$/u, '')).toBe(pin); expect(target.attempts()).toBe(1); expect(target.commands()).toBe(0);
  });
  it('rejects a changed stored identity before password authentication', async () => {
    const target = await fixture();
    await expect(connectSsh({ ...target.access, hostKeyFingerprint: null }, async () => false)).rejects.toMatchObject({ code: 'SSH_HOST_KEY_CHANGED' }); expect(target.attempts()).toBe(0);
  });
  it('fails closed when first-connection consent is missing or storage is unavailable', async () => {
    const target = await fixture();
    await expect(connectSsh({ ...target.access, hostKeyFingerprint: null }, async () => { throw Object.assign(new Error('fixture-only'), { code: 'HOST_IDENTITY_REQUIRED' }); })).rejects.toMatchObject({ code: 'HOST_IDENTITY_REQUIRED' }); expect(target.attempts()).toBe(0);
    await expect(connectSsh({ ...target.access, hostKeyFingerprint: null }, async () => { throw new Error('fixture-only-sensitive'); })).rejects.toMatchObject({ code: 'SSH_HOST_VERIFICATION_FAILED', message: 'SSH connection was not verified.' }); expect(target.attempts()).toBe(0);
  });
  it.each(['PASSWORD', 'SSH_KEY'])('authenticates %s without executing a command', async method => {
    const target = await fixture();
    const result = await connectSsh({ ...target.access, authMethod: method, secret: method === 'SSH_KEY' ? userKey : target.access.secret });
    expect(result.fingerprint.replace(/=$/u, '')).toBe(pin); result.client.end(); expect(target.attempts()).toBeGreaterThan(0); expect(target.commands()).toBe(0);
  });
  it('rejects an incorrect identity before sending authentication', async () => {
    const target = await fixture();
    await expect(connectSsh({ ...target.access, hostKeyFingerprint: `SHA256:${'a'.repeat(43)}` })).rejects.toMatchObject({ code: 'SSH_HOST_KEY_CHANGED' });
    expect(target.attempts()).toBe(0);
  });
  it('requires a trusted identity before resolving or connecting', async () => {
    const target = await fixture();
    await expect(connectSsh({ ...target.access, hostKeyFingerprint: null })).rejects.toMatchObject({ code: 'HOST_IDENTITY_REQUIRED' });
    expect(resolver).not.toHaveBeenCalled(); expect(target.attempts()).toBe(0);
  });
  it('does not retry rejected passwords and sanitizes the error', async () => {
    const target = await fixture();
    resolver.mockResolvedValue([{ address: '127.0.0.1', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    const error = await connectSsh({ ...target.access, secret: 'synthetic-rejected-password' }).catch(error => error);
    expect(error).toMatchObject({ code: 'SSH_AUTH_FAILED', message: 'SSH connection was not verified.' }); expect(target.attempts()).toBe(1); expect(String(error)).not.toContain('synthetic-rejected-password');
  });
  it('tries another validated address only after a transport failure', async () => {
    const target = await fixture();
    resolver.mockResolvedValue([{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }]);
    const result = await connectSsh(target.access); result.client.end(); expect(target.attempts()).toBe(1);
  });
  it('preserves resolver security rejections without attempting SSH', async () => {
    const target = await fixture(); resolver.mockRejectedValue(Object.assign(new Error('Unsafe target'), { code: 'PRIVATE_TARGET_BLOCKED' }));
    await expect(connectSsh(target.access)).rejects.toMatchObject({ code: 'PRIVATE_TARGET_BLOCKED' }); expect(target.attempts()).toBe(0);
  });
  it('rejects malformed private keys without leaking them', async () => {
    const target = await fixture();
    await expect(connectSsh({ ...target.access, authMethod: 'SSH_KEY', secret: 'synthetic-invalid-key' })).rejects.toMatchObject({ code: 'SSH_CREDENTIAL_FORMAT', message: 'SSH connection was not verified.' }); expect(target.attempts()).toBe(0);
  });
  it('bounds DNS stalls and releases the deadline timer', async () => {
    const target = await fixture(); vi.useFakeTimers(); resolver.mockImplementation(() => new Promise(() => undefined));
    const checked = expect(connectSsh(target.access)).rejects.toMatchObject({ code: 'SSH_DNS_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(5000); await checked; expect(vi.getTimerCount()).toBe(0); expect(target.attempts()).toBe(0);
  });
});
