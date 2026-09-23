import { createHash } from 'node:crypto';
import { Client, type ConnectConfig } from 'ssh2';
import { resolvePublicTarget } from '@zerochack/scanner';

export type SshAccess = { host: string; port: number; username: string; authMethod: string; secret: string; hostKeyFingerprint?: string | null };
export type ServerObservationKind = 'WORLD_WRITABLE' | 'EXCESSIVE_SECRET_PERMISSIONS' | 'SSH_AUTH_FILE_WRITABLE' | 'SENSITIVE_FILE' | 'PUBLIC_VCS_DIRECTORY' | 'PHP_IN_UPLOADS' | 'HIDDEN_SCRIPT' | 'MALWARE_SIGNATURE' | 'CLAMAV_DETECTION' | 'SUSPICIOUS_PROCESS' | 'SUSPICIOUS_CRON';
export type ServerObservation = { kind: ServerObservationKind; path: string; detail?: string };
export type ServerInspection = { platform: string; roots: string[]; scannedFiles: number; scanLimitReached: boolean; malwareScanner: 'CLAMAV' | 'SIGNATURES_ONLY'; observations: ServerObservation[] };

function fingerprint(key: Buffer): string { return `SHA256:${createHash('sha256').update(key).digest('base64')}`; }

export async function connectSsh(access: SshAccess): Promise<{ client: Client; fingerprint: string }> {
  const addresses = await resolvePublicTarget(new URL(`https://${access.host}`));
  const selected = addresses[0]!; let observedFingerprint = ''; let keyChanged = false;
  const config: ConnectConfig = {
    host: selected.address, port: access.port, username: access.username, readyTimeout: 12_000,
    hostVerifier: (key: Buffer) => { observedFingerprint = fingerprint(key); keyChanged = Boolean(access.hostKeyFingerprint && access.hostKeyFingerprint !== observedFingerprint); return !keyChanged; },
    ...(access.authMethod === 'SSH_KEY' ? { privateKey: access.secret } : { password: access.secret })
  };
  return new Promise((resolve, reject) => {
    const client = new Client(); const timer = setTimeout(() => { client.end(); reject(Object.assign(new Error('SSH connection timed out'), { code: 'SSH_TIMEOUT' })); }, 15_000);
    client.once('ready', () => { clearTimeout(timer); resolve({ client, fingerprint: observedFingerprint }); });
    client.once('error', (error) => { clearTimeout(timer); client.end(); reject(Object.assign(error, { code: keyChanged ? 'SSH_HOST_KEY_CHANGED' : /authentication/iu.test(error.message) ? 'SSH_AUTH_FAILED' : 'SSH_CONNECTION_FAILED' })); });
    client.connect(config);
  });
}

function executeScript(client: Client, script: string, timeoutMs = 120_000): Promise<string> {
  return new Promise((resolve, reject) => client.exec('LC_ALL=C sh -s', (error, stream) => {
    if (error) { reject(error); return; }
    const chunks: Buffer[] = []; let size = 0; let settled = false;
    const timer = setTimeout(() => { if (settled) return; settled = true; stream.close(); reject(Object.assign(new Error('Server inspection timed out'), { code: 'SSH_INSPECTION_TIMEOUT' })); }, timeoutMs);
    const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(Buffer.concat(chunks).toString('utf8')); };
    stream.on('data', (chunk: Buffer) => { if (size < 1_048_576) { const remaining = 1_048_576 - size; chunks.push(chunk.subarray(0, remaining)); size += Math.min(chunk.length, remaining); } });
    stream.stderr.on('data', () => undefined); stream.once('close', finish); stream.once('error', (streamError: Error) => { if (settled) return; settled = true; clearTimeout(timer); reject(streamError); });
    stream.end(script);
  }));
}

