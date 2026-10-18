import { createHash } from 'node:crypto';
import { createConnection } from 'node:net';
import { Client, type ConnectConfig } from 'ssh2';
import { resolvePublicTarget } from '@zerochack/scanner';

export type SshAccess = { host: string; port: number; username: string; authMethod: string; secret: string; hostKeyFingerprint?: string | null };
export type ServerObservationKind = 'WORLD_WRITABLE' | 'EXCESSIVE_SECRET_PERMISSIONS' | 'SSH_AUTH_FILE_WRITABLE' | 'SENSITIVE_FILE' | 'PUBLIC_VCS_DIRECTORY' | 'PHP_IN_UPLOADS' | 'HIDDEN_SCRIPT' | 'MALWARE_SIGNATURE' | 'CLAMAV_DETECTION' | 'SUSPICIOUS_PROCESS' | 'SUSPICIOUS_CRON';
export type ServerObservation = { kind: ServerObservationKind; path: string; detail?: string };
export type ServerInspection = { platform: string; roots: string[]; scannedFiles: number; scanLimitReached: boolean; malwareScanner: 'CLAMAV' | 'SIGNATURES_ONLY'; malwareScannerStatus: 'COMPLETED' | 'NOT_INSTALLED' | 'TIMED_OUT' | 'FAILED'; coverageState: 'BOUNDED' | 'INCOMPLETE'; coverageLimitations: string[]; observations: ServerObservation[] };

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

function executeScript(client: Client, script: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => {
    try { client.exec('LC_ALL=C sh -s', (error, stream) => {
      if (error) { reject(inspectionFailure('SSH_INSPECTION_FAILED')); return; }
      const chunks: Buffer[] = []; let size = 0; let settled = false; let exitCode: number | null | undefined;
      const fail = (code: string) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { stream.close(); } catch { /* The sanitized inspection failure remains authoritative. */ }
        reject(inspectionFailure(code));
      };
      const timer = setTimeout(() => fail('SSH_INSPECTION_TIMEOUT'), timeoutMs);
      const consume = (chunk: Buffer, retain: boolean) => {
        if (settled) return;
        size += chunk.length;
        if (size > 1_048_576) { fail('SSH_INSPECTION_OUTPUT_LIMIT'); return; }
        if (retain) chunks.push(chunk);
      };
      stream.on('data', (chunk: Buffer) => consume(chunk, true));
      stream.stderr.on('data', (chunk: Buffer) => consume(chunk, false));
      stream.once('exit', (code: number | null) => { exitCode = code; });
      stream.once('close', () => {
        if (settled) return;
        if (exitCode !== 0) { fail(exitCode === undefined ? 'SSH_INSPECTION_INCOMPLETE' : 'SSH_INSPECTION_FAILED'); return; }
        settled = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8'));
      });
      stream.once('error', () => fail('SSH_INSPECTION_FAILED'));
      try { stream.end(script); } catch { fail('SSH_INSPECTION_FAILED'); }
    }); } catch { reject(inspectionFailure('SSH_INSPECTION_FAILED')); }
  });
}

function inspectionFailure(code: string): Error & { code: string } {
  return Object.assign(new Error('The bounded SSH inspection did not produce complete, valid evidence.'), { code });
}

