// Reversible remediation action engine.
//
// Every fix produced here is idempotent and undoable. The fix-target path comes
// from the read-only SSH inspection output, which is UNTRUSTED (an attacker who
// controls the scanned server can plant hostile file names), so every path is
// validated and shell-quoted before it is ever placed in a command. No action in
// the "safe" set deletes data or kills processes: permission fixes restore the
// previous mode on rollback, quarantine moves a file aside and can move it back.

export type ServerObservationKind =
  | 'WORLD_WRITABLE'
  | 'EXCESSIVE_SECRET_PERMISSIONS'
  | 'SSH_AUTH_FILE_WRITABLE'
  | 'SENSITIVE_FILE'
  | 'PUBLIC_VCS_DIRECTORY'
  | 'PHP_IN_UPLOADS'
  | 'HIDDEN_SCRIPT'
  | 'MALWARE_SIGNATURE'
  | 'CLAMAV_DETECTION'
  | 'SUSPICIOUS_PROCESS'
  | 'SUSPICIOUS_CRON';

export type FixActionKey =
  | 'PERM_REMOVE_WORLD_WRITE'
  | 'PERM_RESTRICT_SECRET'
  | 'PERM_RESTRICT_SSH_AUTH'
  | 'PERM_RESTRICT_SENSITIVE'
  | 'PERM_RESTRICT_VCS_DIR'
  | 'QUARANTINE_FILE';

// Authorization scopes a RemediationAuthorization must grant for each action.
export const FIX_SCOPE = {
  PERMISSIONS: 'files.permissions',
  QUARANTINE: 'files.quarantine'
} as const;
export type FixScope = (typeof FIX_SCOPE)[keyof typeof FIX_SCOPE];

export type FixActionDefinition = {
  actionKey: FixActionKey;
  scope: FixScope;
  // Whether the action operates on a directory (affects verification/chmod).
  target: 'FILE' | 'DIRECTORY';
  // Human-readable, shown in the approval card. `path` is interpolated by caller.
  title: string;
  summary: (path: string) => string;
  // What rolling back does, for the approval card.
  undoSummary: string;
};

const DEFINITIONS: Record<FixActionKey, FixActionDefinition> = {
  PERM_REMOVE_WORLD_WRITE: {
    actionKey: 'PERM_REMOVE_WORLD_WRITE',
    scope: FIX_SCOPE.PERMISSIONS,
    target: 'FILE',
    title: 'Remove world-writable permission',
    summary: (path) => `Remove the "writable by any local user" bit from ${path}.`,
    undoSummary: 'Restores the exact permission mode the file had before the fix.'
  },
  PERM_RESTRICT_SECRET: {
    actionKey: 'PERM_RESTRICT_SECRET',
    scope: FIX_SCOPE.PERMISSIONS,
    target: 'FILE',
    title: 'Restrict credential file to owner only',
    summary: (path) => `Remove group and other access from the credential file ${path} (owner keeps access).`,
    undoSummary: 'Restores the exact permission mode the file had before the fix.'
  },
  PERM_RESTRICT_SSH_AUTH: {
    actionKey: 'PERM_RESTRICT_SSH_AUTH',
    scope: FIX_SCOPE.PERMISSIONS,
    target: 'FILE',
    title: 'Restrict SSH authorized_keys permissions',
    summary: (path) => `Remove group and other write access from ${path} so sshd will trust it.`,
    undoSummary: 'Restores the exact permission mode the file had before the fix.'
  },
  PERM_RESTRICT_SENSITIVE: {
    actionKey: 'PERM_RESTRICT_SENSITIVE',
    scope: FIX_SCOPE.PERMISSIONS,
    target: 'FILE',
    title: 'Block public access to exposed file',
    summary: (path) => `Remove "other" read/write/execute access from the exposed file ${path}.`,
    undoSummary: 'Restores the exact permission mode the file had before the fix.'
  },
  PERM_RESTRICT_VCS_DIR: {
    actionKey: 'PERM_RESTRICT_VCS_DIR',
    scope: FIX_SCOPE.PERMISSIONS,
    target: 'DIRECTORY',
    title: 'Block public access to version-control directory',
    summary: (path) => `Remove "other" access from the exposed version-control directory ${path}.`,
    undoSummary: 'Restores the exact permission mode the directory had before the fix.'
  },
  QUARANTINE_FILE: {
    actionKey: 'QUARANTINE_FILE',
    scope: FIX_SCOPE.QUARANTINE,
    target: 'FILE',
    title: 'Quarantine suspicious file',
    summary: (path) => `Move ${path} into a locked quarantine folder (not deleted) so it can no longer execute.`,
    undoSummary: 'Moves the file back to its original path from quarantine.'
  }
};

