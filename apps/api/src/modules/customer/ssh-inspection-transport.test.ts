import { EventEmitter } from 'node:events';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { Client, Server, utils, type Connection } from 'ssh2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectServerReadOnly, serverInspectionScript } from './ssh-toolkit.js';

const validOutput = ['PLATFORM\tLinux fixture', 'ROOT\t/synthetic-fixture\t', 'SCANNED_FILES\t1', 'SCAN_LIMIT_REACHED\t0', 'MALWARE_SCANNER\tCLAMAV', 'MALWARE_STATUS\tCOMPLETED', 'INSPECTION_COMPLETE\tssh-inspection-v3'].join('\n');
type TestStream = EventEmitter & { stderr: EventEmitter; close: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
function fixture(response: (stream: TestStream) => void) {
  const stream = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), close: vi.fn(), end: vi.fn() });
  stream.end.mockImplementation((script: string) => { expect(script).toBe(serverInspectionScript); queueMicrotask(() => response(stream)); });
  const exec = vi.fn((command, callback) => { expect(command).toBe('LC_ALL=C sh -s'); callback(null, stream); });
  return { stream, client: { exec } as unknown as Client };
}
afterEach(() => vi.useRealTimers());

describe('bounded SSH inspection transport result honesty', () => {
  it('accepts explicit zero exit plus the complete validated protocol', async () => {
    const target = fixture(stream => { stream.emit('data', Buffer.from(validOutput)); stream.emit('exit', 0); stream.emit('close'); });
    await expect(inspectServerReadOnly(target.client)).resolves.toMatchObject({ coverageState: 'BOUNDED', scannedFiles: 1 });
  });
  it.each([undefined, null, 1, 126, 137])('rejects close with exit %s even if output claims completion', async code => {
    const target = fixture(stream => { stream.emit('data', Buffer.from(validOutput)); if (code !== undefined) stream.emit('exit', code); stream.emit('close'); });
    await expect(inspectServerReadOnly(target.client)).rejects.toMatchObject({ code: code === undefined ? 'SSH_INSPECTION_INCOMPLETE' : 'SSH_INSPECTION_FAILED' });
    expect(target.stream.close).toHaveBeenCalledOnce();
  });
  it('does not interpret a zero-exit empty or truncated protocol as a clean scan', async () => {
    const target = fixture(stream => { stream.emit('data', Buffer.from('PLATFORM\tLinux fixture\n')); stream.emit('exit', 0); stream.emit('close'); });
    await expect(inspectServerReadOnly(target.client)).rejects.toMatchObject({ code: 'SSH_INSPECTION_INCOMPLETE' });
  });
  it.each(['stdout','stderr'])('bounds %s instead of silently truncating it', async channel => {
    const target = fixture(stream => { const source = channel === 'stdout' ? stream : stream.stderr; source.emit('data', Buffer.alloc(1_048_577, 120)); stream.emit('exit', 0); stream.emit('close'); });
    await expect(inspectServerReadOnly(target.client)).rejects.toMatchObject({ code: 'SSH_INSPECTION_OUTPUT_LIMIT' });
    expect(target.stream.close).toHaveBeenCalledOnce();
  });
  it('redacts raw command and stream failures', async () => {
    const target = fixture(stream => { stream.emit('error', new Error('fixture-sensitive-command-error')); });
    const error = await inspectServerReadOnly(target.client).catch(error => error);
    expect(error).toMatchObject({ code: 'SSH_INSPECTION_FAILED' }); expect(String(error)).not.toContain('fixture-sensitive');
    const client = { exec: (_command: string, callback: (error: Error) => void) => callback(new Error('fixture-sensitive-rejection')) } as unknown as Client;
    const rejected = await inspectServerReadOnly(client).catch(error => error);
    expect(rejected).toMatchObject({ code: 'SSH_INSPECTION_FAILED' }); expect(String(rejected)).not.toContain('fixture-sensitive');
  });
  it('closes a stalled channel at its deadline without successful evidence', async () => {
    vi.useFakeTimers(); const target = fixture(() => undefined);
    const checked = expect(inspectServerReadOnly(target.client)).rejects.toMatchObject({ code: 'SSH_INSPECTION_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(120000); await checked;
    expect(target.stream.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('inspection evidence over the actual isolated SSH protocol', () => {
  it.each([[0,true], [2,true], [0,false]] as const)('checks real SSH exit %s and completion %s', async (exitCode, complete) => {
    const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
    const parsed = utils.parseKey(privateKey); if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('Invalid synthetic host key');
    const pinned = createHash('sha256').update(parsed.getPublicSSH()).digest('base64');
    const connections = new Set<Connection>(); let receivedScript = '';
    const server = new Server({ hostKeys: [privateKey] }, connection => {
      connections.add(connection); connection.on('error', () => undefined);
      connection.on('authentication', context => { if (context.method === 'password' && context.username === 'fixture' && context.password === 'synthetic-only') context.accept(); else context.reject(); });
      connection.on('ready', () => connection.on('session', (accept) => {
        const session = accept(); session.on('exec', (acceptCommand, rejectCommand, info) => {
          if (info.command !== 'LC_ALL=C sh -s') { rejectCommand(); return; }
          const channel = acceptCommand();
          channel.on('data', (chunk: Buffer) => { receivedScript += chunk.toString('utf8'); });
          channel.on('end', () => {
            channel.write(complete ? validOutput : validOutput.replace('INSPECTION_COMPLETE\tssh-inspection-v3', ''));
            channel.exit(exitCode); channel.end();
          });
        });
      }));
    });
    const client = new Client();
    try {
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing synthetic SSH port');
      await new Promise<void>((resolve, reject) => {
        client.once('error', reject); client.once('ready', resolve);
        client.connect({ host: '127.0.0.1', port: address.port, username: 'fixture', password: 'synthetic-only', readyTimeout: 2000, hostVerifier: (key: Buffer) => createHash('sha256').update(key).digest('base64') === pinned });
      });
      const result = inspectServerReadOnly(client);
      if (exitCode !== 0) await expect(result).rejects.toMatchObject({ code: 'SSH_INSPECTION_FAILED' });
      else if (!complete) await expect(result).rejects.toMatchObject({ code: 'SSH_INSPECTION_INCOMPLETE' });
      else await expect(result).resolves.toMatchObject({ scannedFiles: 1, coverageState: 'BOUNDED' });
      expect(receivedScript).toBe(serverInspectionScript);
    } finally {
      client.destroy(); for (const connection of connections) connection.end();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