export const serverInspectionScript = String.raw`set +e
MAX_CODE_FILES=25000
seen_roots='|'
roots=''
clean() { printf '%s' "$1" | tr '\t\r\n' '   '; }
emit() { printf '%s\t%s\t%s\n' "$1" "$(clean "$2")" "$(clean "$3")"; }
for required in find head wc tr grep dirname sort sed uname awk; do command -v "$required" >/dev/null 2>&1 || exit 70; done
exec 3>&1
find_paths() {
  find "$@" 2>/dev/null
  find_status=$?
  [ "$find_status" -eq 0 ] || emit COVERAGE_WARNING FILESYSTEM_ENUMERATION_INCOMPLETE 'Some paths were inaccessible or an enumeration bound was reached' >&3
}
add_root() {
  [ -d "$1" ] || return
  root=$(cd "$1" 2>/dev/null && pwd -P) || return
  case "$seen_roots" in *"|$root|"*) return ;; esac
  root_ifs=$IFS
  IFS='
'
  for existing in $roots; do case "$root/" in "$existing/"*) IFS=$root_ifs; return ;; esac; done
  IFS=$root_ifs
  seen_roots="$seen_roots$root|"
  roots="$roots
$root"
  emit ROOT "$root" ''
}

printf 'PLATFORM\t'; uname -srm 2>/dev/null || printf 'Unknown\n'
for candidate in /var/www /srv/www "$HOME/public_html" "$HOME/www" "$HOME/htdocs" "$HOME/httpdocs"; do add_root "$candidate"; done
marker_ifs=$IFS
IFS='
'
for marker in $(find_paths "$HOME" -maxdepth 5 -type f \( -name wp-config.php -o -name composer.json -o -name package.json -o -name index.php \) -print | head -80); do add_root "$(dirname "$marker")"; done
IFS=$marker_ifs
[ -n "$roots" ] || add_root "$HOME"

if [ -d "$HOME/.ssh" ]; then
  find_paths "$HOME/.ssh" -maxdepth 1 -type f \( -name authorized_keys -o -name authorized_keys2 \) -perm -0022 -print | while IFS= read -r file; do emit SSH_AUTH_FILE_WRITABLE "$file" 'SSH authorization file is writable by group or other users'; done
fi

scanned=0
limit_reached=0
old_ifs=$IFS
IFS='
'
for root in $roots; do
  [ -n "$root" ] || continue
  find_paths "$root" -xdev -type f -perm -0002 -print | head -100 | while IFS= read -r file; do emit WORLD_WRITABLE "$file" 'mode permits writes by any local user'; done
  find_paths "$root" -xdev -type f \( -name .env -o -name .htpasswd -o -name wp-config.php -o -name id_rsa -o -name '*.pem' -o -name '*.sql' -o -name '*.bak' -o -name '*.zip' -o -name '*.tar.gz' \) -print | head -100 | while IFS= read -r file; do emit SENSITIVE_FILE "$file" 'sensitive or backup filename beneath web root'; done
  find_paths "$root" -xdev -type f \( -name .env -o -name .htpasswd -o -name wp-config.php -o -name id_rsa -o -name '*.pem' \) -perm -0004 -print | head -100 | while IFS= read -r file; do emit EXCESSIVE_SECRET_PERMISSIONS "$file" 'credential-bearing file is readable by other local users'; done
  find_paths "$root" -xdev -type d \( -name .git -o -name .svn -o -name .hg \) -print | head -50 | while IFS= read -r dir; do emit PUBLIC_VCS_DIRECTORY "$dir" 'version-control metadata beneath web root'; done
  find_paths "$root" -xdev -type f -path '*/uploads/*' \( -name '*.php' -o -name '*.phtml' -o -name '*.phar' -o -name '*.cgi' -o -name '*.pl' \) -print | head -100 | while IFS= read -r file; do emit PHP_IN_UPLOADS "$file" 'server-executable script in an upload directory'; done
  find_paths "$root" -xdev -type f \( -name '.*.php' -o -name '.*.phtml' -o -name '.*.phar' \) -print | head -100 | while IFS= read -r file; do emit HIDDEN_SCRIPT "$file" 'hidden server-side script beneath web root'; done
  count=$(find_paths "$root" -xdev -type f \( -name '*.php' -o -name '*.phtml' -o -name '*.phar' -o -name '*.js' \) -size -8M -print | head -$MAX_CODE_FILES | wc -l | tr -d ' '); scanned=$((scanned + count))
  extra=$(find_paths "$root" -xdev -type f \( -name '*.php' -o -name '*.phtml' -o -name '*.phar' -o -name '*.js' \) -size -8M -print | head -$((MAX_CODE_FILES + 1)) | wc -l | tr -d ' ')
  [ "$extra" -gt "$MAX_CODE_FILES" ] && limit_reached=1
  find_paths "$root" -xdev -type f \( -name '*.php' -o -name '*.phtml' -o -name '*.phar' -o -name '*.js' \) -size -8M -print | head -$MAX_CODE_FILES | while IFS= read -r file; do
    LC_ALL=C grep -I -q -E 'eval[[:space:]]*\([[:space:]]*(base64_decode|gzinflate)|gzinflate[[:space:]]*\([[:space:]]*base64_decode|base64_decode[[:space:]]*\([^)]{0,120}\)[[:space:]]*;[[:space:]]*(eval|assert)|FilesMan|WSO[[:space:]_-]*Shell|b374k|c99shell|r57shell|str_rot13[[:space:]]*\([[:space:]]*base64_decode' "$file" 2>/dev/null
    signature_status=$?
    if [ "$signature_status" -eq 0 ]; then emit MALWARE_SIGNATURE "$file" 'high-confidence obfuscated web-shell signature'; elif [ "$signature_status" -ne 1 ]; then emit COVERAGE_WARNING SIGNATURE_READ_FAILED 'At least one selected file could not be analyzed'; fi
  done
done
IFS=$old_ifs

if command -v clamscan >/dev/null 2>&1; then
  printf 'MALWARE_SCANNER\tCLAMAV\n'
  IFS='
'
  set --
  for root in $roots; do [ -n "$root" ] && set -- "$@" "$root"; done
  IFS=$old_ifs
  if command -v timeout >/dev/null 2>&1; then
    {
      timeout 75s clamscan --infected --no-summary --max-filesize=25M --max-scansize=300M -r "$@" 2>/dev/null
      printf '\nCB_CLAM_EXIT\t%s\n' "$?"
    } | awk '
      /^CB_CLAM_EXIT\t[0-9]+$/ { if ($2 == 0 || $2 == 1) status="COMPLETED"; else if ($2 == 124 || $2 == 137) status="TIMED_OUT"; else status="FAILED"; printf "MALWARE_STATUS\t%s\n", status; next }
      /: .* FOUND$/ { if (found++ < 100) { sub(/: /,"\t"); sub(/ FOUND$/,""); printf "CLAMAV_DETECTION\t%s\n", $0 } }
      END { if (found > 100) print "COVERAGE_WARNING\tANTIVIRUS_FINDING_LIMIT\tAntivirus output exceeded the retained finding bound" }
    '
  else
    printf 'MALWARE_STATUS\tFAILED\n'
    emit COVERAGE_WARNING ANTIVIRUS_DEADLINE_UNAVAILABLE 'Antivirus was not started because its timeout command is unavailable'
  fi
else
  printf 'MALWARE_SCANNER\tSIGNATURES_ONLY\n'
  printf 'MALWARE_STATUS\tNOT_INSTALLED\n'
fi

ps -eo comm= 2>/dev/null | grep -E '^(xmrig|kinsing|kdevtmpfsi|watchbog|cryptominer)$' | sort -u | head -20 | while IFS= read -r process; do emit SUSPICIOUS_PROCESS "$process" 'process name matches a known cryptominer or bot indicator'; done
if crontab -l 2>/dev/null | grep -E -q '(curl|wget).*(sh|bash)|base64[[:space:]]+-d|/dev/shm/|kdevtmpfsi|kinsing|xmrig'; then emit SUSPICIOUS_CRON 'user-crontab' 'scheduled downloader, decoder, or known malware indicator'; fi
printf 'SCANNED_FILES\t%s\n' "$scanned"
printf 'SCAN_LIMIT_REACHED\t%s\n' "$limit_reached"
printf 'INSPECTION_COMPLETE\tssh-inspection-v3\n'
exit 0
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
    ANTIVIRUS_DEADLINE_UNAVAILABLE: 'Antivirus was not started because its bounded timeout command is unavailable.'
  };
  const lines = output.split(/\r?\n/u).filter(line => line.length > 0);
  if (lines.at(-1) !== 'INSPECTION_COMPLETE\tssh-inspection-v3') throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
  for (const line of lines) {
    const fields = line.split('\t');
    const [kind = '', rawPath = '', rawDetail = ''] = fields; const path = rawPath.trim(); const detail = rawDetail.trim();
    if (fields.length < 2 || fields.length > 3 || !path || path.length > 2048 || detail.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(line)) throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
    if (kind === 'ROOT') {
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
      else if (kind === 'SCANNED_FILES' && /^(?:0|[1-9]\d{0,7})$/u.test(path)) scannedFiles = Number(path);
      else if (kind === 'SCAN_LIMIT_REACHED' && /^[01]$/u.test(path)) scanLimitReached = path === '1';
      else if (kind === 'MALWARE_SCANNER' && ['CLAMAV','SIGNATURES_ONLY'].includes(path)) malwareScanner = path as ServerInspection['malwareScanner'];
      else if (kind === 'MALWARE_STATUS' && ['COMPLETED','NOT_INSTALLED','TIMED_OUT','FAILED'].includes(path)) malwareScannerStatus = path as ServerInspection['malwareScannerStatus'];
      else if (kind !== 'INSPECTION_COMPLETE' || path !== 'ssh-inspection-v3') throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
    }
  }
  if (!['PLATFORM','SCANNED_FILES','SCAN_LIMIT_REACHED','MALWARE_SCANNER','MALWARE_STATUS','INSPECTION_COMPLETE'].every(key => seen.has(key)) || !roots.length || (malwareScanner === 'SIGNATURES_ONLY') !== (malwareScannerStatus === 'NOT_INSTALLED')) throw inspectionFailure('SSH_INSPECTION_INCOMPLETE');
  const coverageLimitations = [
    'Fixed read-only checks cover accessible selected paths only; they cannot prove malware absence or a fully secured server.',
    'Signature checks select at most 25,000 PHP/JavaScript files below 8 MiB per root. Antivirus has 25 MiB file and 300 MiB scan limits; larger or inaccessible content is not certified.'
  ];
  if (scanLimitReached) coverageLimitations.push('The selected PHP/JavaScript file count exceeded the scan bound.');
  if (platform === 'Unknown') coverageLimitations.push('The server platform could not be identified.');
  if (!scannedFiles) coverageLimitations.push('No selected PHP/JavaScript files were analyzed.');
  if (roots.length > 100 || observations.length > 500) { scanLimitReached = true; coverageLimitations.push('The retained web-root or observation limit was reached.'); }
  if (malwareScannerStatus === 'NOT_INSTALLED') coverageLimitations.push('ClamAV is not installed for this account; only bounded signature checks ran.');
  else if (malwareScannerStatus === 'TIMED_OUT') coverageLimitations.push('Antivirus exceeded its deadline; its result is incomplete, not a clean scan.');
  else if (malwareScannerStatus === 'FAILED') coverageLimitations.push('Antivirus failed or could not start; its result is incomplete, not a clean scan.');
  coverageLimitations.push(...[...warnings].map(warning => warningMessages[warning]!));
  const coverageState = scanLimitReached || platform === 'Unknown' || !scannedFiles || malwareScannerStatus !== 'COMPLETED' || warnings.size ? 'INCOMPLETE' : 'BOUNDED';
  return { platform, roots: [...new Set(roots)].slice(0, 100), scannedFiles, scanLimitReached, malwareScanner, malwareScannerStatus, coverageState, coverageLimitations, observations: observations.slice(0, 500) };
}

export async function inspectServerReadOnly(client: Client): Promise<ServerInspection> {
  return parseServerInspectionOutput(await executeScript(client, serverInspectionScript));
}