const OBSERVATION_TO_ACTION: Partial<Record<ServerObservationKind, FixActionKey>> = {
  WORLD_WRITABLE: 'PERM_REMOVE_WORLD_WRITE',
  EXCESSIVE_SECRET_PERMISSIONS: 'PERM_RESTRICT_SECRET',
  SSH_AUTH_FILE_WRITABLE: 'PERM_RESTRICT_SSH_AUTH',
  SENSITIVE_FILE: 'PERM_RESTRICT_SENSITIVE',
  PUBLIC_VCS_DIRECTORY: 'PERM_RESTRICT_VCS_DIR',
  PHP_IN_UPLOADS: 'QUARANTINE_FILE',
  HIDDEN_SCRIPT: 'QUARANTINE_FILE',
  MALWARE_SIGNATURE: 'QUARANTINE_FILE',
  CLAMAV_DETECTION: 'QUARANTINE_FILE'
  // SUSPICIOUS_PROCESS and SUSPICIOUS_CRON are intentionally absent: killing a
  // process or editing crontab is not safely reversible and needs the
  // destructive playbook, not the safe self-serve path.
};

export class UnsafeRemediationPathError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'UnsafeRemediationPathError';
  }
}

export type PathSafetyOptions = {
  // Absolute roots the fix is confined to. When provided, the target must sit
  // inside one of them (SSH authorized_keys files are allowed by suffix because
  // they live under the user's home, outside the scanned web roots).
  allowedRoots?: readonly string[];
};

const SSH_AUTH_SUFFIXES = ['/.ssh/authorized_keys', '/.ssh/authorized_keys2'];

