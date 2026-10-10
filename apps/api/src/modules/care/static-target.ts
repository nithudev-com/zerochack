import type { SFTPWrapper, Stats } from 'ssh2';
import { assertStaticTarget, CareError, digestBytes, MAX_SOURCE_BYTES } from '@zerochack/care';
import { connectSsh, type SshAccess } from '../customer/ssh-toolkit.js';

/** Single configured file only. Never executes a shell or accepts model-supplied paths. */
export interface StaticTarget {
  lock(): Promise<void>;
  read(): Promise<Buffer>;
  replace(bytes: Buffer, expectedDigest: string, beforeCommit?: () => Promise<void>): Promise<void>;
  unlock(): Promise<void>;
  close(): void;
}
export async function openStaticTarget(access: SshAccess, path: string, releaseId: string): Promise<StaticTarget> {
  assertStaticTarget(path);
  if (!access.hostKeyFingerprint || !/^[a-f0-9-]{36}$/.test(releaseId)) throw new CareError('TARGET_UNVERIFIED', 'A pinned host and release identity are required.');
  const { client } = await connectSsh(access);
  function call<T>(start: (done: (error: Error | undefined | null, value: T) => void) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { client.destroy(); reject(new CareError('TARGET_TIMEOUT', 'The remote operation timed out; reconcile before retrying.')); }, 10000);
      try { start((error, value) => { clearTimeout(timeout); if (error) reject(new CareError('TARGET_OPERATION_FAILED', 'The configured SFTP operation failed.')); else resolve(value); }); }
      catch { clearTimeout(timeout); reject(new CareError('TARGET_OPERATION_FAILED', 'The configured SFTP operation is unsupported.')); }
    });
  }
  let sftp: SFTPWrapper;
  try { sftp = await call<SFTPWrapper>((done) => client.sftp(done)); } catch (error) { client.end(); throw error; }
  const lockPath = `${path}.zeroroot.lock`; const temporary = `${path}.zeroroot-${releaseId}`; let ownsLock = false;
  const stat = (file: string) => call<Stats>((done) => sftp.lstat(file, done));
  const close = (handle: Buffer) => call<void>((done) => sftp.close(handle, (error) => done(error, undefined)));
  async function ancestors() {
    const parts = path.split('/').slice(1, -1); let current = '';
    for (const part of parts) { current += `/${part}`; const info = await stat(current); if (!info.isDirectory() || info.isSymbolicLink()) throw new CareError('TARGET_PATH_UNSAFE', 'Every target directory must be a real directory.'); }
  }
  async function read(file: string, limit: number) {
    const info = await stat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new CareError('TARGET_PATH_UNSAFE', 'The configured target must be a bounded regular file.');
    const handle = await call<Buffer>((done) => sftp.open(file, 'r', done));
    try {
      const bytes = Buffer.alloc(limit + 1); let offset = 0;
      while (offset < bytes.length) { const count = await call<number>((done) => sftp.read(handle, bytes, offset, bytes.length - offset, offset, (error, length) => done(error, length))); if (!count) break; offset += count; }
      if (offset > limit) throw new CareError('TARGET_SIZE', 'The remote file exceeds its approved size limit.');
      return bytes.subarray(0, offset);
    } finally { await close(handle); }
  }
  async function create(file: string, bytes: Buffer, mode: number) {
    const handle = await call<Buffer>((done) => sftp.open(file, 'wx', { mode }, done));
    try { await call<void>((done) => sftp.write(handle, bytes, 0, bytes.length, 0, (error) => done(error, undefined))); }
    finally { await close(handle); }
  }
  return {
    async lock() { await ancestors(); await create(lockPath, Buffer.from(releaseId), 0o600); ownsLock = true; },
    async read() { await ancestors(); return read(path, MAX_SOURCE_BYTES); },
    async replace(bytes, expectedDigest, beforeCommit) {
      if (!ownsLock || (await read(lockPath, 100)).toString() !== releaseId) throw new CareError('TARGET_LOCK_LOST', 'The release lock is unavailable.');
      await ancestors();
      if (bytes.length > MAX_SOURCE_BYTES) throw new CareError('TARGET_SIZE', 'The candidate exceeds its size limit.');
      const mode = (await stat(path)).mode & 0o666;
      await create(temporary, bytes, mode);
      if (digestBytes(await read(temporary, MAX_SOURCE_BYTES)) !== digestBytes(bytes)) throw new CareError('TARGET_INTEGRITY', 'The uploaded candidate failed integrity validation.');
      if (digestBytes(await read(path, MAX_SOURCE_BYTES)) !== expectedDigest) throw new CareError('SOURCE_DRIFT', 'The live source changed. No replacement was made.');
      await beforeCommit?.();
      // Requires the OpenSSH atomic overwrite extension. There is intentionally no unlink/rename fallback.
      await call<void>((done) => sftp.ext_openssh_rename(temporary, path, (error) => done(error, undefined)));
    },
    async unlock() {
      const exists = await call<boolean>((done) => sftp.lstat(lockPath, (error) => { if (error && 'code' in error && error.code === 2) done(null, false); else done(error, true); }));
      if (!exists) { ownsLock = false; return; }
      if ((await read(lockPath, 100)).toString() !== releaseId) throw new CareError('TARGET_LOCK_LOST', 'A different release owns the remote lock.');
      await call<void>((done) => sftp.unlink(lockPath, (error) => done(error, undefined))); ownsLock = false;
    },
    close() { client.end(); }
  };
}
