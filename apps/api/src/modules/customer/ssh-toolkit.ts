import { createHash } from 'node:crypto';
import { createConnection, isIP } from 'node:net';
import { posix } from 'node:path';
import { Client, type ConnectConfig } from 'ssh2';
import { resolvePublicTarget } from '@zerochack/scanner';
import {
  type FixActionKey,
  type FixResult,
  type BuildFixOptions,
  buildFixScript,
  buildRollbackScript,
  parseFixResult
} from '@zerochack/security';

export type SshAccess = { host: string; port: number; username: string; authMethod: string; secret: string; hostKeyFingerprint?: string | null };
export type ServerObservationKind = 'WORLD_WRITABLE' | 'EXCESSIVE_SECRET_PERMISSIONS' | 'SSH_AUTH_FILE_WRITABLE' | 'SENSITIVE_FILE' | 'PUBLIC_VCS_DIRECTORY' | 'PHP_IN_UPLOADS' | 'HIDDEN_SCRIPT' | 'MALWARE_SIGNATURE' | 'CLAMAV_DETECTION' | 'SUSPICIOUS_PROCESS' | 'SUSPICIOUS_CRON';
export type ServerObservation = { kind: ServerObservationKind; path: string; detail?: string };
export type ServerInspectionScope = { mode: 'WEBSITE'; hostname: string; rootBinding: 'DOMAIN_DIRECTORY_CONVENTION' | 'UNRESOLVED' };
export type ServerInspection = { scope: ServerInspectionScope; platform: string; roots: string[]; scannedFiles: number; scanLimitReached: boolean; malwareScanner: 'CLAMAV' | 'SIGNATURES_ONLY'; malwareScannerStatus: 'NOT_INSTALLED' | 'NOT_RUN_SCOPE'; coverageState: 'BOUNDED' | 'INCOMPLETE'; coverageLimitations: string[]; observations: ServerObservation[] };
export type ServerInspectionProgress = { stage: 'DISCOVERING_ROOTS' | 'INSPECTING_FILES'; scannedFiles: number };
function progressRecord(line: string): ServerInspectionProgress | undefined {
  const match = /^INSPECTION_PROGRESS\t(DISCOVERING_ROOTS|INSPECTING_FILES)\t(0|[1-9]\d{0,3})$/u.exec(line);
  if (!match || Number(match[2]) > 2500) return undefined;
  return { stage: match[1] as ServerInspectionProgress['stage'], scannedFiles: Number(match[2]) };
}

function fingerprint(key: Buffer): string { return `SHA256:${createHash('sha256').update(key).digest('base64')}`; }

