import type { SFTPWrapper, Stats } from 'ssh2';
import { CareError, digestBytes } from '@zerochack/care';
import { connectSsh, type SshAccess } from '../customer/ssh-toolkit.js';

/** Server-only, unavailable product primitive. No shell, traversal, model paths or automatic retries.
 * SFTP v3 has no openat/O_NOFOLLOW/CAS or inode identity. A trusted operator MUST exclude
 * all other writers/renames (including application writers) for the complete operation.
 * A trusted operator must independently verify a single-link target: SFTP v3 omits nlink/inode.
 * Hostile concurrent writers are unsupported; metadata checks cannot enforce these assumptions.
 */
export type PermissionSnapshot = { root: string; path: string; uid: number; gid: number; mode: number; size: number; mtime: number; digest: string };
export type PermissionApproval = PermissionSnapshot & { exclusiveWriterConfirmed: true; singleLinkConfirmed: true };
export type PermissionRecovery = { artifactId: string; encrypted: true; verified: true; snapshotDigest: string };
type Dependencies = { connect?: typeof connectSsh; timeoutMs?: number };
type Authority = (operation: 'HARDEN' | 'RESTORE', approved: PermissionSnapshot) => Promise<void>;
const maximumBytes = 200_000;
const fullMode = 0o177777;