export const serverInspectionScript = String.raw`set +e
MAX_CODE_FILES=25000
seen_roots='|'
roots=''
clean() { printf '%s' "$1" | tr '\t\r\n' '   '; }
emit() { printf '%s\t%s\t%s\n' "$1" "$(clean "$2")" "$(clean "$3")"; }
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
for marker in $(find "$HOME" -maxdepth 5 -type f \( -name wp-config.php -o -name composer.json -o -name package.json -o -name index.php \) -print 2>/dev/null | head -80); do add_root "$(dirname "$marker")"; done
IFS=$marker_ifs
[ -n "$roots" ] || add_root "$HOME"

if [ -d "$HOME/.ssh" ]; then
  find "$HOME/.ssh" -maxdepth 1 -type f \( -name authorized_keys -o -name authorized_keys2 \) -perm -0022 -print 2>/dev/null | while IFS= read -r file; do emit SSH_AUTH_FILE_WRITABLE "$file" 'SSH authorization file is writable by group or other users'; done
fi

scanned=0
limit_reached=0
old_ifs=$IFS
IFS='
'
for root in $roots; do
  [ -n "$root" ] || continue
  find "$root" -xdev -type f -perm -0002 -print 2>/dev/null | head -100 | while IFS= read -r file; do emit WORLD_WRITABLE "$file" 'mode permits writes by any local user'; done
  find "$root" -xdev -type f \( -name .env -o -name .htpasswd -o -name wp-config.php -o -name id_rsa -o -name '*.pem' -o -name '*.sql' -o -name '*.bak' -o -name '*.zip' -o -name '*.tar.gz' \) -print 2>/dev/null | head -100 | while IFS= read -r file; do emit SENSITIVE_FILE "$file" 'sensitive or backup filename beneath web root'; done
  find "$root" -xdev -type f \( -name .env -o -name .htpasswd -o -name wp-config.php -o -name id_rsa -o -name '*.pem' \) -perm -0004 -print 2>/dev/null | head -100 | while IFS= read -r file; do emit EXCESSIVE_SECRET_PERMISSIONS "$file" 'credential-bearing file is readable by other local users'; done
  find "$root" -xdev -type d \( -name .git -o -name .svn -o -name .hg \) -print 2>/dev/null | head -50 | while IFS= read -r dir; do emit PUBLIC_VCS_DIRECTORY "$dir" 'version-control metadata beneath web root'; done
  find "$root" -xdev -type f -path '*/uploads/*' \( -name '*.php' -o -name '*.phtml' -o -name '*.phar' -o -name '*.cgi' -o -name '*.pl' \) -print 2>/dev/null | head -100 | while IFS= read -r file; do emit PHP_IN_UPLOADS "$file" 'server-executable script in an upload directory'; done
  find "$root" -xdev -type f \( -name '.*.php' -o -name '.*.phtml' -o -name '.*.phar' \) -print 2>/dev/null | head -100 | while IFS= read -r file; do emit HIDDEN_SCRIPT "$file" 'hidden server-side script beneath web root'; done
  count=$(find "$root" -xdev -type f \( -name '*.php' -o -name '*.phtml' -o -name '*.phar' -o -name '*.js' \) -size -8M -print 2>/dev/null | head -$MAX_CODE_FILES | wc -l | tr -d ' '); scanned=$((scanned + count))
  extra=$(find "$root" -xdev -type f \( -name '*.php' -o -name '*.phtml' -o -name '*.phar' -o -name '*.js' \) -size -8M -print 2>/dev/null | head -$((MAX_CODE_FILES + 1)) | wc -l | tr -d ' ')
  [ "$extra" -gt "$MAX_CODE_FILES" ] && limit_reached=1
  find "$root" -xdev -type f \( -name '*.php' -o -name '*.phtml' -o -name '*.phar' -o -name '*.js' \) -size -8M -print 2>/dev/null | head -$MAX_CODE_FILES | while IFS= read -r file; do
    LC_ALL=C grep -I -q -E 'eval[[:space:]]*\([[:space:]]*(base64_decode|gzinflate)|gzinflate[[:space:]]*\([[:space:]]*base64_decode|base64_decode[[:space:]]*\([^)]{0,120}\)[[:space:]]*;[[:space:]]*(eval|assert)|FilesMan|WSO[[:space:]_-]*Shell|b374k|c99shell|r57shell|str_rot13[[:space:]]*\([[:space:]]*base64_decode' "$file" 2>/dev/null && emit MALWARE_SIGNATURE "$file" 'high-confidence obfuscated web-shell signature'
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
    timeout 75s clamscan --infected --no-summary --max-filesize=25M --max-scansize=300M -r "$@" 2>/dev/null
  else
    clamscan --infected --no-summary --max-filesize=25M --max-scansize=300M -r "$@" 2>/dev/null
  fi | sed -n 's/: \([^:]*\) FOUND$/\t\1/p' | head -100 | while IFS="$(printf '\t')" read -r file signature; do emit CLAMAV_DETECTION "$file" "$signature"; done
else
  printf 'MALWARE_SCANNER\tSIGNATURES_ONLY\n'
fi

ps -eo comm= 2>/dev/null | grep -E '^(xmrig|kinsing|kdevtmpfsi|watchbog|cryptominer)$' | sort -u | head -20 | while IFS= read -r process; do emit SUSPICIOUS_PROCESS "$process" 'process name matches a known cryptominer or bot indicator'; done
if crontab -l 2>/dev/null | grep -E -q '(curl|wget).*(sh|bash)|base64[[:space:]]+-d|/dev/shm/|kdevtmpfsi|kinsing|xmrig'; then emit SUSPICIOUS_CRON 'user-crontab' 'scheduled downloader, decoder, or known malware indicator'; fi
printf 'SCANNED_FILES\t%s\n' "$scanned"
printf 'SCAN_LIMIT_REACHED\t%s\n' "$limit_reached"
`;