export async function connectSsh(access: SshAccess, verifyHost?: (observed: string) => Promise<boolean>): Promise<{ client: Client; fingerprint: string }> {
  // Missing pins require an explicit, durable server-side first-use trust verifier.
  const supplied = access.hostKeyFingerprint?.trim();
  if ((supplied && !/^SHA256:[A-Za-z0-9+/]{43}=?$/u.test(supplied)) || (!supplied && !verifyHost)) throw sshFailure('HOST_IDENTITY_REQUIRED');
  const expected = supplied ? (supplied.endsWith('=') ? supplied : supplied + '=') : null;
  if (!['PASSWORD', 'SSH_KEY'].includes(access.authMethod)) throw sshFailure('SSH_AUTH_METHOD_UNSUPPORTED');
  const deadline = Date.now() + 15_000;
  let dnsTimer: ReturnType<typeof setTimeout> | undefined;
  let addresses;
  try {
    addresses = await Promise.race([
      resolvePublicTarget(new URL(`https://${access.host}`)),
      new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(sshFailure('SSH_DNS_TIMEOUT')), 5000); })
    ]);
  } finally { clearTimeout(dnsTimer); }
  let lastFailure = sshFailure('SSH_CONNECTION_FAILED');
  // Only retry transport failures, across already-validated public addresses.
  // Never retry an authentication rejection or a changed host identity.
  for (const selected of addresses.slice(0, 3)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw sshFailure('SSH_TIMEOUT');
    try {
      return await new Promise<{ client: Client; fingerprint: string }>((resolve, reject) => {
        const socket = createConnection({ host: selected.address, port: access.port });
        const client = new Client(); let settled = false; let observed = ''; let keyChanged = false; let verificationError = '';
        const fail = (code: string) => {
          if (settled) return; settled = true; clearTimeout(timer);
          client.end(); socket.destroy(); reject(sshFailure(code));
        };
        const timer = setTimeout(() => fail('SSH_TIMEOUT'), Math.min(remaining, 12_000));
        socket.on('error', () => fail('SSH_CONNECTION_FAILED'));
        socket.once('close', () => fail('SSH_CONNECTION_FAILED'));
        client.once('ready', () => { if (settled) return; settled = true; clearTimeout(timer); resolve({ client, fingerprint: observed }); });
        client.on('error', error => fail(verificationError || (keyChanged ? 'SSH_HOST_KEY_CHANGED' : /authentication/iu.test(error.message) ? 'SSH_AUTH_FAILED' : /timed out/iu.test(error.message) ? 'SSH_TIMEOUT' : 'SSH_CONNECTION_FAILED')));
        const config: ConnectConfig = {
          sock: socket, username: access.username, readyTimeout: Math.min(remaining, 12_000),
          keepaliveInterval: 5000, keepaliveCountMax: 2,
          hostVerifier: (key: Buffer, accepted: (valid: boolean) => void) => {
            observed = fingerprint(key); keyChanged = Boolean(expected && expected !== observed);
            if (keyChanged) { accepted(false); return; }
            if (!verifyHost) { accepted(Boolean(expected)); return; }
            void verifyHost(observed).then(valid => { keyChanged = !valid; if (!settled) accepted(valid); }).catch(error => {
              const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
              verificationError = ['HOST_IDENTITY_REQUIRED', 'SSH_ACCESS_CHANGED', 'AUTHORIZATION_REQUIRED'].includes(code) ? code : 'SSH_HOST_VERIFICATION_FAILED';
              if (!settled) accepted(false);
            });
          },
          ...(access.authMethod === 'SSH_KEY' ? { privateKey: access.secret } : { password: access.secret })
        };
        try { client.connect(config); } catch { fail('SSH_CREDENTIAL_FORMAT'); }
      });
    } catch (error) {
      lastFailure = error as Error & { code: string };
      if (!['SSH_CONNECTION_FAILED', 'SSH_TIMEOUT'].includes(lastFailure.code)) throw lastFailure;
    }
  }
  throw lastFailure;
}

function sshFailure(code: string): Error & { code: string } {
  // Never propagate library messages that could reflect submitted credentials.
  return Object.assign(new Error('SSH connection was not verified.'), { code });
}

function executeScript(client: Client, script: string, timeoutMs = 120_000, onProgress?: (progress: ServerInspectionProgress) => Promise<void> | void): Promise<string> {
  return new Promise((resolve, reject) => {
    try { client.exec('LC_ALL=C sh -s', (error, stream) => {
      if (error) { reject(inspectionFailure('SSH_INSPECTION_FAILED')); return; }
      const chunks: Buffer[] = []; let size = 0; let settled = false; let exitCode: number | null | undefined; let tail = ''; let progressBusy = false; let progressWork: Promise<void> | undefined;
      const fail = (code: string) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { stream.signal('TERM'); } catch { /* Older servers may not support SSH signals. */ }
        try { stream.close(); } catch { /* The sanitized inspection failure remains authoritative. */ }
        reject(inspectionFailure(code));
      };
      const timer = setTimeout(() => fail('SSH_INSPECTION_TIMEOUT'), timeoutMs);
      const consume = (chunk: Buffer, retain: boolean) => {
        if (settled) return;
        size += chunk.length;
        if (size > 1_048_576) { fail('SSH_INSPECTION_OUTPUT_LIMIT'); return; }
        if (retain) {
          chunks.push(chunk);
          if (onProgress) {
            tail += chunk.toString('utf8');
            let newline: number;
            while ((newline = tail.indexOf('\n')) >= 0) {
              const line = tail.slice(0, newline).replace(/\r$/u, ''); tail = tail.slice(newline + 1);
              const progress = progressRecord(line);
              if (progress && !progressBusy) {
                progressBusy = true;
                try { progressWork = Promise.resolve(onProgress(progress)).catch(() => fail('SSH_INSPECTION_ABORTED')).finally(() => { progressBusy = false; }); }
                catch { fail('SSH_INSPECTION_ABORTED'); }
              }
            }
          }
        }
      };
      stream.on('data', (chunk: Buffer) => consume(chunk, true));
      stream.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
      stream.once('exit', (code: number | null) => { exitCode = code; });
      stream.once('close', () => {
        if (settled) return;
        if (exitCode !== 0) { fail(exitCode === undefined ? 'SSH_INSPECTION_INCOMPLETE' : 'SSH_INSPECTION_FAILED'); return; }
        void (progressWork ?? Promise.resolve()).then(() => { if (settled) return; settled = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); });
      });
      stream.once('error', () => fail('SSH_INSPECTION_FAILED'));
      try { stream.end(script); } catch { fail('SSH_INSPECTION_FAILED'); }
    }); } catch { reject(inspectionFailure('SSH_INSPECTION_FAILED')); }
  });
}

