import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseServerInspectionOutput, serverInspectionProgram, serverInspectionScript } from './ssh-toolkit.js';

const pythonAvailable = spawnSync('python3', ['-I', '-B', '--version'], { timeout: 2000 }).status === 0;
const fixtureDirectories: string[] = [];
afterEach(() => { for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'codebandage-inspection-test-')); fixtureDirectories.push(directory);
  const root = join(directory, 'public_html'); const bin = join(directory, 'bin'); mkdirSync(root); mkdirSync(bin);
  writeFileSync(join(bin, 'clamscan'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'clamscan'), 0o700);
  return { directory, root, bin };
}
function runFixture(target: ReturnType<typeof fixture>, edits: Array<[string, string]> = []) {
  // Only synthetic HOME/public_html is touched. Never inspect a developer host's
  // web roots, /proc, crontab or real antivirus installation in these benchmarks.
  let program = serverInspectionProgram.replace("COMMON_ROOTS = ['/var/www', '/srv/www']", 'COMMON_ROOTS = []').replace('    antivirus(); persistence()', '    antivirus()');
  for (const [before, after] of edits) { expect(program).toContain(before); program = program.replace(before, after); }
  const started = performance.now();
  const result = spawnSync('python3', ['-I', '-B', '-'], { input: program, encoding: 'utf8', env: { HOME: target.directory, PATH: `${target.bin}:/usr/bin:/bin`, LC_ALL: 'C' }, timeout: 8000, maxBuffer: 1_048_576 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe('');
  return { result: parseServerInspectionOutput(result.stdout), output: result.stdout, elapsedMs: performance.now() - started };
}

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

  it.skipIf(!pythonAvailable).each([[0,'COMPLETED'],[1,'COMPLETED'],[2,'FAILED'],[124,'TIMED_OUT'],[137,'TIMED_OUT']])('preserves real bounded antivirus child exit %s', (code, status) => {
    const target = fixture(); writeFileSync(join(target.root, 'index.php'), '<?php echo "fixture";');
    writeFileSync(join(target.bin, 'clamscan'), `#!/bin/sh\nprintf '%s: Test.Signature FOUND\\n' '${join(target.root, 'index.php')}'\nexit ${code}\n`);
    const checked = runFixture(target); expect(checked.result).toMatchObject({ malwareScanner: 'CLAMAV', malwareScannerStatus: status });
    expect(checked.result.observations).toContainEqual({ kind: 'CLAMAV_DETECTION', path: join(target.root, 'index.php'), detail: 'Test.Signature' });
  });

  it('keeps the remote workflow read-only and resource bounded', () => {
    expect(serverInspectionScript).toContain('MAX_FILES = 2500'); expect(serverInspectionScript).toContain('TOTAL_SECONDS = 55');
    expect(serverInspectionScript).toContain('start_new_session=True'); expect(serverInspectionScript).toContain('os.killpg');
    expect(serverInspectionScript).toContain('python3 -I -B -'); expect(serverInspectionScript).not.toContain('find ');
    expect(serverInspectionScript).not.toMatch(/\b(?:rm|mv|cp|chmod|chown|truncate|mktemp)\b/u);
    expect(serverInspectionScript).toContain('INSPECTION_COMPLETE');
    const syntax = spawnSync('/bin/sh', ['-n'], { input: serverInspectionScript, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(syntax.status).toBe(0); expect(syntax.stderr).toBe('');
  });

  it('rejects malformed or fabricated progress rather than treating it as completion', () => {
    const output = completedOutput().replace('SCANNED_FILES\t824', 'INSPECTION_PROGRESS\tINSPECTING_FILES\t12\nSCANNED_FILES\t824');
    expect(parseServerInspectionOutput(output)).toMatchObject({ scannedFiles: 824, coverageState: 'BOUNDED' });
    for (const malformed of ['INSPECTION_PROGRESS\tREPAIRED\t12', 'INSPECTION_PROGRESS\tINSPECTING_FILES\t2501', 'INSPECTION_PROGRESS\tINSPECTING_FILES\tno']) expect(() => parseServerInspectionOutput(output.replace('INSPECTION_PROGRESS\tINSPECTING_FILES\t12', malformed))).toThrow();
  });

  it('returns explicit metadata-only incomplete evidence when Python is unavailable', () => {
    const target = fixture();
    const checked = spawnSync('/bin/sh', ['-s'], { input: serverInspectionScript, encoding: 'utf8', env: { HOME: target.directory, PATH: target.bin }, timeout: 2000, maxBuffer: 20000 });
    expect(checked.status, checked.stderr).toBe(0); const result = parseServerInspectionOutput(checked.stdout);
    expect(result).toMatchObject({ coverageState: 'INCOMPLETE', scannedFiles: 0, scanLimitReached: true }); expect(result.coverageLimitations.join(' ')).toContain('Python 3 is unavailable');
  });

  it.skipIf(!pythonAvailable)('benchmarks a representative PHP tree plus 25,000 assets without repeated recursive scans', () => {
    const target = fixture();
    for (let group = 0; group < 50; group++) {
      const directory = join(target.root, `assets-${group}`); mkdirSync(directory);
      for (let index = 0; index < 500; index++) writeFileSync(join(directory, `${index}.css`), 'body{}');
    }
    for (let index = 0; index < 1000; index++) writeFileSync(join(target.root, `${index}.php`), '<?php echo "synthetic fixture";');
    writeFileSync(join(target.root, 'bad.php'), '<?php eval(base64_decode("synthetic"));');
    const checked = runFixture(target); expect(checked.result.scannedFiles).toBe(1001); expect(checked.elapsedMs).toBeLessThan(7000);
    expect(checked.result.observations.some((item) => item.kind === 'MALWARE_SIGNATURE' && item.path.endsWith('/bad.php'))).toBe(true);
    process.stdout.write(`inspection-benchmark ${JSON.stringify({ fixture: '1001-code-plus-25000-assets', elapsedMs: Math.round(checked.elapsedMs), scannedFiles: checked.result.scannedFiles, coverageState: checked.result.coverageState })}\n`);
  }, 30000);

  it.skipIf(!pythonAvailable)('enforces shared entry, depth, content-file and byte budgets with incomplete coverage', () => {
    const target = fixture();
    for (let index = 0; index < 6; index++) writeFileSync(join(target.root, `${index}.php`), '<?php echo "budget fixture";');
    const deep = join(target.root, 'one', 'two', 'three'); mkdirSync(deep, { recursive: true }); writeFileSync(join(deep, 'hidden.php'), '<?php echo 1;');
    for (const [before, after, warning] of [
      ['MAX_ENTRIES = 40000', 'MAX_ENTRIES = 2', '40,000-entry'],
      ['MAX_FILES = 2500', 'MAX_FILES = 2', '2,500-file'],
      ['MAX_DEPTH = 16', 'MAX_DEPTH = 0', 'depth-16'],
      ['MAX_BYTES = 32 * 1024 * 1024', 'MAX_BYTES = 8', '32 MiB'],
      ['MAX_FILE_BYTES = 256 * 1024', 'MAX_FILE_BYTES = 8', '256 KiB']
    ] as const) {
      const checked = runFixture(target, [[before, after]]); expect(checked.result.coverageState).toBe('INCOMPLETE'); expect(checked.result.scanLimitReached).toBe(true); expect(checked.result.coverageLimitations.join(' ')).toContain(warning);
    }
  });

  it.skipIf(!pythonAvailable)('returns incomplete measured results after 500 retained indicators, not a parser failure', () => {
    const target = fixture();
    for (let index = 0; index < 501; index++) { const file = join(target.root, `${index}.php`); writeFileSync(file, '<?php echo 1;'); chmodSync(file, 0o666); }
    const checked = runFixture(target); expect(checked.result.scannedFiles).toBe(501); expect(checked.result.observations).toHaveLength(500); expect(checked.result.coverageState).toBe('INCOMPLETE'); expect(checked.result.coverageLimitations.join(' ')).toContain('retained observation limit');
  });

  it.skipIf(!pythonAvailable)('bounds adversarial signature data without executing it or returning source', () => {
    const target = fixture(); const source = 'base64_decode('.repeat(14000) + 'synthetic-pattern-data';
    writeFileSync(join(target.root, 'adversarial.php'), source);
    const checked = runFixture(target); expect(checked.result.scannedFiles).toBe(1); expect(checked.result.observations).toEqual([]); expect(checked.elapsedMs).toBeLessThan(2000); expect(checked.output).not.toContain('synthetic-pattern-data');
  });

  it.skipIf(!pythonAvailable)('does not recursively inspect a generic HOME when no web root is identified', () => {
    const target = fixture(); rmSync(target.root, { recursive: true }); mkdirSync(join(target.directory, 'private'));
    writeFileSync(join(target.directory, 'private', 'hidden.js'), 'eval(base64_decode("not-a-web-root"))');
    const checked = runFixture(target); expect(checked.result.scannedFiles).toBe(0); expect(checked.result.observations).toEqual([]); expect(checked.result.coverageLimitations.join(' ')).toContain('No supported web root');
  });

  it.skipIf(!pythonAvailable)('kills the entire timed-out antivirus process group and preserves incomplete evidence', () => {
    const target = fixture(); writeFileSync(join(target.root, 'index.php'), '<?php echo 1;'); const pidFile = join(target.directory, 'synthetic-child.pid');
    writeFileSync(join(target.bin, 'clamscan'), `#!/usr/bin/python3\nimport os,sys,subprocess,time\nchild=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'])\nwith open(${JSON.stringify(pidFile)},'w') as out: out.write(str(child.pid))\ntime.sleep(30)\n`);
    const checked = runFixture(target, [['AV_SECONDS = 15', 'AV_SECONDS = .2']]); expect(checked.result).toMatchObject({ malwareScannerStatus: 'TIMED_OUT', coverageState: 'INCOMPLETE' }); expect(checked.elapsedMs).toBeLessThan(3000);
    const pid = Number(readFileSync(pidFile, 'utf8'));
    try { const status = readFileSync(`/proc/${pid}/stat`, 'utf8'); expect(status.split(' ')[2]).toBe('Z'); } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
  });
});
