import { beforeEach, describe, expect, it, vi } from 'vitest';
import { digestBytes } from '@zerochack/care';
import { executeSecurityPermissionChange, permissionSnapshotDigest, type PermissionApproval, type PermissionSnapshot } from './security-permission-target.js';

const state = vi.hoisted(() => ({ mode: 0o100666, content: Buffer.from('approved static content'), symlink: '', changed: false, writes: 0, closed: 0, destroyed: 0, stall: false, rejectWrite: false, alterContent: false, calls: [] as string[] }));
vi.mock('../customer/ssh-toolkit.js', () => ({ connectSsh: async () => ({ client: {
  end() {}, destroy() { state.destroyed++; }, sftp(done: (error: undefined, channel: unknown) => void) {
    const stats = (path: string) => ({ uid: 1000, gid: 1000, mode: path.endsWith('index.html') ? state.mode : 0o40755, size: path.endsWith('index.html') ? state.content.length : 0, mtime: 100, isFile: () => path.endsWith('index.html'), isDirectory: () => !path.endsWith('index.html'), isSymbolicLink: () => path === state.symlink });
    done(undefined, {
      lstat(path: string, cb: (error: undefined, value: unknown) => void) { cb(undefined, stats(path)); },
      realpath(path: string, cb: (error: undefined, value: string) => void) { cb(undefined, path); },
      open(_path: string, flags: string, cb: (error: undefined, value: Buffer) => void) { state.calls.push(flags); cb(undefined, Buffer.from('h')); },
      fstat(_handle: Buffer, cb: (error: undefined, value: unknown) => void) { cb(undefined, stats('/srv/www/fixture/index.html')); },
      read(_handle: Buffer, buffer: Buffer, offset: number, length: number, position: number, cb: (error: undefined, size: number) => void) { const bytes = state.content.subarray(position, position + length); bytes.copy(buffer, offset); cb(undefined, bytes.length); },
      fchmod(_handle: Buffer, mode: number, cb: (error?: Error) => void) { state.writes++; state.mode = 0o100000 | mode; if (state.alterContent) state.content = Buffer.from('changed by third party'); if (state.stall) return; cb(state.rejectWrite ? new Error('reply lost') : undefined); },
      close(_handle: Buffer, cb: (error?: Error) => void) { state.closed++; cb(); }
    });
  }
} }) }));
const access = { host: 'fixture.example.test', port: 22, username: 'deploy', authMethod: 'PASSWORD', secret: 'synthetic-only', hostKeyFingerprint: 'SHA256:fixture-pin' };
const approved = (): PermissionApproval => ({ root: '/srv/www/fixture', path: '/srv/www/fixture/index.html', uid: 1000, gid: 1000, mode: 0o100666, size: Buffer.byteLength('approved static content'), mtime: 100, digest: digestBytes('approved static content'), exclusiveWriterConfirmed: true, singleLinkConfirmed: true });
const recovery = vi.fn(async (snapshot: PermissionSnapshot) => ({ artifactId: '33a72879-28af-4aa6-806b-c6f3597e194f', encrypted: true as const, verified: true as const, snapshotDigest: permissionSnapshotDigest(snapshot) }));
const authorize = vi.fn(async () => {});
const input = () => ({ access, approved: approved(), operation: 'HARDEN' as const, recovery, authorize });
beforeEach(() => { Object.assign(state, { mode: 0o100666, content: Buffer.from('approved static content'), symlink: '', writes: 0, closed: 0, destroyed: 0, stall: false, rejectWrite: false, alterContent: false, calls: [] }); authorize.mockReset(); authorize.mockResolvedValue(); recovery.mockClear(); });
describe('unavailable single-file permission executor', () => {
  it('removes only other-write with verified recovery and fresh authorization, then supports separately authorized restoration', async () => {
    expect(await executeSecurityPermissionChange(input())).toMatchObject({ state: 'VERIFIED', mode: 0o664 });
    expect(state.content.toString()).toBe('approved static content'); expect(state.calls).toEqual(['r']); expect(state.closed).toBe(1); expect(authorize).toHaveBeenCalledTimes(2); expect(recovery).toHaveBeenCalledTimes(1);
    expect(await executeSecurityPermissionChange({ ...input(), operation: 'RESTORE' })).toMatchObject({ state: 'VERIFIED', mode: 0o666 }); expect(state.writes).toBe(2);
  });
  it.each(['/etc/passwd', '/srv/www/fixture/../elsewhere/index.html', '/srv/www/fixture/.env', '/srv/www/fixture/wp-config.php', '/srv/www/fixture/key.pem', '/srv/www/fixture.zip'])('refuses unsafe path %s before SSH mutation', async (path) => {
    await expect(executeSecurityPermissionChange({ ...input(), approved: { ...approved(), path } })).rejects.toMatchObject({ code: 'PERMISSION_TARGET_UNSAFE' }); expect(state.writes).toBe(0);
  });
  it('requires the exclusive writer window and rejects special file bits and oversize inputs', async () => {
    for (const change of [{ exclusiveWriterConfirmed: false }, { singleLinkConfirmed: false }, { mode: 0o104666 }, { size: 200001 }]) await expect(executeSecurityPermissionChange({ ...input(), approved: { ...approved(), ...change } as PermissionApproval })).rejects.toMatchObject({ code: 'PERMISSION_TARGET_UNSAFE' });
  });
  it('refuses symlink ancestors, metadata drift and changed content without mutation', async () => {
    state.symlink = '/srv/www'; await expect(executeSecurityPermissionChange(input())).rejects.toMatchObject({ code: 'PERMISSION_TARGET_UNSAFE' });
    state.symlink = ''; state.mode = 0o100664; await expect(executeSecurityPermissionChange(input())).rejects.toMatchObject({ code: 'PERMISSION_DRIFT' });
    state.mode = 0o100666; state.content = Buffer.from('unapproved replacement'); await expect(executeSecurityPermissionChange(input())).rejects.toMatchObject({ code: 'PERMISSION_DRIFT' }); expect(state.writes).toBe(0);
  });
  it.each([{ uid: 1001 }, { gid: 1001 }, { mtime: 101 }, { size: 1 }])('refuses approved metadata drift %j', async (change) => {
    await expect(executeSecurityPermissionChange({ ...input(), approved: { ...approved(), ...change } })).rejects.toMatchObject({ code: 'PERMISSION_DRIFT' }); expect(state.writes).toBe(0);
  });
  it('rechecks source after recovery persistence and refuses a changed recovery snapshot', async () => {
    await expect(executeSecurityPermissionChange({ ...input(), recovery: async (snapshot) => { const artifact = await recovery(snapshot); state.mode = 0o100664; return artifact; } })).rejects.toMatchObject({ code: 'PERMISSION_DRIFT' }); expect(state.writes).toBe(0);
  });
  it('fails closed when verified recovery or fresh authorization is unavailable', async () => {
    await expect(executeSecurityPermissionChange({ ...input(), recovery: async (snapshot) => ({ artifactId: '33a72879-28af-4aa6-806b-c6f3597e194f', encrypted: true, verified: true, snapshotDigest: permissionSnapshotDigest({ ...snapshot, uid: 0 }) }) })).rejects.toMatchObject({ code: 'PERMISSION_RECOVERY_INVALID' });
    authorize.mockResolvedValueOnce().mockRejectedValueOnce(new Error('revoked'));
    await expect(executeSecurityPermissionChange(input())).rejects.toThrow(); expect(state.writes).toBe(0); expect(state.closed).toBe(2);
  });
  it.each(['rejectWrite', 'stall', 'alterContent'] as const)('records unknown outcome after %s, without replay or blind compensation', async (key) => {
    state[key] = true; await expect(executeSecurityPermissionChange(input(), { timeoutMs: 25 })).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' }); expect(state.writes).toBe(1); expect(state.destroyed).toBeGreaterThan(0);
  });
  it('bounds stalled recovery without starting mutation', async () => {
    await expect(executeSecurityPermissionChange({ ...input(), recovery: () => new Promise(() => {}) }, { timeoutMs: 25 })).rejects.toMatchObject({ code: 'PERMISSION_TIMEOUT' }); expect(state.writes).toBe(0);
  });
});