function inspectionFailure(code: string): Error & { code: string } {
  return Object.assign(new Error('The bounded SSH inspection did not produce complete, valid evidence.'), { code });
}

function inspectionHostname(value: string): string {
  // Only the canonical persisted DNS hostname is a filesystem-scope input.
  // IPs, URL/path syntax, aliases and normalization guesses are not accepted.
  if (typeof value !== 'string' || value.length > 253 || isIP(value) !== 0 || value !== value.toLowerCase() || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)) throw inspectionFailure('SSH_INSPECTION_SCOPE_REQUIRED');
  return value;
}

function domainConventionRoot(root: string, hostname: string): boolean {
  const parts = root.slice(1).split('/');
  const ownedDomainDirectory = parts.length >= 4 && parts.at(-3) === 'domains' && parts.at(-2) === hostname && ['public_html', 'httpdocs'].includes(parts.at(-1) ?? '');
  return root.startsWith('/') && posix.normalize(root) === root && !root.includes('\\') && (
    ownedDomainDirectory ||
    [`/var/www/${hostname}/public_html`, `/var/www/${hostname}/html`, `/srv/www/${hostname}/public_html`, `/var/www/vhosts/${hostname}/httpdocs`].includes(root)
  );
}

/** Website source is read as data, never intentionally executed. Paths are never shell-interpolated.
 * Python's single process reads only one exact-domain, no-follow directory scope.
 */