function failure(code: string) { return new CareError(code, code === 'OUTCOME_UNKNOWN' ? 'Permission mutation may have occurred. Reconcile the exact file; do not retry or blindly restore.' : 'The bounded permission operation was refused.'); }
export const permissionSnapshotDigest = (snapshot: PermissionSnapshot) => digestBytes(JSON.stringify([snapshot.root, snapshot.path, snapshot.uid, snapshot.gid, snapshot.mode, snapshot.size, snapshot.mtime, snapshot.digest]));
function validate(approved: PermissionApproval) {
  const segments = (value: string) => /^\/(?:[a-zA-Z0-9_-][a-zA-Z0-9._-]*\/)*[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(value);
  const forbidden = /(?:^|\/)(?:\.\.?|\.ssh|\.env[^/]*|wp-config\.php|configuration\.php|config\.(?:php|json|ya?ml)|passwd|shadow|authorized_keys|id_[^/]+)(?:\/|$)|\.(?:pem|key|sql|bak|zip|gz|tar)$/i;
  if (approved.exclusiveWriterConfirmed !== true || approved.singleLinkConfirmed !== true || !segments(approved.root) || !segments(approved.path) || approved.root.split('/').length < 3 || !/^\/(?:var\/www|srv\/www|home\/[^/]+\/[^/]+)(?:\/|$)/.test(approved.root) || !approved.path.startsWith(`${approved.root}/`) || forbidden.test(approved.path) || !Number.isSafeInteger(approved.mode) || (approved.mode & fullMode) !== approved.mode || (approved.mode & 0o170000) !== 0o100000 || (approved.mode & 0o7000) !== 0 || ![approved.uid, approved.gid, approved.size, approved.mtime].every((value) => Number.isSafeInteger(value) && value >= 0) || approved.size > maximumBytes || !/^[a-f0-9]{64}$/.test(approved.digest)) throw failure('PERMISSION_TARGET_UNSAFE');
}
function matches(stats: Stats, approved: PermissionSnapshot, mode: number) { return stats.isFile() && !stats.isSymbolicLink() && stats.uid === approved.uid && stats.gid === approved.gid && stats.size === approved.size && stats.mtime === approved.mtime && stats.mode === mode; }

/** Caller must bind authority to the exact pinned access identity/version and current actor scope.
 * The two filesystem attestations require independent operator evidence, not a customer checkbox.
 * Recovery callback must persist, decrypt and verify encrypted bytes+metadata, never just metadata.
 * Reconciliation is observation only. Restore is a NEW explicit operation, not automatic rollback.
 */
export async function executeSecurityPermissionChange(input: { access: SshAccess; approved: PermissionApproval; operation: 'HARDEN' | 'RESTORE'; authorize: Authority; recovery: (snapshot: PermissionSnapshot, bytes: Buffer) => Promise<PermissionRecovery> }, dependencies: Dependencies = {}) {
  const approved = Object.freeze({ ...input.approved }); const operation = input.operation; validate(approved);
  if (!input.access.hostKeyFingerprint || !['HARDEN', 'RESTORE'].includes(operation) || !(approved.mode & 0o002)) throw failure('PERMISSION_TARGET_UNSAFE');
  const expectedMode = operation === 'HARDEN' ? approved.mode : approved.mode & ~0o002;
  const targetMode = operation === 'HARDEN' ? approved.mode & ~0o002 : approved.mode;
  const snapshot: PermissionSnapshot = Object.freeze({ root: approved.root, path: approved.path, uid: approved.uid, gid: approved.gid, mode: approved.mode, size: approved.size, mtime: approved.mtime, digest: approved.digest });
  const timeoutMs = dependencies.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw failure('PERMISSION_TARGET_UNSAFE');
  let authorityTimer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([input.authorize(operation, snapshot), new Promise<never>((_resolve, reject) => { authorityTimer = setTimeout(() => reject(failure('PERMISSION_TIMEOUT')), timeoutMs); })]); }
  finally { clearTimeout(authorityTimer); }
  const { client } = await (dependencies.connect ?? connectSsh)(input.access);
  let mutated = false; let stopped = false; let handle: Buffer | undefined;
  const deadline = Date.now() + timeoutMs;
  const timer = setTimeout(() => { stopped = true; client.destroy(); }, timeoutMs);
  function call<T>(start: (done: (error: Error | null | undefined, value: T) => void) => void): Promise<T> {
    if (stopped || Date.now() >= deadline) return Promise.reject(failure('PERMISSION_TIMEOUT'));
    return new Promise((resolve, reject) => {
      const pending = setTimeout(() => { stopped = true; client.destroy(); reject(failure('PERMISSION_TIMEOUT')); }, Math.max(1, deadline - Date.now()));
      try { start((error, value) => { clearTimeout(pending); if (error || stopped) reject(failure('PERMISSION_TRANSPORT_FAILED')); else resolve(value); }); }
      catch { clearTimeout(pending); reject(failure('PERMISSION_TRANSPORT_FAILED')); }
    });
  }
  let sftp: SFTPWrapper | undefined;
  try {
    sftp = await call<SFTPWrapper>((done) => client.sftp(done)); const channel = sftp;
    const stat = (path: string) => call<Stats>((done) => channel.lstat(path, done));
    async function ancestors() {
      let directory = '';
      for (const part of approved.path.split('/').slice(1, -1)) { directory += `/${part}`; const info = await stat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw failure('PERMISSION_TARGET_UNSAFE'); }
      if (await call<string>((done) => channel.realpath(approved.path, done)) !== approved.path || await call<string>((done) => channel.realpath(approved.root, done)) !== approved.root) throw failure('PERMISSION_TARGET_UNSAFE');
    }
    await ancestors();
    if (!matches(await stat(approved.path), snapshot, expectedMode)) throw failure('PERMISSION_DRIFT');
    handle = await call<Buffer>((done) => channel.open(approved.path, 'r', done)); const descriptor = handle;
    async function inspect(mode: number) {
      await ancestors();
      if (!matches(await call<Stats>((done) => channel.fstat(descriptor, done)), snapshot, mode) || !matches(await stat(approved.path), snapshot, mode)) throw failure('PERMISSION_DRIFT');
      const bytes = Buffer.alloc(approved.size + 1); let offset = 0;
      while (offset < bytes.length) { const count = await call<number>((done) => channel.read(descriptor, bytes, offset, bytes.length - offset, offset, (error, length) => done(error, length))); if (!Number.isInteger(count) || count < 0 || count > bytes.length - offset) throw failure('PERMISSION_TRANSPORT_FAILED'); if (!count) break; offset += count; }
      const content = bytes.subarray(0, offset);
      if (offset !== approved.size || digestBytes(content) !== approved.digest || !matches(await call<Stats>((done) => channel.fstat(descriptor, done)), snapshot, mode)) throw failure('PERMISSION_DRIFT');
      return content;
    }
    const bytes = await inspect(expectedMode);
    const recovery = await call<PermissionRecovery>((done) => { void input.recovery(snapshot, bytes).then((value) => done(undefined, value), () => done(failure('PERMISSION_RECOVERY_INVALID'), undefined as never)); });
    if (!recovery.encrypted || !recovery.verified || !/^[a-f0-9-]{36}$/.test(recovery.artifactId) || recovery.snapshotDigest !== permissionSnapshotDigest(snapshot)) throw failure('PERMISSION_RECOVERY_INVALID');
    await inspect(expectedMode);
    await call<void>((done) => { void input.authorize(operation, snapshot).then(() => done(undefined, undefined), () => done(failure('PERMISSION_AUTHORIZATION_FAILED'), undefined)); });
    if (stopped) throw failure('PERMISSION_TIMEOUT');
    // From this point every failure is uncertain: the server may commit before acknowledgement.
    mutated = true;
    await call<void>((done) => channel.fchmod(descriptor, targetMode & 0o777, (error) => done(error, undefined)));
    await inspect(targetMode);
    return { state: 'VERIFIED' as const, operation, originalMode: approved.mode & 0o777, mode: targetMode & 0o777, digest: approved.digest, recoveryArtifactId: recovery.artifactId };
  } catch (error) { if (mutated) throw failure('OUTCOME_UNKNOWN'); if (error instanceof CareError) throw error; throw failure('PERMISSION_OPERATION_FAILED'); }
  finally {
    if (handle && sftp && !stopped) await call<void>((done) => sftp!.close(handle!, (error) => done(error, undefined))).catch(() => undefined);
    clearTimeout(timer); client.end(); client.destroy();
  }
}
