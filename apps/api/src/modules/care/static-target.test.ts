import { beforeEach, describe, expect, it, vi } from 'vitest';
import { digestBytes } from '@zerochack/care';
import { openStaticTarget } from './static-target.js';

const state = vi.hoisted(() => ({ files: new Map<string, Buffer>(), handles: new Map<string, string>(), symlink: '', atomicSupported: true, renameCount: 0, nextHandle: 0 }));
vi.mock('../customer/ssh-toolkit.js', () => ({ connectSsh: async () => ({ client: {
  end() {}, destroy() {}, sftp(done: (error: undefined, sftp: unknown) => void) {
    done(undefined, {
      lstat(path: string, callback: (error: Error | undefined, value?: unknown) => void) {
        const bytes = state.files.get(path); const directory = ['/var','/var/www','/var/www/site'].includes(path);
        if (!bytes && !directory) return callback(Object.assign(new Error('missing'), { code: 2 }));
        callback(undefined, { mode: 0o100644, size: bytes?.length ?? 0, isFile: () => Boolean(bytes), isDirectory: () => directory, isSymbolicLink: () => path === state.symlink });
      },
      open(path: string, flags: string, attributesOrCallback: unknown, optionalCallback?: (error: Error | undefined, handle?: Buffer) => void) {
        const callback = (optionalCallback ?? attributesOrCallback) as (error: Error | undefined, handle?: Buffer) => void;
        if (flags === 'wx' && state.files.has(path)) return callback(new Error('exists'));
        if (flags === 'wx') state.files.set(path, Buffer.alloc(0));
        const handle = Buffer.from(String(++state.nextHandle)); state.handles.set(handle.toString(), path); callback(undefined, handle);
      },
      read(handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, callback: (error: undefined, bytes: number) => void) {
        const source = state.files.get(state.handles.get(handle.toString())!)!; const bytes = source.subarray(position, position + length); bytes.copy(buffer, offset); callback(undefined, bytes.length);
      },
      write(handle: Buffer, buffer: Buffer, offset: number, length: number, _position: number, callback: (error?: Error) => void) { state.files.set(state.handles.get(handle.toString())!, Buffer.from(buffer.subarray(offset, offset + length))); callback(); },
      close(handle: Buffer, callback: (error?: Error) => void) { state.handles.delete(handle.toString()); callback(); },
      unlink(path: string, callback: (error?: Error) => void) { state.files.delete(path); callback(); },
      ext_openssh_rename(from: string, to: string, callback: (error?: Error) => void) { if (!state.atomicSupported) return callback(new Error('extension unsupported')); state.renameCount++; state.files.set(to, state.files.get(from)!); state.files.delete(from); callback(); }
    });
  }
}, fingerprint: 'fixture' }) }));
const path = '/var/www/site/index.html'; const releaseId = '33a72879-28af-4aa6-806b-c6f3597e194f';
const access = { host: 'server.example.com', port: 22, username: 'deploy', authMethod: 'PASSWORD', secret: 'synthetic-only', hostKeyFingerprint: 'fixture' };
beforeEach(() => { state.files.clear(); state.handles.clear(); state.files.set(path, Buffer.from('original')); state.symlink = ''; state.atomicSupported = true; state.renameCount = 0; });
describe('SFTP single-file transport contract', () => {
  it('serializes replacement and recovery, and cleans only its own lock', async () => {
    const target = await openStaticTarget(access, path, releaseId); await target.lock();
    await target.replace(Buffer.from('candidate'), digestBytes('original')); expect((await target.read()).toString()).toBe('candidate');
    await target.replace(Buffer.from('original'), digestBytes('candidate')); expect((await target.read()).toString()).toBe('original');
    expect(state.renameCount).toBe(2); await target.unlock(); await target.unlock(); expect(state.files.has(`${path}.zeroroot.lock`)).toBe(false);
  });
  it('refuses a symlink directory and never removes another release lock', async () => {
    state.symlink = '/var/www'; const target = await openStaticTarget(access, path, releaseId); await expect(target.lock()).rejects.toMatchObject({ code: 'TARGET_PATH_UNSAFE' });
    state.symlink = ''; state.files.set(`${path}.zeroroot.lock`, Buffer.from('another release'));
    await expect(target.lock()).rejects.toThrow(); await expect(target.unlock()).rejects.toMatchObject({ code: 'TARGET_LOCK_LOST' }); expect(state.files.get(`${path}.zeroroot.lock`)?.toString()).toBe('another release'); expect(state.renameCount).toBe(0);
  });
  it('detects drift immediately before atomic replacement', async () => {
    const target = await openStaticTarget(access, path, releaseId); await target.lock(); state.files.set(path, Buffer.from('external edit'));
    await expect(target.replace(Buffer.from('candidate'), digestBytes('original'))).rejects.toMatchObject({ code: 'SOURCE_DRIFT' }); expect(state.files.get(path)?.toString()).toBe('external edit'); expect(state.renameCount).toBe(0);
  });
  it('requires atomic overwrite support without deleting the original', async () => {
    const target = await openStaticTarget(access, path, releaseId); await target.lock(); state.atomicSupported = false;
    await expect(target.replace(Buffer.from('candidate'), digestBytes('original'))).rejects.toThrow(); expect(state.files.get(path)?.toString()).toBe('original'); expect(state.renameCount).toBe(0);
  });
  it('rechecks authorization immediately before committing the staged file', async () => {
    const target = await openStaticTarget(access, path, releaseId); await target.lock();
    await expect(target.replace(Buffer.from('candidate'), digestBytes('original'), async () => { throw new Error('authority expired'); })).rejects.toThrow('authority expired');
    expect(state.files.get(path)?.toString()).toBe('original'); expect(state.renameCount).toBe(0);
  });
});