export const serverInspectionProgram = String.raw`import os, sys, stat, time, re, signal, shutil
selected_hostname = __CODEBANDAGE_SELECTED_HOSTNAME__
MAX_ENTRIES = 40000
MAX_FILES = 2500
MAX_FILE_BYTES = 256 * 1024
MAX_BYTES = 32 * 1024 * 1024
MAX_DEPTH = 16
TOTAL_SECONDS = 55
WALK_SECONDS = 30
home = os.environ.get('HOME', '')
SYSTEM_ROOT_CANDIDATES = ['/var/www/' + selected_hostname + '/public_html', '/var/www/' + selected_hostname + '/html', '/srv/www/' + selected_hostname + '/public_html', '/var/www/vhosts/' + selected_hostname + '/httpdocs']
started = time.monotonic()
deadline = started + TOTAL_SECONDS
warnings = set()
roots = []
root_descriptor = None
root_binding = 'UNRESOLVED'
scanned = 0
entries = 0
bytes_read = 0
observations = 0
observation_bytes = 0
limited = False
scanner = 'SIGNATURES_ONLY'
scanner_status = 'NOT_INSTALLED'
pruned = {'.git', '.svn', '.hg', '.cache', '.npm', 'node_modules', 'backups', 'logs', 'mail'}
signature = re.compile(rb'eval\s*\(\s*(?:base64_decode|gzinflate)|gzinflate\s*\(\s*base64_decode|base64_decode\s*\([^)]{0,120}\)\s*;\s*(?:eval|assert)|FilesMan|WSO[ _-]*Shell|b374k|c99shell|r57shell|str_rot13\s*\(\s*base64_decode')
class BudgetExpired(Exception): pass
class Interrupted(Exception): pass
def emit(kind, path, detail=None):
    values = [kind, str(path)] + ([] if detail is None else [str(detail)])
    print('\t'.join(values), flush=True)
def warn(code):
    global limited
    if code not in warnings:
        warnings.add(code)
        emit('COVERAGE_WARNING', code, 'Bounded inspection limitation')
    limited = True
def safe_path(path):
    if len(path) > 2048 or any(ord(c) < 32 or ord(c) == 127 or 0xd800 <= ord(c) <= 0xdfff for c in path):
        warn('UNSUPPORTED_PATH'); return False
    return path.startswith('/')
def finding(kind, path, detail):
    global observations, observation_bytes
    if safe_path(path):
        size = len((kind + path + detail).encode('utf-8')) + 4
        if observations >= 500 or observation_bytes + size > 524288: warn('OBSERVATION_LIMIT'); return
        emit(kind, path, detail); observations += 1
        observation_bytes += size
def progress(stage): emit('INSPECTION_PROGRESS', stage, scanned)
def terminate(_sig, _frame): raise Interrupted()
def alarm(_sig, _frame): raise BudgetExpired()
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGHUP, terminate)
signal.signal(signal.SIGINT, terminate)
signal.signal(signal.SIGALRM, alarm)
signal.setitimer(signal.ITIMER_REAL, TOTAL_SECONDS)
def open_directory_chain(path):
    # Anchor every ancestor, not only the leaf, before any website content read.
    if not path.startswith('/') or os.path.normpath(path) != path or not safe_path(path): return None
    descriptor = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in path.split('/')[1:]:
            next_descriptor = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = next_descriptor
        result = descriptor
        descriptor = None
        return result
    except FileNotFoundError: return None
    except OSError: warn('DOMAIN_ROOT_UNAVAILABLE'); return None
    finally:
        if descriptor is not None: os.close(descriptor)
def discover():
    global root_descriptor, root_binding
    candidates = []
    if home.startswith('/') and home != '/' and os.path.normpath(home) == home:
        candidates.extend(os.path.join(home, 'domains', selected_hostname, name) for name in ('public_html', 'httpdocs'))
    candidates.extend(SYSTEM_ROOT_CANDIDATES)
    selected = []
    try:
        for path in candidates:
            if time.monotonic() - started >= 3: warn('DOMAIN_ROOT_UNAVAILABLE'); break
            descriptor = open_directory_chain(path)
            if descriptor is not None: selected.append((path, descriptor))
        if len(selected) == 1 and 'DOMAIN_ROOT_UNAVAILABLE' not in warnings:
            path, descriptor = selected.pop()
            roots.append(path)
            root_descriptor = descriptor
            root_binding = 'DOMAIN_DIRECTORY_CONVENTION'
        elif len(selected) > 1: warn('DOMAIN_ROOT_AMBIGUOUS')
        else: warn('DOMAIN_ROOT_UNRESOLVED')
    finally:
        for _path, descriptor in selected: os.close(descriptor)
def analyze(descriptor, info):
    global bytes_read
    if scanned >= MAX_FILES: warn('CODE_FILE_LIMIT'); return
    if info.st_size > MAX_FILE_BYTES: warn('FILE_CONTENT_LIMIT'); return
    if bytes_read + info.st_size > MAX_BYTES: warn('CONTENT_BYTE_LIMIT'); return
    chunks = []
    count = 0
    while count <= info.st_size:
        chunk = os.read(descriptor, min(65536, info.st_size + 1 - count))
        if not chunk: break
        chunks.append(chunk); count += len(chunk)
    bytes_read += count
    if count != info.st_size: warn('SIGNATURE_READ_FAILED'); return
    return b''.join(chunks)
def inspect_file(directory_descriptor, filename, path, info, device):
    global scanned
    descriptor = None
    try:
        descriptor = os.open(filename, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW, dir_fd=directory_descriptor)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or (before.st_dev, before.st_ino, before.st_size) != (info.st_dev, info.st_ino, info.st_size): warn('SIGNATURE_READ_FAILED'); return
        if before.st_dev != device: warn('FILESYSTEM_BOUNDARY_SKIPPED'); return
        if before.st_nlink != 1: warn('SHARED_FILE_SKIPPED'); return
        name = filename.lower()
        data = analyze(descriptor, before) if name.endswith(('.php', '.phtml', '.phar', '.js')) else None
        after = os.fstat(descriptor)
        # No findings, even metadata findings, are retained for shared/drifting
        # files. Link count is checked again after reading, not only at scandir.
        if after.st_nlink != 1: warn('SHARED_FILE_SKIPPED'); return
        if after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns or after.st_mode != before.st_mode: warn('SIGNATURE_READ_FAILED'); return
        if before.st_mode & 2: finding('WORLD_WRITABLE', path, 'Other users can write this file')
        sensitive = name in ('.env', '.htpasswd', 'wp-config.php', 'id_rsa') or name.endswith(('.pem', '.sql', '.bak', '.zip', '.tar.gz'))
        if sensitive: finding('SENSITIVE_FILE', path, 'Sensitive filename beneath the selected website root')
        if (name in ('.env', '.htpasswd', 'wp-config.php', 'id_rsa') or name.endswith('.pem')) and before.st_mode & 4: finding('EXCESSIVE_SECRET_PERMISSIONS', path, 'Other users can read this credential-bearing file')
        executable = name.endswith(('.php', '.phtml', '.phar', '.cgi', '.pl'))
        if executable and '/uploads/' in path: finding('PHP_IN_UPLOADS', path, 'Server-executable filename in uploads')
        if name.startswith('.') and name.endswith(('.php', '.phtml', '.phar')): finding('HIDDEN_SCRIPT', path, 'Hidden server-side script')
        if data is not None:
            scanned += 1
            if signature.search(data): finding('MALWARE_SIGNATURE', path, 'Compound web-shell signature; content was not returned')
    except OSError: warn('SIGNATURE_READ_FAILED')
    finally:
        if descriptor is not None: os.close(descriptor)
def walk():
    global entries
    walk_end = min(deadline - 1, time.monotonic() + WALK_SECONDS)
    device = os.fstat(root_descriptor).st_dev
    last_progress = 0
    def visit(directory_descriptor, directory, depth):
        nonlocal last_progress
        global entries
        if entries >= MAX_ENTRIES: warn('FILESYSTEM_ENTRY_LIMIT'); return
        if time.monotonic() >= walk_end: warn('INSPECTION_TIME_LIMIT'); return
        try:
            with os.scandir(directory_descriptor) as items:
                for item in items:
                    if entries >= MAX_ENTRIES: warn('FILESYSTEM_ENTRY_LIMIT'); return
                    if time.monotonic() >= walk_end: warn('INSPECTION_TIME_LIMIT'); return
                    entries += 1
                    path = os.path.join(directory, item.name)
                    if not safe_path(path): continue
                    try: info = item.stat(follow_symlinks=False)
                    except OSError: warn('FILESYSTEM_ENUMERATION_INCOMPLETE'); continue
                    if stat.S_ISLNK(info.st_mode): warn('SYMLINK_CONTENT_SKIPPED'); continue
                    if stat.S_ISDIR(info.st_mode):
                        if item.name in ('.git', '.svn', '.hg'): finding('PUBLIC_VCS_DIRECTORY', path, 'Version-control metadata beneath the selected website root')
                        if info.st_dev != device: warn('FILESYSTEM_BOUNDARY_SKIPPED')
                        elif item.name in ('domains', 'vhosts', 'public_html', 'httpdocs'): warn('NESTED_SITE_DIRECTORY_SKIPPED')
                        elif item.name in pruned: warn('DIRECTORY_CONTENT_SKIPPED')
                        elif depth >= MAX_DEPTH: warn('DIRECTORY_DEPTH_LIMIT')
                        else:
                            child = None
                            try:
                                child = os.open(item.name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory_descriptor)
                                current = os.fstat(child)
                                if (current.st_dev, current.st_ino) != (info.st_dev, info.st_ino): warn('FILESYSTEM_ENUMERATION_INCOMPLETE')
                                else: visit(child, path, depth + 1)
                            except OSError: warn('FILESYSTEM_ENUMERATION_INCOMPLETE')
                            finally:
                                if child is not None: os.close(child)
                        continue
                    if not stat.S_ISREG(info.st_mode): continue
                    if info.st_nlink != 1: warn('SHARED_FILE_SKIPPED'); continue
                    inspect_file(directory_descriptor, item.name, path, info, device)
                    if time.monotonic() - last_progress >= 2: progress('INSPECTING_FILES'); last_progress = time.monotonic()
        except OSError: warn('FILESYSTEM_ENUMERATION_INCOMPLETE')
    visit(root_descriptor, roots[0], 0)
def antivirus_availability():
    global scanner, scanner_status
    if shutil.which('clamscan'):
        scanner = 'CLAMAV'
        scanner_status = 'NOT_RUN_SCOPE'
        warn('ANTIVIRUS_SCOPE_UNVERIFIED')
try:
    emit('SCOPE_MODE', 'WEBSITE')
    emit('SCOPE_HOSTNAME', selected_hostname)
    antivirus_availability()
    emit('PLATFORM', ' '.join(os.uname()[i] for i in (0, 2, 4))[:200])
    progress('DISCOVERING_ROOTS'); discover()
    if roots:
        for root in roots: emit('ROOT', root, '')
        progress('INSPECTING_FILES'); walk()
except BudgetExpired:
    warn('INSPECTION_TIME_LIMIT')
except Interrupted:
    sys.exit(71)
except Exception:
    warn('INSPECTION_STAGE_FAILED')
finally:
    signal.setitimer(signal.ITIMER_REAL, 0)
    if root_descriptor is not None: os.close(root_descriptor)
if root_binding == 'UNRESOLVED' and not warnings.intersection({'DOMAIN_ROOT_UNRESOLVED', 'DOMAIN_ROOT_AMBIGUOUS', 'DOMAIN_ROOT_UNAVAILABLE'}): warn('DOMAIN_ROOT_UNRESOLVED')
emit('ROOT_BINDING', root_binding)
emit('MALWARE_SCANNER', scanner)
emit('MALWARE_STATUS', scanner_status)
emit('SCANNED_FILES', scanned)
emit('SCAN_LIMIT_REACHED', 1 if limited else 0)
emit('INSPECTION_COMPLETE', 'ssh-inspection-v4')
`;

