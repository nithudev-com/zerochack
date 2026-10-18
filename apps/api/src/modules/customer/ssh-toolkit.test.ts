import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { parseServerInspectionOutput, serverInspectionScript } from './ssh-toolkit.js';

const completedOutput = (scanner = 'CLAMAV', status = 'COMPLETED') => [
  'PLATFORM\tLinux 6.8 x86_64', 'ROOT\t/var/www/site\t', 'SCANNED_FILES\t824', 'SCAN_LIMIT_REACHED\t0',
  `MALWARE_SCANNER\t${scanner}`, `MALWARE_STATUS\t${status}`, 'INSPECTION_COMPLETE\tssh-inspection-v3'
].join('\n');

describe('read-only SSH inspection', () => {
  it('parses measured coverage and real server indicators without file contents', () => {
    const result = parseServerInspectionOutput([
      'PLATFORM\tLinux 6.8 x86_64',
      'ROOT\t/var/www/site\t',
      'SCANNED_FILES\t824',
      'SCAN_LIMIT_REACHED\t0',
      'MALWARE_SCANNER\tCLAMAV',
      'MALWARE_STATUS\tCOMPLETED',
      'MALWARE_SIGNATURE\t/var/www/site/uploads/cache.php\thigh-confidence obfuscated web-shell signature',
      'CLAMAV_DETECTION\t/var/www/site/tmp/payload.php\tWin.Trojan.Agent',
      'SUSPICIOUS_CRON\tuser-crontab\tscheduled downloader',
      'EXCESSIVE_SECRET_PERMISSIONS\t/var/www/site/.env\tcredential-bearing file is readable by other local users',
      'SSH_AUTH_FILE_WRITABLE\t/home/deploy/.ssh/authorized_keys\tSSH authorization file is writable by group or other users',
      'INSPECTION_COMPLETE\tssh-inspection-v3'
    ].join('\n'));

    expect(result).toMatchObject({ platform: 'Linux 6.8 x86_64', roots: ['/var/www/site'], scannedFiles: 824, scanLimitReached: false, malwareScanner: 'CLAMAV', malwareScannerStatus: 'COMPLETED', coverageState: 'BOUNDED' });
    expect(result.observations.map((item) => item.kind)).toEqual(['MALWARE_SIGNATURE', 'CLAMAV_DETECTION', 'SUSPICIOUS_CRON', 'EXCESSIVE_SECRET_PERMISSIONS', 'SSH_AUTH_FILE_WRITABLE']);
    expect(JSON.stringify(result)).not.toContain('file contents');
    expect(result.coverageLimitations.join(' ')).toContain('cannot prove malware absence');
  });

  it.each([
    '', completedOutput().replace('INSPECTION_COMPLETE\tssh-inspection-v3', ''),
    completedOutput().replace('SCANNED_FILES\t824', 'SCANNED_FILES\tno'),
    completedOutput().replace('SCANNED_FILES\t824', 'SCANNED_FILES\t824partial'),
    completedOutput().replace('SCAN_LIMIT_REACHED\t0', 'SCAN_LIMIT_REACHED\tunknown'),
    completedOutput().replace('MALWARE_STATUS\tCOMPLETED\n', ''),
    completedOutput().replace('ROOT\t/var/www/site\t\n', ''),
    completedOutput().replace('ROOT\t/var/www/site', 'ROOT\trelative/site'),
    completedOutput().replace('MALWARE_SCANNER\tCLAMAV', 'MALWARE_SCANNER\tunknown'),
    completedOutput() + '\nSCANNED_FILES\t0',
    completedOutput().replace('SCANNED_FILES\t824', 'SCANNED_FILES\t824\nSCANNED_FILES\t0'),
    completedOutput().replace('SCANNED_FILES\t824', 'WORLD_WRITABLE\trelative/path\nSCANNED_FILES\t824'),
    completedOutput().replace('SCANNED_FILES\t824', 'UNRECOGNIZED\tvalue\nSCANNED_FILES\t824'),
    completedOutput('SIGNATURES_ONLY', 'COMPLETED'), completedOutput('CLAMAV', 'NOT_INSTALLED')
  ])('rejects incomplete or inconsistent evidence rather than returning zero findings', output => {
    expect(() => parseServerInspectionOutput(output)).toThrow(expect.objectContaining({ code: 'SSH_INSPECTION_INCOMPLETE' }));
  });

  it.each(['TIMED_OUT','FAILED'])('retains %s antivirus coverage without claiming a clean scan', status => {
    const result = parseServerInspectionOutput(completedOutput('CLAMAV', status));
    expect(result).toMatchObject({ malwareScanner: 'CLAMAV', malwareScannerStatus: status, coverageState: 'INCOMPLETE', observations: [] });
    expect(result.coverageLimitations.join(' ')).toContain('not a clean scan');
  });

  it('retains missing antivirus, filesystem errors, empty file coverage and explicit bounds honestly', () => {
    expect(parseServerInspectionOutput(completedOutput('SIGNATURES_ONLY', 'NOT_INSTALLED'))).toMatchObject({ coverageState: 'INCOMPLETE', malwareScannerStatus: 'NOT_INSTALLED' });
    const output = completedOutput().replace('SCANNED_FILES\t824', 'COVERAGE_WARNING\tFILESYSTEM_ENUMERATION_INCOMPLETE\tignored remote detail\nSCANNED_FILES\t0').replace('SCAN_LIMIT_REACHED\t0', 'SCAN_LIMIT_REACHED\t1');
    const result = parseServerInspectionOutput(output);
    expect(result).toMatchObject({ coverageState: 'INCOMPLETE', scanLimitReached: true, scannedFiles: 0 });
    expect(result.coverageLimitations.join(' ')).toContain('inaccessible');
    expect(result.coverageLimitations.join(' ')).not.toContain('ignored remote detail');
  });

  it('labels retained observation truncation and rejects excessive raw output', () => {
    const output = completedOutput().replace('SCANNED_FILES\t824', Array.from({ length: 501 }, (_, index) => `WORLD_WRITABLE\t/var/www/site/${index}\tpermission indicator`).join('\n') + '\nSCANNED_FILES\t824');
    const result = parseServerInspectionOutput(output);
    expect(result.observations).toHaveLength(500); expect(result.coverageState).toBe('INCOMPLETE'); expect(result.scanLimitReached).toBe(true);
    expect(() => parseServerInspectionOutput('x'.repeat(1_048_577))).toThrow(expect.objectContaining({ code: 'SSH_INSPECTION_OUTPUT_LIMIT' }));
  });

  it.each([[0,'COMPLETED'],[1,'COMPLETED'],[2,'FAILED'],[124,'TIMED_OUT'],[137,'TIMED_OUT']])('preserves real antivirus exit %s through the output-filter pipeline', (code, status) => {
    // Execute only the antivirus formatter against shell functions, never a host
    // directory, antivirus install, customer SSH server or application command.
    const block = serverInspectionScript.slice(serverInspectionScript.indexOf('if command -v clamscan'), serverInspectionScript.indexOf('\nps -eo comm='));
    const fixture = `roots='/synthetic-fixture'\nold_ifs=$IFS\nemit() { printf '%s\\t%s\\t%s\\n' "$1" "$2" "$3"; }\nclamscan() { printf '/synthetic-fixture/test.php: Test.Signature FOUND\\n'; return ${code}; }\ntimeout() { shift; "$@"; }\n${block}`;
    const result = spawnSync('/bin/sh', ['-s'], { input: fixture, encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 5000, maxBuffer: 20000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(result.stdout).toContain(`MALWARE_STATUS\t${status}`);
    expect(result.stdout).toContain('CLAMAV_DETECTION\t/synthetic-fixture/test.php\tTest.Signature');
  });

  it('keeps the remote workflow read-only and resource bounded', () => {
    expect(serverInspectionScript).toContain('MAX_CODE_FILES=25000');
    expect(serverInspectionScript).toContain('timeout 75s clamscan');
    expect(serverInspectionScript).not.toMatch(/\b(?:rm|mv|cp|chmod|chown|truncate|mktemp)\b/u);
    expect(serverInspectionScript).toContain('INSPECTION_COMPLETE');
    const syntax = spawnSync('/bin/sh', ['-n'], { input: serverInspectionScript, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(syntax.status).toBe(0); expect(syntax.stderr).toBe('');
  });
});