export function assertSafeRemotePath(path: string, options: PathSafetyOptions = {}): void {
  if (typeof path !== 'string' || path.length === 0) {
    throw new UnsafeRemediationPathError('PATH_EMPTY', 'Remediation target path is empty');
  }
  if (path.length > 2048) {
    throw new UnsafeRemediationPathError('PATH_TOO_LONG', 'Remediation target path is too long');
  }
  if (!path.startsWith('/')) {
    throw new UnsafeRemediationPathError('PATH_NOT_ABSOLUTE', 'Remediation target path must be absolute');
  }
  // Reject NUL and any control character (covers newline, tab, CR, escape, etc.).
  if (/[\u0000-\u001f\u007f]/u.test(path)) {
    throw new UnsafeRemediationPathError('PATH_CONTROL_CHAR', 'Remediation target path contains a control character');
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw new UnsafeRemediationPathError('PATH_TRAVERSAL', 'Remediation target path contains a traversal segment');
  }
  if (options.allowedRoots && options.allowedRoots.length > 0) {
    const isSshAuth = SSH_AUTH_SUFFIXES.some((suffix) => path.endsWith(suffix));
    const insideRoot = options.allowedRoots.some(
      (root) => root.startsWith('/') && (path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`))
    );
    if (!insideRoot && !isSshAuth) {
      throw new UnsafeRemediationPathError('PATH_OUT_OF_SCOPE', 'Remediation target path is outside the assessed roots');
    }
  }
}

// POSIX single-quote escaping: wrap in single quotes and replace each embedded
// quote with '\'' . Safe for /bin/sh word-splitting and globbing.
export function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

export type FixResultStatus = 'APPLIED' | 'NOOP' | 'SKIPPED' | 'FAILED';
export type FixResult = {
  status: FixResultStatus;
  // Opaque token needed to roll the change back (previous octal mode, or the
  // quarantine destination path). Empty when there is nothing to undo.
  undoToken: string;
  detail: string;
};

const RESULT_PREFIX = 'FIXRESULT';
const QUARANTINE_DIRNAME = '.zeroroot-quarantine';

// Portable "read the octal mode" snippet: GNU stat, then BSD/macOS stat.
const STAT_MODE = `stat -c '%a' "$F" 2>/dev/null || stat -f '%Lp' "$F" 2>/dev/null`;

function emit(status: FixResultStatus, tokenExpr: string, detailExpr: string): string {
  // Tab-separated, one line, so the executor can parse it unambiguously.
  return `printf '%s\\t%s\\t%s\\t%s\\n' ${shellQuote(RESULT_PREFIX)} ${shellQuote(status)} "${tokenExpr}" "${detailExpr}"`;
}

export type BuildFixOptions = {
  // Namespaces the quarantine folder so concurrent runs never collide and an
  // undo always targets this run's files.
  runId: string;
  // Base directory under which quarantine lives. Defaults to the user's $HOME.
  quarantineBase?: string;
};

function quarantineDir(options: BuildFixOptions): string {
  const base = options.quarantineBase ? shellQuote(options.quarantineBase) : '"$HOME"';
  return `${base}/${QUARANTINE_DIRNAME}/${shellQuote(options.runId)}`;
}

export function buildFixScript(actionKey: FixActionKey, path: string, options: BuildFixOptions): string {
  const F = shellQuote(path);
  const header = `set +e\nF=${F}\n`;
  switch (actionKey) {
    case 'PERM_REMOVE_WORLD_WRITE':
      return (
        header +
        `if [ ! -e "$F" ]; then ${emit('SKIPPED', '', 'target no longer exists')}; exit 0; fi\n` +
        `OLD=$(${STAT_MODE})\n` +
        `if [ -z "$OLD" ]; then ${emit('FAILED', '', 'could not read current mode')}; exit 0; fi\n` +
        `chmod o-w "$F" 2>/dev/null\n` +
        `NEW=$(${STAT_MODE})\n` +
        `case "$NEW" in *[2367]) ${emit('FAILED', '$OLD', 'world-write bit remained')}; exit 0 ;; esac\n` +
        `if [ "$OLD" = "$NEW" ]; then ${emit('NOOP', '$OLD', 'already not world-writable')}; else ${emit('APPLIED', '$OLD', 'removed world-write')}; fi\n`
      );
    case 'PERM_RESTRICT_SECRET':
      return permissionFix(F, 'go-rwx', 'restricted to owner only');
    case 'PERM_RESTRICT_SSH_AUTH':
      return permissionFix(F, 'go-w', 'removed group/other write');
    case 'PERM_RESTRICT_SENSITIVE':
      return permissionFix(F, 'o-rwx', 'removed other access');
    case 'PERM_RESTRICT_VCS_DIR':
      return permissionFix(F, 'o-rwx', 'removed other access');
    case 'QUARANTINE_FILE': {
      const Q = quarantineDir(options);
      return (
        header +
        `if [ ! -e "$F" ]; then ${emit('SKIPPED', '', 'target no longer exists')}; exit 0; fi\n` +
        `if [ ! -f "$F" ]; then ${emit('SKIPPED', '', 'target is not a regular file')}; exit 0; fi\n` +
        `Q=${Q}\n` +
        `mkdir -p "$Q" 2>/dev/null && chmod 700 "$Q" 2>/dev/null\n` +
        `if [ ! -d "$Q" ]; then ${emit('FAILED', '', 'could not create quarantine folder')}; exit 0; fi\n` +
        `SAFE=$(printf '%s' "$F" | tr '/' '_' | tr -cd 'A-Za-z0-9._-')\n` +
        `DEST="$Q/$(date +%s 2>/dev/null)-$SAFE"\n` +
        `mv "$F" "$DEST" 2>/dev/null\n` +
        `if [ -e "$F" ] || [ ! -e "$DEST" ]; then ${emit('FAILED', '', 'move to quarantine failed')}; exit 0; fi\n` +
        `chmod 600 "$DEST" 2>/dev/null\n` +
        `${emit('APPLIED', '$DEST', 'moved to quarantine')}\n`
      );
    }
    default: {
      const exhaustive: never = actionKey;
      throw new Error(`Unknown fix action: ${String(exhaustive)}`);
    }
  }
}

function permissionFix(F: string, chmodArg: string, appliedDetail: string): string {
  return (
    `set +e\nF=${F}\n` +
    `if [ ! -e "$F" ]; then ${emit('SKIPPED', '', 'target no longer exists')}; exit 0; fi\n` +
    `OLD=$(${STAT_MODE})\n` +
    `if [ -z "$OLD" ]; then ${emit('FAILED', '', 'could not read current mode')}; exit 0; fi\n` +
    `chmod ${chmodArg} "$F" 2>/dev/null\n` +
    `NEW=$(${STAT_MODE})\n` +
    `if [ -z "$NEW" ]; then ${emit('FAILED', '$OLD', 'could not confirm new mode')}; exit 0; fi\n` +
    `if [ "$OLD" = "$NEW" ]; then ${emit('NOOP', '$OLD', 'permissions already restricted')}; else ${emit('APPLIED', '$OLD', appliedDetail)}; fi\n`
  );
}

export function parseFixResult(output: string): FixResult {
  for (const line of output.split(/\r?\n/u)) {
    const parts = line.split('\t');
    if (parts[0] === RESULT_PREFIX && parts.length >= 2) {
      const status = parts[1] as FixResultStatus;
      if (status === 'APPLIED' || status === 'NOOP' || status === 'SKIPPED' || status === 'FAILED') {
        return { status, undoToken: (parts[2] ?? '').trim().slice(0, 2048), detail: (parts[3] ?? '').trim().slice(0, 500) };
      }
    }
  }
  return { status: 'FAILED', undoToken: '', detail: 'no result line returned by the server' };
}

export function buildRollbackScript(actionKey: FixActionKey, path: string, undoToken: string): string {
  const F = shellQuote(path);
  if (actionKey === 'QUARANTINE_FILE') {
    assertSafeRemotePath(undoToken); // the quarantine destination is also a real path
    const DEST = shellQuote(undoToken);
    return (
      `set +e\nF=${F}\nDEST=${DEST}\n` +
      `if [ ! -e "$DEST" ]; then ${emit('SKIPPED', '', 'quarantined file is gone')}; exit 0; fi\n` +
      `if [ -e "$F" ]; then ${emit('SKIPPED', '', 'original path is occupied')}; exit 0; fi\n` +
      `mv "$DEST" "$F" 2>/dev/null\n` +
      `if [ -e "$F" ]; then ${emit('APPLIED', '', 'restored from quarantine')}; else ${emit('FAILED', '', 'restore failed')}; fi\n`
    );
  }
  // Permission actions: restore the captured octal mode.
  if (!/^[0-7]{3,4}$/u.test(undoToken)) {
    throw new UnsafeRemediationPathError('UNDO_TOKEN_INVALID', 'Permission undo token is not an octal mode');
  }
  return (
    `set +e\nF=${F}\n` +
    `if [ ! -e "$F" ]; then ${emit('SKIPPED', '', 'target no longer exists')}; exit 0; fi\n` +
    `chmod ${undoToken} "$F" 2>/dev/null && ${emit('APPLIED', '', 'restored previous mode')} || ${emit('FAILED', '', 'chmod restore failed')}\n`
  );
}

export type FixPlan = {
  supported: true;
  actionKey: FixActionKey;
  scope: FixScope;
  title: string;
  summary: string;
  undoSummary: string;
  target: 'FILE' | 'DIRECTORY';
  path: string;
  script: string;
};
export type UnsupportedFix = { supported: false; reason: string };

export function planFixForObservation(
  observation: { kind: ServerObservationKind; path: string },
  options: BuildFixOptions & PathSafetyOptions
): FixPlan | UnsupportedFix {
  const actionKey = OBSERVATION_TO_ACTION[observation.kind];
  if (!actionKey) {
    return { supported: false, reason: `No safe, reversible fix is available for ${observation.kind}; it requires specialist review.` };
  }
  assertSafeRemotePath(observation.path, options);
  const definition = DEFINITIONS[actionKey];
  return {
    supported: true,
    actionKey,
    scope: definition.scope,
    title: definition.title,
    summary: definition.summary(observation.path),
    undoSummary: definition.undoSummary,
    target: definition.target,
    path: observation.path,
    script: buildFixScript(actionKey, observation.path, options)
  };
}

export function fixActionDefinition(actionKey: FixActionKey): FixActionDefinition {
  return DEFINITIONS[actionKey];
}

const OBSERVATION_KINDS = new Set<ServerObservationKind>([
  'WORLD_WRITABLE',
  'EXCESSIVE_SECRET_PERMISSIONS',
  'SSH_AUTH_FILE_WRITABLE',
  'SENSITIVE_FILE',
  'PUBLIC_VCS_DIRECTORY',
  'PHP_IN_UPLOADS',
  'HIDDEN_SCRIPT',
  'MALWARE_SIGNATURE',
  'CLAMAV_DETECTION',
  'SUSPICIOUS_PROCESS',
  'SUSPICIOUS_CRON'
]);

// Plans a fix directly from a persisted finding's stored evidence metadata.
// The metadata is treated defensively: `kind`, `path`, and the confining
// `roots` are re-validated here rather than trusted to be well-formed.
export function planFixForFinding(
  metadata: { kind?: unknown; path?: unknown; roots?: unknown },
  options: BuildFixOptions
): FixPlan | UnsupportedFix {
  const kind = metadata.kind;
  const path = metadata.path;
  if (typeof kind !== 'string' || !OBSERVATION_KINDS.has(kind as ServerObservationKind)) {
    return { supported: false, reason: 'This finding has no recorded fixable observation kind.' };
  }
  if (typeof path !== 'string') {
    return { supported: false, reason: 'This finding has no recorded target path.' };
  }
  const allowedRoots = Array.isArray(metadata.roots)
    ? metadata.roots.filter((root): root is string => typeof root === 'string')
    : typeof metadata.roots === 'string'
      ? metadata.roots.split('\n').filter((root) => root.length > 0)
      : undefined;
  return planFixForObservation(
    { kind: kind as ServerObservationKind, path },
    { ...options, ...(allowedRoots && allowedRoots.length > 0 ? { allowedRoots } : {}) }
  );
}

export function isSupportedObservationKind(kind: ServerObservationKind): boolean {
  return Boolean(OBSERVATION_TO_ACTION[kind]);
}