export function serverInspectionProgramForHostname(normalizedHostname: string): string {
  return serverInspectionProgram.replace('__CODEBANDAGE_SELECTED_HOSTNAME__', JSON.stringify(inspectionHostname(normalizedHostname)));
}

export function serverInspectionScript(normalizedHostname: string): string {
  const hostname = inspectionHostname(normalizedHostname);
  return `set +e
if ! command -v python3 >/dev/null 2>&1; then
  printf 'PLATFORM\\tUnknown\\n'
  printf 'SCOPE_MODE\\tWEBSITE\\nSCOPE_HOSTNAME\\t${hostname}\\nROOT_BINDING\\tUNRESOLVED\\n'
  printf 'COVERAGE_WARNING\\tPYTHON_UNAVAILABLE\\tNo website content inspection ran\\nCOVERAGE_WARNING\\tDOMAIN_ROOT_UNRESOLVED\\tNo domain-bound root selected\\n'
  if command -v clamscan >/dev/null 2>&1; then
    printf 'MALWARE_SCANNER\\tCLAMAV\\nMALWARE_STATUS\\tNOT_RUN_SCOPE\\n'
  else
    printf 'MALWARE_SCANNER\\tSIGNATURES_ONLY\\nMALWARE_STATUS\\tNOT_INSTALLED\\n'
  fi
  printf 'SCANNED_FILES\\t0\\nSCAN_LIMIT_REACHED\\t1\\nINSPECTION_COMPLETE\\tssh-inspection-v4\\n'
  exit 0
fi
exec python3 -I -B - <<'CODEBANDAGE_INSPECTION_PY'
${serverInspectionProgramForHostname(hostname)}
CODEBANDAGE_INSPECTION_PY
`;
}

