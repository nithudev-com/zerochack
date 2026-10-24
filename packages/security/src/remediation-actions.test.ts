import { describe, expect, it } from 'vitest';
import {
  assertSafeRemotePath,
  buildFixScript,
  buildRollbackScript,
  fixActionDefinition,
  isSupportedObservationKind,
  parseFixResult,
  planFixForFinding,
  planFixForObservation,
  shellQuote,
  UnsafeRemediationPathError,
  type FixActionKey,
  type ServerObservationKind
} from './remediation-actions.js';

const OPTIONS = { runId: 'run-1234', allowedRoots: ['/var/www'] };

describe('shellQuote', () => {
  it('wraps plain values in single quotes', () => expect(shellQuote('/var/www/x')).toBe(`'/var/www/x'`));
  it('neutralizes embedded single quotes', () => expect(shellQuote(`a'b`)).toBe(`'a'\\''b'`));
  it('neutralizes command substitution and separators as literal text', () => {
    const quoted = shellQuote('/var/www/$(reboot);rm -rf /`id`');
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // No unescaped single quote can terminate the string early.
    expect(quoted.slice(1, -1).includes("'") === false || quoted.includes(`'\\''`)).toBe(true);
  });
});

describe('assertSafeRemotePath', () => {
  it('accepts an absolute path inside an allowed root', () =>
    expect(() => assertSafeRemotePath('/var/www/html/index.php', { allowedRoots: ['/var/www'] })).not.toThrow());
  it('accepts an SSH authorized_keys file outside the web roots', () =>
    expect(() => assertSafeRemotePath('/home/deploy/.ssh/authorized_keys', { allowedRoots: ['/var/www'] })).not.toThrow());

  it.each<[string, string]>([
    ['', 'PATH_EMPTY'],
    ['relative/path', 'PATH_NOT_ABSOLUTE'],
    ['/var/www/../../etc/passwd', 'PATH_TRAVERSAL'],
    ['/var/www/evil\nrm -rf', 'PATH_CONTROL_CHAR'],
    ['/var/www/evil\u0000', 'PATH_CONTROL_CHAR'],
    ['/etc/shadow', 'PATH_OUT_OF_SCOPE']
  ])('rejects %j with %s', (path, code) =>
    expect(() => assertSafeRemotePath(path, { allowedRoots: ['/var/www'] })).toThrow(
      expect.objectContaining({ code })
    ));

  it('rejects an over-long path', () =>
    expect(() => assertSafeRemotePath(`/var/www/${'a'.repeat(3000)}`)).toThrow(
      expect.objectContaining({ code: 'PATH_TOO_LONG' })
    ));

  it('allows any absolute path when no roots are supplied', () =>
    expect(() => assertSafeRemotePath('/opt/app/config.env')).not.toThrow());
});

describe('planFixForObservation', () => {
  it.each<[ServerObservationKind, FixActionKey]>([
    ['WORLD_WRITABLE', 'PERM_REMOVE_WORLD_WRITE'],
    ['EXCESSIVE_SECRET_PERMISSIONS', 'PERM_RESTRICT_SECRET'],
    ['SSH_AUTH_FILE_WRITABLE', 'PERM_RESTRICT_SSH_AUTH'],
    ['SENSITIVE_FILE', 'PERM_RESTRICT_SENSITIVE'],
    ['PUBLIC_VCS_DIRECTORY', 'PERM_RESTRICT_VCS_DIR'],
    ['PHP_IN_UPLOADS', 'QUARANTINE_FILE'],
    ['HIDDEN_SCRIPT', 'QUARANTINE_FILE'],
    ['MALWARE_SIGNATURE', 'QUARANTINE_FILE'],
    ['CLAMAV_DETECTION', 'QUARANTINE_FILE']
  ])('maps %s to %s with a runnable script', (kind, actionKey) => {
    const plan = planFixForObservation({ kind, path: '/var/www/app/thing' }, OPTIONS);
    expect(plan.supported).toBe(true);
    if (!plan.supported) return;
    expect(plan.actionKey).toBe(actionKey);
    expect(plan.scope).toBe(fixActionDefinition(actionKey).scope);
    expect(plan.script).toContain('/var/www/app/thing');
    expect(plan.script).toContain('FIXRESULT');
  });

  it.each<ServerObservationKind>(['SUSPICIOUS_PROCESS', 'SUSPICIOUS_CRON'])(
    'refuses %s as not safely reversible',
    (kind) => {
      const plan = planFixForObservation({ kind, path: '/var/www/x' }, OPTIONS);
      expect(plan.supported).toBe(false);
      expect(isSupportedObservationKind(kind)).toBe(false);
    }
  );

  it('propagates path validation failures', () =>
    expect(() => planFixForObservation({ kind: 'WORLD_WRITABLE', path: '/etc/passwd' }, OPTIONS)).toThrow(
      UnsafeRemediationPathError
    ));
});

describe('buildFixScript shell safety', () => {
  it('keeps a malicious path fully quoted so it cannot execute', () => {
    const evil = '/var/www/$(touch pwned).php';
    const script = buildFixScript('QUARANTINE_FILE', evil, OPTIONS);
    // The path is present, but ONLY ever inside the single-quoted form.
    expect(script).toContain(shellQuote(evil));
    // After removing every single-quoted occurrence, the dangerous substitution
    // must not survive anywhere unquoted.
    const withoutQuoted = script.split(shellQuote(evil)).join('');
    expect(withoutQuoted).not.toContain('$(touch pwned)');
  });

  it('embeds the run id in the quarantine destination', () => {
    const script = buildFixScript('QUARANTINE_FILE', '/var/www/shell.php', { runId: 'abc-1' });
    expect(script).toContain('.zeroroot-quarantine');
    expect(script).toContain(shellQuote('abc-1'));
  });
});