const observationKinds = new Set<ServerObservationKind>(['WORLD_WRITABLE', 'EXCESSIVE_SECRET_PERMISSIONS', 'SSH_AUTH_FILE_WRITABLE', 'SENSITIVE_FILE', 'PUBLIC_VCS_DIRECTORY', 'PHP_IN_UPLOADS', 'HIDDEN_SCRIPT', 'MALWARE_SIGNATURE', 'CLAMAV_DETECTION', 'SUSPICIOUS_PROCESS', 'SUSPICIOUS_CRON']);

export function parseServerInspectionOutput(output: string): ServerInspection {
  let platform = 'Unknown'; let scannedFiles = 0; let scanLimitReached = false; let malwareScanner: ServerInspection['malwareScanner'] = 'SIGNATURES_ONLY'; const roots: string[] = []; const observations: ServerObservation[] = [];
  for (const line of output.split(/\r?\n/u)) {
    const [kind, rawPath = '', rawDetail = ''] = line.split('\t'); const path = rawPath.trim().slice(0, 2048); const detail = rawDetail.trim().slice(0, 500);
    if (kind === 'PLATFORM') platform = path.slice(0, 200) || 'Unknown';
    else if (kind === 'ROOT' && path.startsWith('/')) roots.push(path);
    else if (kind === 'SCANNED_FILES') scannedFiles = Math.max(0, Number.parseInt(path, 10) || 0);
    else if (kind === 'SCAN_LIMIT_REACHED') scanLimitReached = path === '1';
    else if (kind === 'MALWARE_SCANNER') malwareScanner = path === 'CLAMAV' ? 'CLAMAV' : 'SIGNATURES_ONLY';
    else if (observationKinds.has(kind as ServerObservationKind) && path && (path.startsWith('/') || kind === 'SUSPICIOUS_PROCESS' || kind === 'SUSPICIOUS_CRON')) observations.push({ kind: kind as ServerObservationKind, path, ...(detail ? { detail } : {}) });
  }
  return { platform, roots: [...new Set(roots)].slice(0, 100), scannedFiles, scanLimitReached, malwareScanner, observations: observations.slice(0, 500) };
}

export async function inspectServerReadOnly(client: Client): Promise<ServerInspection> {
  return parseServerInspectionOutput(await executeScript(client, serverInspectionScript));
}