const observationKinds = new Set<ServerObservationKind>(['WORLD_WRITABLE', 'EXCESSIVE_SECRET_PERMISSIONS', 'SENSITIVE_FILE', 'PUBLIC_VCS_DIRECTORY', 'PHP_IN_UPLOADS', 'HIDDEN_SCRIPT', 'MALWARE_SIGNATURE']);

export function parseServerInspectionOutput(output: string, normalizedHostname: string): ServerInspection {
  const hostname = inspectionHostname(normalizedHostname);
  if (Buffer.byteLength(output) > 1_048_576 || /\0/u.test(output)) throw inspectionFailure('SSH_INSPECTION_OUTPUT_LIMIT');
  let platform = ''; let scannedFiles = 0; let scanLimitReached = false;
  let malwareScanner: ServerInspection['malwareScanner'] = 'SIGNATURES_ONLY';
  let malwareScannerStatus: ServerInspection['malwareScannerStatus'] = 'NOT_INSTALLED';
  let rootBinding: ServerInspectionScope['rootBinding'] | undefined;
  const roots: string[] = []; const observations: ServerObservation[] = []; const seen = new Set<string>(); const warnings = new Set<string>();
  const warningMessages: Record<string, string> = {
    FILESYSTEM_ENUMERATION_INCOMPLETE: 'Some paths were inaccessible or a filesystem enumeration bound was reached.',
    SIGNATURE_READ_FAILED: 'At least one selected file could not be analyzed by the signature check.',
    OBSERVATION_LIMIT: 'The retained observation limit was reached; additional indicators were not retained.',
    PYTHON_UNAVAILABLE: 'Python 3 is unavailable: no website root was selected and no content or recursive inspection ran.',
    DOMAIN_ROOT_UNRESOLVED: 'No exact domain-directory web root was identified for the selected hostname. No website content was inspected; generic account or primary-domain folders were not guessed.',
    DOMAIN_ROOT_AMBIGUOUS: 'More than one domain-directory web root matched the selected hostname. No website content was inspected; an explicit verified root binding is required.',
    DOMAIN_ROOT_UNAVAILABLE: 'An exact candidate root could not be safely checked without following links or exceeding the resolution budget. No website content was inspected.',
    UNSUPPORTED_PATH: 'A filename could not be safely represented; its content was not inspected.',
    CODE_FILE_LIMIT: 'The 2,500-file content selection bound was reached within the selected website root.',
    FILE_CONTENT_LIMIT: 'At least one selected code file exceeds 256 KiB and was not content-inspected.',
    CONTENT_BYTE_LIMIT: 'The 32 MiB total content-reading budget was reached.',
    FILESYSTEM_ENTRY_LIMIT: 'The 40,000-entry filesystem budget was reached; remaining paths were not inspected.',
    INSPECTION_TIME_LIMIT: 'The inspection time budget was reached; remaining checks were not completed.',
    SYMLINK_CONTENT_SKIPPED: 'Symbolic-link content was not followed or inspected.',
    SHARED_FILE_SKIPPED: 'A file with multiple hard links was skipped entirely because its website-only scope could not be established.',
    NESTED_SITE_DIRECTORY_SKIPPED: 'A nested hosting-layout directory was skipped to avoid inspecting another website.',
    FILESYSTEM_BOUNDARY_SKIPPED: 'A separate filesystem was not traversed.',
    DIRECTORY_CONTENT_SKIPPED: 'Bulk dependency, cache, metadata, mail, backup or log directory content was skipped.',
    DIRECTORY_DEPTH_LIMIT: 'The depth-16 directory traversal bound was reached.',
    INSPECTION_STAGE_FAILED: 'A bounded inspection stage failed; this is incomplete evidence, not a clean scan.',
    ANTIVIRUS_SCOPE_UNVERIFIED: 'External antivirus was not run: a runner that preserves the selected website directory scope has not been verified. Only bounded built-in content signatures ran.'
  };
  const lines = output.split(/\r?\n/u).filter(line => line.length > 0);
  if (lines.at(-1) !== 'INSPECTION_COMPLETE\tssh-inspection-v4') throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
  for (const line of lines) {
    const fields = line.split('\t');
    const [kind = '', rawPath = '', rawDetail = ''] = fields; const path = rawPath.trim(); const detail = rawDetail.trim();
    if (fields.length < 2 || fields.length > 3 || !path || path.length > 2048 || detail.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(line)) throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
    if (kind === 'INSPECTION_PROGRESS') {
      if (!progressRecord(line)) throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
    } else if (kind === 'ROOT') {
      if (!path.startsWith('/')) throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
      roots.push(path);
    } else if (kind === 'COVERAGE_WARNING') {
      if (!Object.hasOwn(warningMessages, path)) throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
      warnings.add(path);
    } else if (observationKinds.has(kind as ServerObservationKind)) {
      if (!path.startsWith('/')) throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
      observations.push({ kind: kind as ServerObservationKind, path, ...(detail ? { detail } : {}) });
    } else {
      if (seen.has(kind) || fields.length !== 2) throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
      seen.add(kind);
      if (kind === 'SCOPE_MODE' && path === 'WEBSITE') { /* Required exact website-only scope marker. */ }
      else if (kind === 'SCOPE_HOSTNAME' && path === hostname) { /* Must match the trusted persisted hostname, not remote aliases. */ }
      else if (kind === 'ROOT_BINDING' && ['DOMAIN_DIRECTORY_CONVENTION', 'UNRESOLVED'].includes(path)) rootBinding = path as ServerInspectionScope['rootBinding'];
      else if (kind === 'PLATFORM' && path.length <= 200) platform = path;
      else if (kind === 'SCANNED_FILES' && /^(?:0|[1-9]\d{0,3})$/u.test(path) && Number(path) <= 2500) scannedFiles = Number(path);
      else if (kind === 'SCAN_LIMIT_REACHED' && /^[01]$/u.test(path)) scanLimitReached = path === '1';
      else if (kind === 'MALWARE_SCANNER' && ['CLAMAV','SIGNATURES_ONLY'].includes(path)) malwareScanner = path as ServerInspection['malwareScanner'];
      else if (kind === 'MALWARE_STATUS' && ['NOT_INSTALLED','NOT_RUN_SCOPE'].includes(path)) malwareScannerStatus = path as ServerInspection['malwareScannerStatus'];
      else if (kind !== 'INSPECTION_COMPLETE' || path !== 'ssh-inspection-v4') throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
    }
  }
  if (!['SCOPE_MODE','SCOPE_HOSTNAME','ROOT_BINDING','PLATFORM','SCANNED_FILES','SCAN_LIMIT_REACHED','MALWARE_SCANNER','MALWARE_STATUS','INSPECTION_COMPLETE'].every(key => seen.has(key)) || !rootBinding || (malwareScanner === 'SIGNATURES_ONLY') !== (malwareScannerStatus === 'NOT_INSTALLED')) throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
  const root = roots[0];
  if (rootBinding === 'UNRESOLVED') {
    if (roots.length || observations.length || scannedFiles || !scanLimitReached || !['DOMAIN_ROOT_UNRESOLVED', 'DOMAIN_ROOT_AMBIGUOUS', 'DOMAIN_ROOT_UNAVAILABLE'].some(warning => warnings.has(warning))) throw inspectionFailure('SSH_INSPECTION_SCOPE_INVALID');
  } else if (roots.length !== 1 || !root || !domainConventionRoot(root, hostname) || observations.some(observation => !observation.path.startsWith(`${root}/`) || posix.normalize(observation.path) !== observation.path || observation.path.includes('\\'))) throw inspectionFailure('SSH_INSPECTION_SCOPE_INVALID');
  const coverageLimitations = [
    'Fixed read-only checks cover accessible selected paths only; they cannot prove malware absence or a fully secured server.',
    'Website-only scope uses an exact hostname directory convention, not attested virtual-host configuration. Account-wide cron, process, SSH-authorization metadata and other websites are excluded.',
    'One directory-handle-anchored walk covers at most one domain-bound root, 40,000 entries and depth 16. Content checks cover at most 2,500 PHP/JavaScript files, 256 KiB per file and 32 MiB total. External antivirus is not executed until a scope-preserving runner is verified. The entire inspection has a 55-second budget; this is not an exhaustive malware audit.'
  ];
  if (scanLimitReached) coverageLimitations.push('A reported inspection, selection or retention bound prevented complete coverage.');
  if (platform === 'Unknown') coverageLimitations.push('The server platform could not be identified.');
  if (!scannedFiles) coverageLimitations.push('No selected PHP/JavaScript files were analyzed.');
  if (observations.length > 500) { scanLimitReached = true; coverageLimitations.push('The retained observation limit was reached.'); }
  if (malwareScannerStatus === 'NOT_INSTALLED') coverageLimitations.push('ClamAV is not installed for this account; only bounded signature checks ran.');
  else if (malwareScannerStatus === 'NOT_RUN_SCOPE') coverageLimitations.push('ClamAV is present but was not executed because its website-only filesystem scope has not been verified.');
  coverageLimitations.push(...[...warnings].map(warning => warningMessages[warning]!));
  // The v4 website runner never executes external antivirus. Its finite built-in
  // checks may finish successfully, but complete malware coverage is not implied.
  const coverageState = 'INCOMPLETE';
  return { scope: { mode: 'WEBSITE', hostname, rootBinding }, platform, roots, scannedFiles, scanLimitReached, malwareScanner, malwareScannerStatus, coverageState, coverageLimitations, observations: observations.slice(0, 500) };
}

export async function inspectServerReadOnly(client: Client, normalizedHostname: string, options?: { onProgress?: (progress: ServerInspectionProgress) => Promise<void> | void }): Promise<ServerInspection> {
  const hostname = inspectionHostname(normalizedHostname);
  return parseServerInspectionOutput(await executeScript(client, serverInspectionScript(hostname), 120_000, options?.onProgress), hostname);
}

// Applies a single reversible fix over an already-authenticated SSH connection.
// The script is generated by the remediation-actions engine (validated, quoted).
// Returns the parsed result, including the undo token needed to roll it back.
export async function applyRemediationFix(
  client: Client,
  actionKey: FixActionKey,
  path: string,
  options: BuildFixOptions
): Promise<FixResult> {
  return parseFixResult(await executeScript(client, buildFixScript(actionKey, path, options), 60_000));
}

// Rolls a previously-applied fix back using the token captured at apply time.
export async function rollbackRemediationFix(
  client: Client,
  actionKey: FixActionKey,
  path: string,
  undoToken: string
): Promise<FixResult> {
  return parseFixResult(await executeScript(client, buildRollbackScript(actionKey, path, undoToken), 60_000));
}