describe('parseFixResult', () => {
  it('parses an applied result with an undo token', () =>
    expect(parseFixResult('noise\nFIXRESULT\tAPPLIED\t644\tremoved world-write\n')).toEqual({
      status: 'APPLIED',
      undoToken: '644',
      detail: 'removed world-write'
    }));
  it('parses a quarantine destination token', () =>
    expect(parseFixResult('FIXRESULT\tAPPLIED\t/home/u/.zeroroot-quarantine/run-1/1-x\tmoved to quarantine').undoToken).toBe(
      '/home/u/.zeroroot-quarantine/run-1/1-x'
    ));
  it('parses noop and skipped', () => {
    expect(parseFixResult('FIXRESULT\tNOOP\t600\tok').status).toBe('NOOP');
    expect(parseFixResult('FIXRESULT\tSKIPPED\t\tgone').status).toBe('SKIPPED');
  });
  it('fails closed when no result line is present', () =>
    expect(parseFixResult('permission denied\n').status).toBe('FAILED'));
  it('ignores an unknown status', () => expect(parseFixResult('FIXRESULT\tWEIRD\t\t').status).toBe('FAILED'));
});

describe('buildRollbackScript', () => {
  it('restores a captured octal mode', () => {
    const script = buildRollbackScript('PERM_REMOVE_WORLD_WRITE', '/var/www/x', '755');
    expect(script).toContain('chmod 755');
    expect(script).toContain(shellQuote('/var/www/x'));
  });
  it('rejects a non-octal undo token for a permission action', () =>
    expect(() => buildRollbackScript('PERM_RESTRICT_SECRET', '/var/www/x', 'rm -rf /')).toThrow(
      expect.objectContaining({ code: 'UNDO_TOKEN_INVALID' })
    ));
  it('moves a quarantined file back and validates the stored destination', () => {
    const script = buildRollbackScript('QUARANTINE_FILE', '/var/www/shell.php', '/home/u/.zeroroot-quarantine/r/1-x');
    expect(script).toContain('mv "$DEST" "$F"');
  });
  it('rejects an unsafe quarantine destination token', () =>
    expect(() => buildRollbackScript('QUARANTINE_FILE', '/var/www/x', '/var/www/$(reboot)\n')).toThrow(
      UnsafeRemediationPathError
    ));
});

describe('planFixForFinding (from persisted evidence metadata)', () => {
  it('plans from metadata with array roots', () => {
    const plan = planFixForFinding({ kind: 'WORLD_WRITABLE', path: '/var/www/x.php', roots: ['/var/www'] }, { runId: 'r1' });
    expect(plan.supported).toBe(true);
  });
  it('plans from metadata with newline-joined roots (DB form)', () => {
    const plan = planFixForFinding({ kind: 'QUARANTINE_FILE' as unknown as string, path: '/var/www/s.php', roots: '/var/www\n/srv/www' }, { runId: 'r1' });
    // QUARANTINE_FILE is not an observation kind; it must be rejected as not fixable.
    expect(plan.supported).toBe(false);
  });
  it('maps a real observation kind with string roots', () => {
    const plan = planFixForFinding({ kind: 'MALWARE_SIGNATURE', path: '/var/www/shell.php', roots: '/var/www' }, { runId: 'r1' });
    expect(plan.supported).toBe(true);
    if (plan.supported) expect(plan.actionKey).toBe('QUARANTINE_FILE');
  });
  it('rejects metadata with a missing or non-fixable kind', () => {
    expect(planFixForFinding({ path: '/var/www/x' }, { runId: 'r1' }).supported).toBe(false);
    expect(planFixForFinding({ kind: 'SUSPICIOUS_PROCESS', path: 'xmrig' }, { runId: 'r1' }).supported).toBe(false);
  });
  it('rejects metadata with a missing path', () =>
    expect(planFixForFinding({ kind: 'WORLD_WRITABLE' }, { runId: 'r1' }).supported).toBe(false));
  it('still enforces path safety through the metadata bridge', () =>
    expect(() => planFixForFinding({ kind: 'WORLD_WRITABLE', path: '/etc/passwd', roots: '/var/www' }, { runId: 'r1' })).toThrow(
      expect.objectContaining({ code: 'PATH_OUT_OF_SCOPE' })
    ));
});

describe('round-trip undo tokens', () => {
  it('a permission fix produces an octal token the rollback accepts', () => {
    const applied = parseFixResult('FIXRESULT\tAPPLIED\t664\trestricted');
    expect(() => buildRollbackScript('PERM_RESTRICT_SECRET', '/var/www/.env', applied.undoToken)).not.toThrow();
  });
  it('a quarantine fix produces a path token the rollback accepts', () => {
    const applied = parseFixResult('FIXRESULT\tAPPLIED\t/var/www/.zeroroot-quarantine/r/1-shell_php\tmoved');
    expect(() => buildRollbackScript('QUARANTINE_FILE', '/var/www/shell.php', applied.undoToken)).not.toThrow();
  });
});
