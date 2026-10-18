import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { Client, type ConnectConfig } from 'ssh2';
import { resolvePublicTarget } from '@zerochack/scanner';

export type SshAccess = { host: string; port: number; username: string; authMethod: string; secret: string; hostKeyFingerprint?: string | null };
export type ServerObservationKind = 'WORLD_WRITABLE' | 'EXCESSIVE_SECRET_PERMISSIONS' | 'SSH_AUTH_FILE_WRITABLE' | 'SENSITIVE_FILE' | 'PUBLIC_VCS_DIRECTORY' | 'PHP_IN_UPLOADS' | 'HIDDEN_SCRIPT' | 'MALWARE_SIGNATURE' | 'CLAMAV_DETECTION' | 'SUSPICIOUS_PROCESS' | 'SUSPICIOUS_CRON';
export type ServerObservation = { kind: ServerObservationKind; path: string; detail?: string };
export type ServerInspection = { platform: string; roots: string[]; scannedFiles: number; scanLimitReached: boolean; malwareScanner: 'CLAMAV' | 'SIGNATURES_ONLY'; malwareScannerStatus: 'COMPLETED' | 'NOT_INSTALLED' | 'TIMED_OUT' | 'FAILED'; coverageState: 'BOUNDED' | 'INCOMPLETE'; coverageLimitations: string[]; observations: ServerObservation[] };
export type ServerInspectionProgress = { stage: 'DISCOVERING_ROOTS' | 'INSPECTING_FILES' | 'ANTIVIRUS' | 'CHECKING_PERSISTENCE'; scannedFiles: number };
function progressRecord(line: string): ServerInspectionProgress | undefined {
  const match = /^INSPECTION_PROGRESS\t(DISCOVERING_ROOTS|INSPECTING_FILES|ANTIVIRUS|CHECKING_PERSISTENCE)\t(0|[1-9]\d{0,3})$/u.exec(line);
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

/** Website source is read as data, never intentionally executed. Paths are never shell-interpolated.
 * Python's single process replaces per-file grep/find subprocesses. Limits apply across ALL roots.
 */
export const serverInspectionProgram = String.raw`import os, sys, stat, time, re, signal, selectors, subprocess, shutil
from collections import deque
MAX_ENTRIES = 40000
MAX_FILES = 2500
MAX_FILE_BYTES = 256 * 1024
MAX_BYTES = 32 * 1024 * 1024
MAX_DEPTH = 16
MAX_ROOTS = 8
TOTAL_SECONDS = 55
WALK_SECONDS = 30
AV_SECONDS = 15
COMMON_ROOTS = ['/var/www', '/srv/www']
home = os.path.realpath(os.environ.get('HOME', ''))
started = time.monotonic()
deadline = started + TOTAL_SECONDS
warnings = set()
roots = []
roots_emitted = False
scanned = 0
entries = 0
bytes_read = 0
observations = 0
observation_bytes = 0
limited = False
children = set()
av_files = []
av_path_bytes = 0
scanner = 'SIGNATURES_ONLY'
scanner_status = 'NOT_INSTALLED'
pruned = {'.git', '.svn', '.hg', '.cache', '.npm', 'node_modules', 'backups', 'logs', 'mail'}
markers = {'wp-config.php', 'index.php', 'composer.json', 'package.json'}
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
    if safe_path(path) or kind in ('SUSPICIOUS_PROCESS', 'SUSPICIOUS_CRON'):
        size = len((kind + path + detail).encode('utf-8')) + 4
        if observations >= 500 or observation_bytes + size > 524288: warn('OBSERVATION_LIMIT'); return
        emit(kind, path, detail); observations += 1
        observation_bytes += size
def progress(stage): emit('INSPECTION_PROGRESS', stage, scanned)
def stop_child(child):
    try: os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    try: child.wait(timeout=1)
    except subprocess.TimeoutExpired: pass
    if child.stdout: child.stdout.close()
    children.discard(child)
def terminate(_sig, _frame): raise Interrupted()
def alarm(_sig, _frame): raise BudgetExpired()
signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGHUP, terminate)
signal.signal(signal.SIGINT, terminate)
signal.signal(signal.SIGALRM, alarm)
signal.setitimer(signal.ITIMER_REAL, TOTAL_SECONDS)
def run_bounded(argv, seconds, output_limit):
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, start_new_session=True)
    children.add(child)
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    output = bytearray()
    end = min(deadline - 1, time.monotonic() + seconds)
    try:
        while True:
            if time.monotonic() >= end: return 124, bytes(output)
            for key, _ in selector.select(min(.2, max(0, end - time.monotonic()))):
                chunk = os.read(key.fileobj.fileno(), 4096)
                if not chunk: return child.wait(timeout=max(.01, end-time.monotonic())), bytes(output)
                if len(output) + len(chunk) > output_limit: return 125, bytes(output)
                output.extend(chunk)
    finally:
        selector.close(); stop_child(child)
def add_root(path):
    if not safe_path(path): return
    try:
        real = os.path.realpath(path)
        if not os.path.isdir(real): return
    except OSError: warn('FILESYSTEM_ENUMERATION_INCOMPLETE'); return
    if any(real == root or real.startswith(root + '/') for root in roots): return
    if len(roots) >= MAX_ROOTS: warn('ROOT_DISCOVERY_LIMIT'); return
    roots[:] = [root for root in roots if not root.startswith(real + '/')]
    roots.append(real)
def discover():
    for root in COMMON_ROOTS + [os.path.join(home, name) for name in ('public_html', 'www', 'htdocs', 'httpdocs')]: add_root(root)
    queue = deque([(home, 0)])
    seen = 0
    while queue:
        directory, depth = queue.popleft()
        if time.monotonic() - started >= 3 or seen >= 4000: warn('ROOT_DISCOVERY_LIMIT'); break
        if any(directory == root or directory.startswith(root + '/') for root in roots): continue
        try:
            with os.scandir(directory) as items:
                for item in items:
                    seen += 1
                    if seen >= 4000 or time.monotonic() - started >= 3: warn('ROOT_DISCOVERY_LIMIT'); return
                    if item.name in markers and item.is_file(follow_symlinks=False): add_root(directory)
                    if not item.name.startswith('.') and item.name not in pruned and item.is_dir(follow_symlinks=False):
                        if depth < 4: queue.append((item.path, depth + 1))
                        else: warn('ROOT_DISCOVERY_LIMIT')
        except OSError: warn('FILESYSTEM_ENUMERATION_INCOMPLETE')
def analyze(path, info):
    global scanned, bytes_read, av_path_bytes
    if scanned >= MAX_FILES: warn('CODE_FILE_LIMIT'); return
    if info.st_size > MAX_FILE_BYTES: warn('FILE_CONTENT_LIMIT'); return
    if bytes_read + info.st_size > MAX_BYTES: warn('CONTENT_BYTE_LIMIT'); return
    descriptor = None
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_NOFOLLOW)
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode) or (before.st_dev, before.st_ino, before.st_size) != (info.st_dev, info.st_ino, info.st_size): warn('SIGNATURE_READ_FAILED'); return
        chunks = []
        count = 0
        while count <= info.st_size:
            chunk = os.read(descriptor, min(65536, info.st_size + 1 - count))
            if not chunk: break
            chunks.append(chunk); count += len(chunk)
        after = os.fstat(descriptor)
        bytes_read += count
        if count != info.st_size or after.st_size != before.st_size or after.st_mtime_ns != before.st_mtime_ns: warn('SIGNATURE_READ_FAILED'); return
        data = b''.join(chunks)
        scanned += 1
        if signature.search(data): finding('MALWARE_SIGNATURE', path, 'Compound web-shell signature; content was not returned')
        path_bytes = len(os.fsencode(path)) + 1
        if av_path_bytes + path_bytes <= 60000: av_files.append(path); av_path_bytes += path_bytes
        else: warn('ANTIVIRUS_SELECTION_LIMIT')
    except OSError: warn('SIGNATURE_READ_FAILED')
    finally:
        if descriptor is not None: os.close(descriptor)
def walk():
    global entries
    walk_end = min(deadline - AV_SECONDS - 3, time.monotonic() + WALK_SECONDS)
    queue = deque()
    for root in roots:
        try: queue.append((root, 0, os.stat(root).st_dev))
        except OSError: warn('FILESYSTEM_ENUMERATION_INCOMPLETE')
    last_progress = 0
    while queue:
        if entries >= MAX_ENTRIES: warn('FILESYSTEM_ENTRY_LIMIT'); break
        if time.monotonic() >= walk_end: warn('INSPECTION_TIME_LIMIT'); break
        directory, depth, device = queue.popleft()
        try:
            with os.scandir(directory) as items:
                for item in items:
                    if entries >= MAX_ENTRIES: warn('FILESYSTEM_ENTRY_LIMIT'); return
                    if time.monotonic() >= walk_end: warn('INSPECTION_TIME_LIMIT'); return
                    entries += 1
                    if not safe_path(item.path): continue
                    try: info = item.stat(follow_symlinks=False)
                    except OSError: warn('FILESYSTEM_ENUMERATION_INCOMPLETE'); continue
                    if stat.S_ISLNK(info.st_mode): warn('SYMLINK_CONTENT_SKIPPED'); continue
                    if stat.S_ISDIR(info.st_mode):
                        if item.name in ('.git', '.svn', '.hg'): finding('PUBLIC_VCS_DIRECTORY', item.path, 'Version-control metadata beneath a selected root')
                        if info.st_dev != device: warn('FILESYSTEM_BOUNDARY_SKIPPED')
                        elif item.name in pruned: warn('DIRECTORY_CONTENT_SKIPPED')
                        elif depth >= MAX_DEPTH: warn('DIRECTORY_DEPTH_LIMIT')
                        else: queue.append((item.path, depth + 1, device))
                        continue
                    if not stat.S_ISREG(info.st_mode): continue
                    name = item.name.lower()
                    if info.st_mode & 2: finding('WORLD_WRITABLE', item.path, 'Other users can write this file')
                    sensitive = name in ('.env', '.htpasswd', 'wp-config.php', 'id_rsa') or name.endswith(('.pem', '.sql', '.bak', '.zip', '.tar.gz'))
                    if sensitive: finding('SENSITIVE_FILE', item.path, 'Sensitive filename beneath a selected web root')
                    if (name in ('.env', '.htpasswd', 'wp-config.php', 'id_rsa') or name.endswith('.pem')) and info.st_mode & 4: finding('EXCESSIVE_SECRET_PERMISSIONS', item.path, 'Other users can read this credential-bearing file')
                    executable = name.endswith(('.php', '.phtml', '.phar', '.cgi', '.pl'))
                    if executable and '/uploads/' in item.path: finding('PHP_IN_UPLOADS', item.path, 'Server-executable filename in uploads')
                    if name.startswith('.') and name.endswith(('.php', '.phtml', '.phar')): finding('HIDDEN_SCRIPT', item.path, 'Hidden server-side script')
                    if name.endswith(('.php', '.phtml', '.phar', '.js')): analyze(item.path, info)
                    if time.monotonic() - last_progress >= 2: progress('INSPECTING_FILES'); last_progress = time.monotonic()
        except OSError: warn('FILESYSTEM_ENUMERATION_INCOMPLETE')
def antivirus():
    global scanner, scanner_status
    executable = shutil.which('clamscan')
    if not executable: return
    scanner = 'CLAMAV'; scanner_status = 'FAILED'; progress('ANTIVIRUS')
    if not av_files: warn('ANTIVIRUS_EMPTY_SELECTION'); return
    code, output = run_bounded([executable, '--infected', '--no-summary', '--scan-archive=no', '--follow-dir-symlinks=0', '--follow-file-symlinks=0', '--max-filesize=256K', '--max-scansize=32M', '--'] + av_files, AV_SECONDS, 262144)
    scanner_status = 'COMPLETED' if code in (0, 1) else 'TIMED_OUT' if code in (124, 137) else 'FAILED'
    for line in output.decode('utf-8', 'replace').splitlines():
        if line.endswith(' FOUND') and ': ' in line:
            path, detail = line[:-6].rsplit(': ', 1)
            if path in av_files and len(detail) <= 200 and not any(ord(c) < 32 or ord(c) == 127 for c in detail): finding('CLAMAV_DETECTION', path, detail)
    if code == 125: warn('ANTIVIRUS_FINDING_LIMIT')
def persistence():
    progress('CHECKING_PERSISTENCE')
    for name in ('authorized_keys', 'authorized_keys2'):
        path = os.path.join(home, '.ssh', name)
        try:
            info = os.lstat(path)
            if stat.S_ISREG(info.st_mode) and info.st_mode & 0o022: finding('SSH_AUTH_FILE_WRITABLE', path, 'Authorization file writable by group or others')
        except FileNotFoundError: pass
        except OSError: warn('PERSISTENCE_CHECK_INCOMPLETE')
    cron = shutil.which('crontab')
    if cron:
        code, data = run_bounded([cron, '-l'], 2, 16384)
        if code != 0: warn('PERSISTENCE_CHECK_INCOMPLETE')
        if re.search(rb'(?:curl|wget).{0,500}(?:sh|bash)|base64\s+-d|/dev/shm/|kdevtmpfsi|kinsing|xmrig', data): finding('SUSPICIOUS_CRON', 'user-crontab', 'Fixed persistence pattern; command text was not retained')
    else: warn('PERSISTENCE_CHECK_INCOMPLETE')
    try:
        with os.scandir('/proc') as processes:
            for index, process in enumerate(processes):
                if index >= 1024 or time.monotonic() >= deadline - 1: warn('PERSISTENCE_CHECK_INCOMPLETE'); break
                if not process.name.isdigit(): continue
                try:
                    with open(os.path.join(process.path, 'comm'), 'rb') as stream: name = stream.read(100).strip()
                    if name in (b'xmrig', b'kinsing', b'kdevtmpfsi', b'watchbog', b'cryptominer'): finding('SUSPICIOUS_PROCESS', name.decode('ascii'), 'Known process-name indicator')
                except OSError: pass
    except OSError: warn('PERSISTENCE_CHECK_INCOMPLETE')
try:
    emit('PLATFORM', ' '.join(os.uname()[i] for i in (0, 2, 4))[:200])
    progress('DISCOVERING_ROOTS'); discover()
    if not roots:
        warn('NO_WEB_ROOT'); emit('ROOT', home, '')
    else:
        for root in roots: emit('ROOT', root, '')
        progress('INSPECTING_FILES'); walk()
    roots_emitted = True
    antivirus(); persistence()
except BudgetExpired:
    warn('INSPECTION_TIME_LIMIT')
    if scanner == 'CLAMAV' and scanner_status != 'COMPLETED': scanner_status = 'TIMED_OUT'
except Interrupted:
    sys.exit(71)
except Exception:
    warn('INSPECTION_STAGE_FAILED')
finally:
    signal.setitimer(signal.ITIMER_REAL, 0)
    for child in list(children): stop_child(child)
if not roots_emitted:
    for root in roots or [home]: emit('ROOT', root, '')
    if not roots: warn('NO_WEB_ROOT')
emit('MALWARE_SCANNER', scanner)
emit('MALWARE_STATUS', scanner_status)
emit('SCANNED_FILES', scanned)
emit('SCAN_LIMIT_REACHED', 1 if limited else 0)
emit('INSPECTION_COMPLETE', 'ssh-inspection-v3')
`;

export const serverInspectionScript = `set +e
if ! command -v python3 >/dev/null 2>&1; then
  printf 'PLATFORM\\tUnknown\\n'
  found=0
  for root in "$HOME/public_html" "$HOME/www" "$HOME/htdocs" "$HOME/httpdocs"; do
    if [ -d "$root" ]; then printf 'ROOT\\t%s\\t\\n' "$root"; found=1; fi
  done
  [ "$found" -eq 1 ] || printf 'ROOT\\t%s\\t\\n' "$HOME"
  printf 'COVERAGE_WARNING\\tPYTHON_UNAVAILABLE\\tMetadata only; no recursive or content scan ran\\n'
  printf 'MALWARE_SCANNER\\tSIGNATURES_ONLY\\nMALWARE_STATUS\\tNOT_INSTALLED\\nSCANNED_FILES\\t0\\nSCAN_LIMIT_REACHED\\t1\\nINSPECTION_COMPLETE\\tssh-inspection-v3\\n'
  exit 0
fi
exec python3 -I -B - <<'CODEBANDAGE_INSPECTION_PY'
${serverInspectionProgram}
CODEBANDAGE_INSPECTION_PY
`;

const observationKinds = new Set<ServerObservationKind>(['WORLD_WRITABLE', 'EXCESSIVE_SECRET_PERMISSIONS', 'SSH_AUTH_FILE_WRITABLE', 'SENSITIVE_FILE', 'PUBLIC_VCS_DIRECTORY', 'PHP_IN_UPLOADS', 'HIDDEN_SCRIPT', 'MALWARE_SIGNATURE', 'CLAMAV_DETECTION', 'SUSPICIOUS_PROCESS', 'SUSPICIOUS_CRON']);

export function parseServerInspectionOutput(output: string): ServerInspection {
  if (Buffer.byteLength(output) > 1_048_576 || /\0/u.test(output)) throw inspectionFailure('SSH_INSPECTION_OUTPUT_LIMIT');
  let platform = ''; let scannedFiles = 0; let scanLimitReached = false;
  let malwareScanner: ServerInspection['malwareScanner'] = 'SIGNATURES_ONLY';
  let malwareScannerStatus: ServerInspection['malwareScannerStatus'] = 'NOT_INSTALLED';
  const roots: string[] = []; const observations: ServerObservation[] = []; const seen = new Set<string>(); const warnings = new Set<string>();
  const warningMessages: Record<string, string> = {
    FILESYSTEM_ENUMERATION_INCOMPLETE: 'Some paths were inaccessible or a filesystem enumeration bound was reached.',
    SIGNATURE_READ_FAILED: 'At least one selected file could not be analyzed by the signature check.',
    ANTIVIRUS_FINDING_LIMIT: 'Antivirus findings exceeded the retained result bound.',
    OBSERVATION_LIMIT: 'The retained observation limit was reached; additional indicators were not retained.',
    ANTIVIRUS_DEADLINE_UNAVAILABLE: 'Antivirus was not started because its bounded timeout command is unavailable.',
    PYTHON_UNAVAILABLE: 'Python 3 is unavailable: only fixed account/web-root metadata was checked; no content or recursive inspection ran.',
    ROOT_DISCOVERY_LIMIT: 'Web-root discovery reached its 3-second, 4,000-entry, depth-4 or eight-root bound; other websites may not be selected.',
    NO_WEB_ROOT: 'No supported web root was identified; the account home was recorded as metadata only and was not recursively scanned.',
    UNSUPPORTED_PATH: 'A filename could not be safely represented; its content was not inspected.',
    CODE_FILE_LIMIT: 'The 2,500-file content selection bound was reached across all web roots.',
    FILE_CONTENT_LIMIT: 'At least one selected code file exceeds 256 KiB and was not content-inspected.',
    CONTENT_BYTE_LIMIT: 'The 32 MiB total content-reading budget was reached.',
    ANTIVIRUS_SELECTION_LIMIT: 'The bounded antivirus path list could not include every content-inspected file.',
    FILESYSTEM_ENTRY_LIMIT: 'The 40,000-entry filesystem budget was reached; remaining paths were not inspected.',
    INSPECTION_TIME_LIMIT: 'The inspection time budget was reached; remaining checks were not completed.',
    SYMLINK_CONTENT_SKIPPED: 'Symbolic-link content was not followed or inspected.',
    FILESYSTEM_BOUNDARY_SKIPPED: 'A separate filesystem was not traversed.',
    DIRECTORY_CONTENT_SKIPPED: 'Bulk dependency, cache, metadata, mail, backup or log directory content was skipped.',
    DIRECTORY_DEPTH_LIMIT: 'The depth-16 directory traversal bound was reached.',
    ANTIVIRUS_EMPTY_SELECTION: 'Antivirus had no safely selected code files to inspect.',
    PERSISTENCE_CHECK_INCOMPLETE: 'Some bounded process or current-account cron/SSH authorization metadata could not be checked.',
    INSPECTION_STAGE_FAILED: 'A bounded inspection stage failed; this is incomplete evidence, not a clean scan.'
  };
  const lines = output.split(/\r?\n/u).filter(line => line.length > 0);
  if (lines.at(-1) !== 'INSPECTION_COMPLETE\tssh-inspection-v3') throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
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
      if (!(path.startsWith('/') || kind === 'SUSPICIOUS_PROCESS' || kind === 'SUSPICIOUS_CRON')) throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
      observations.push({ kind: kind as ServerObservationKind, path, ...(detail ? { detail } : {}) });
    } else {
      if (seen.has(kind) || fields.length !== 2) throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
      seen.add(kind);
      if (kind === 'PLATFORM' && path.length <= 200) platform = path;
      else if (kind === 'SCANNED_FILES' && /^(?:0|[1-9]\d{0,3})$/u.test(path) && Number(path) <= 2500) scannedFiles = Number(path);
      else if (kind === 'SCAN_LIMIT_REACHED' && /^[01]$/u.test(path)) scanLimitReached = path === '1';
      else if (kind === 'MALWARE_SCANNER' && ['CLAMAV','SIGNATURES_ONLY'].includes(path)) malwareScanner = path as ServerInspection['malwareScanner'];
      else if (kind === 'MALWARE_STATUS' && ['COMPLETED','NOT_INSTALLED','TIMED_OUT','FAILED'].includes(path)) malwareScannerStatus = path as ServerInspection['malwareScannerStatus'];
      else if (kind !== 'INSPECTION_COMPLETE' || path !== 'ssh-inspection-v3') throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
    }
  }
  if (!['PLATFORM','SCANNED_FILES','SCAN_LIMIT_REACHED','MALWARE_SCANNER','MALWARE_STATUS','INSPECTION_COMPLETE'].every(key => seen.has(key)) || !roots.length || (malwareScanner === 'SIGNATURES_ONLY') !== (malwareScannerStatus === 'NOT_INSTALLED')) throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
  const coverageLimitations = [
    'Fixed read-only checks cover accessible selected paths only; they cannot prove malware absence or a fully secured server.',
    'One bounded walk covers at most eight discovered roots, 40,000 entries and depth 16. Content checks cover at most 2,500 PHP/JavaScript files, 256 KiB per file and 32 MiB total across all roots. Antivirus checks the bounded selected code-file list only, without archives, for at most 15 seconds. The entire inspection has a 55-second budget; this is not an exhaustive malware audit.'
  ];
  if (scanLimitReached) coverageLimitations.push('A reported inspection, selection or retention bound prevented complete coverage.');
  if (platform === 'Unknown') coverageLimitations.push('The server platform could not be identified.');
  if (!scannedFiles) coverageLimitations.push('No selected PHP/JavaScript files were analyzed.');
  if (roots.length > 8 || observations.length > 500) { scanLimitReached = true; coverageLimitations.push('The retained web-root or observation limit was reached.'); }
  if (malwareScannerStatus === 'NOT_INSTALLED') coverageLimitations.push('ClamAV is not installed for this account; only bounded signature checks ran.');
  else if (malwareScannerStatus === 'TIMED_OUT') coverageLimitations.push('Antivirus exceeded its deadline; its result is incomplete, not a clean scan.');
  else if (malwareScannerStatus === 'FAILED') coverageLimitations.push('Antivirus failed or could not start; its result is incomplete, not a clean scan.');
  coverageLimitations.push(...[...warnings].map(warning => warningMessages[warning]!));
  const coverageState = scanLimitReached || platform === 'Unknown' || !scannedFiles || malwareScannerStatus !== 'COMPLETED' || warnings.size ? 'INCOMPLETE' : 'BOUNDED';
  return { platform, roots: [...new Set(roots)].slice(0, 8), scannedFiles, scanLimitReached, malwareScanner, malwareScannerStatus, coverageState, coverageLimitations, observations: observations.slice(0, 500) };
}

export async function inspectServerReadOnly(client: Client, options?: { onProgress?: (progress: ServerInspectionProgress) => Promise<void> | void }): Promise<ServerInspection> {
  return parseServerInspectionOutput(await executeScript(client, serverInspectionScript, 120_000, options?.onProgress));
}
