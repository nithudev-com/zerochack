import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectServerReadOnly, parseServerInspectionOutput as parseInspection, serverInspectionProgramForHostname, serverInspectionScript as createInspectionScript } from './ssh-toolkit.js';
import type { Client } from 'ssh2';

const hostname = 'example.test';
const protocolRoot = `/var/www/${hostname}/html`;
const serverInspectionScript = createInspectionScript(hostname);
const parseServerInspectionOutput = (output: string) => parseInspection(output, hostname);

const pythonAvailable = spawnSync('python3', ['-I', '-B', '--version'], { timeout: 2000 }).status === 0;
const fixtureDirectories: string[] = [];
afterEach(() => { for (const directory of fixtureDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'codebandage-inspection-test-')); fixtureDirectories.push(directory);
  const root = join(directory, 'domains', hostname, 'public_html'); const bin = join(directory, 'bin'); mkdirSync(root, { recursive: true }); mkdirSync(bin);
  writeFileSync(join(bin, 'clamscan'), '#!/bin/sh\nexit 0\n'); chmodSync(join(bin, 'clamscan'), 0o700);
  return { directory, root, bin };
}
function runFixture(target: ReturnType<typeof fixture>, edits: Array<[string, string]> = [], selectedHostname = hostname) {
  // Only the synthetic exact-domain directory is selected. System conventions
  // are disabled in fixtures; customer/developer website content is never read.
  let program = serverInspectionProgramForHostname(selectedHostname).replace(/^SYSTEM_ROOT_CANDIDATES = .+$/mu, 'SYSTEM_ROOT_CANDIDATES = []');
  for (const [before, after] of edits) { expect(program).toContain(before); program = program.replace(before, after); }
  const started = performance.now();
  const result = spawnSync('python3', ['-I', '-B', '-'], { input: program, encoding: 'utf8', env: { HOME: target.directory, PATH: `${target.bin}:/usr/bin:/bin`, LC_ALL: 'C' }, timeout: 8000, maxBuffer: 1_048_576 });
  expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0); expect(result.stderr).toBe('');
  return { result: parseInspection(result.stdout, selectedHostname), output: result.stdout, elapsedMs: performance.now() - started };
}

const completedOutput = (scanner = 'SIGNATURES_ONLY', status = 'NOT_INSTALLED') => [
  'SCOPE_MODE\tWEBSITE', `SCOPE_HOSTNAME\t${hostname}`, 'ROOT_BINDING\tDOMAIN_DIRECTORY_CONVENTION',
  'PLATFORM\tLinux 6.8 x86_64', `ROOT\t${protocolRoot}\t`, 'SCANNED_FILES\t824', 'SCAN_LIMIT_REACHED\t0',
  `MALWARE_SCANNER\t${scanner}`, `MALWARE_STATUS\t${status}`, 'INSPECTION_COMPLETE\tssh-inspection-v4'
].join('\n');

describe('read-only SSH inspection', () => {
  it('parses measured coverage and real server indicators without file contents', () => {
    const result = parseServerInspectionOutput([
      'PLATFORM\tLinux 6.8 x86_64',
      'SCOPE_MODE\tWEBSITE', `SCOPE_HOSTNAME\t${hostname}`, 'ROOT_BINDING\tDOMAIN_DIRECTORY_CONVENTION',
      `ROOT\t${protocolRoot}\t`,
      'SCANNED_FILES\t824',
      'SCAN_LIMIT_REACHED\t0',
      'MALWARE_SCANNER\tSIGNATURES_ONLY',
      'MALWARE_STATUS\tNOT_INSTALLED',
      `MALWARE_SIGNATURE\t${protocolRoot}/uploads/cache.php\thigh-confidence obfuscated web-shell signature`,
      `EXCESSIVE_SECRET_PERMISSIONS\t${protocolRoot}/.env\tcredential-bearing file is readable by other local users`,
      'INSPECTION_COMPLETE\tssh-inspection-v4'
    ].join('\n'));

    expect(result).toMatchObject({ scope: { mode: 'WEBSITE', hostname, rootBinding: 'DOMAIN_DIRECTORY_CONVENTION' }, platform: 'Linux 6.8 x86_64', roots: [protocolRoot], scannedFiles: 824, scanLimitReached: false, malwareScanner: 'SIGNATURES_ONLY', malwareScannerStatus: 'NOT_INSTALLED', coverageState: 'INCOMPLETE' });
    expect(result.observations.map((item) => item.kind)).toEqual(['MALWARE_SIGNATURE', 'EXCESSIVE_SECRET_PERMISSIONS']);
    expect(JSON.stringify(result)).not.toContain('file contents');
    expect(result.coverageLimitations.join(' ')).toContain('cannot prove malware absence');
  });

  it.each(['127.0.0.1', '164.68.114.89', '[2001:db8::1]', 'Example.test', 'example.test.', 'example.test/path', 'example.test;id', 'example.test\nid', 'localhost', '-example.test'])('rejects non-canonical filesystem scope %s before opening SSH exec', async selectedHostname => {
    let invoked = false; const client = { exec: () => { invoked = true; } } as unknown as Client;
    await expect(inspectServerReadOnly(client, selectedHostname)).rejects.toMatchObject({ code: 'SSH_INSPECTION_SCOPE_REQUIRED' });
    expect(invoked).toBe(false); expect(() => createInspectionScript(selectedHostname)).toThrow();
  });

  it.each([
    ['SCOPE_MODE\tWEBSITE\n', ''], ['ROOT_BINDING\tDOMAIN_DIRECTORY_CONVENTION\n', ''],
    [`SCOPE_HOSTNAME\t${hostname}`, 'SCOPE_HOSTNAME\tother.test'],
    [`ROOT\t${protocolRoot}`, `ROOT\t/domains/${hostname}/public_html`],
    [`ROOT\t${protocolRoot}`, 'ROOT\t/home/account/domains/other.test/public_html'],
    [`ROOT\t${protocolRoot}`, `ROOT\t${protocolRoot}/../html`]
  ])('rejects missing or mismatched website scope metadata', (before, after) => {
    expect(() => parseServerInspectionOutput(completedOutput().replace(before, after))).toThrow();
  });

  it.each([
    'WORLD_WRITABLE\t/home/account/domains/other.test/public_html/.env',
    `WORLD_WRITABLE\t${protocolRoot}/../../other.test/html/.env`,
    `WORLD_WRITABLE\t${protocolRoot}-sibling/.env`,
    'SSH_AUTH_FILE_WRITABLE\t/home/account/.ssh/authorized_keys',
    'SUSPICIOUS_CRON\tuser-crontab', 'SUSPICIOUS_PROCESS\txmrig'
  ])('rejects account-global and outside-root evidence instead of misattributing it', observation => {
    expect(() => parseServerInspectionOutput(completedOutput().replace('SCANNED_FILES\t824', `${observation}\nSCANNED_FILES\t824`))).toThrow();
  });

  it('accepts unresolved scope only with zero roots, files, observations and an explicit limitation', () => {
    const unresolved = completedOutput('CLAMAV', 'NOT_RUN_SCOPE').replace('ROOT_BINDING\tDOMAIN_DIRECTORY_CONVENTION', 'ROOT_BINDING\tUNRESOLVED').replace(`ROOT\t${protocolRoot}\t\n`, '').replace('SCANNED_FILES\t824', 'SCANNED_FILES\t0').replace('SCAN_LIMIT_REACHED\t0', 'SCAN_LIMIT_REACHED\t1').replace('INSPECTION_COMPLETE', 'COVERAGE_WARNING\tDOMAIN_ROOT_UNRESOLVED\tFixed scope limitation\nINSPECTION_COMPLETE');
    expect(parseServerInspectionOutput(unresolved)).toMatchObject({ scope: { rootBinding: 'UNRESOLVED' }, roots: [], scannedFiles: 0, observations: [], coverageState: 'INCOMPLETE' });
    for (const malformed of [unresolved.replace('SCANNED_FILES\t0', 'SCANNED_FILES\t1'), unresolved.replace('SCANNED_FILES\t0', `ROOT\t${protocolRoot}\nSCANNED_FILES\t0`), unresolved.replace('COVERAGE_WARNING\tDOMAIN_ROOT_UNRESOLVED\tFixed scope limitation\n', ''), unresolved.replace('SCANNED_FILES\t0', `WORLD_WRITABLE\t${protocolRoot}/.env\nSCANNED_FILES\t0`)]) expect(() => parseServerInspectionOutput(malformed)).toThrow();
  });

  it.each([
    '', completedOutput().replace('INSPECTION_COMPLETE\tssh-inspection-v4', ''),
    completedOutput().replace('ssh-inspection-v4', 'ssh-inspection-v3'),
    completedOutput().replace('SCANNED_FILES\t824', 'SCANNED_FILES\tno'),
    completedOutput().replace('SCANNED_FILES\t824', 'SCANNED_FILES\t824partial'),
    completedOutput().replace('SCAN_LIMIT_REACHED\t0', 'SCAN_LIMIT_REACHED\tunknown'),
    completedOutput().replace('MALWARE_STATUS\tNOT_INSTALLED\n', ''),
    completedOutput().replace(`ROOT\t${protocolRoot}\t\n`, ''),
    completedOutput().replace(`ROOT\t${protocolRoot}`, 'ROOT\trelative/site'),
    completedOutput().replace('MALWARE_SCANNER\tSIGNATURES_ONLY', 'MALWARE_SCANNER\tunknown'),
    completedOutput() + '\nSCANNED_FILES\t0',
    completedOutput().replace('SCANNED_FILES\t824', 'SCANNED_FILES\t824\nSCANNED_FILES\t0'),
    completedOutput().replace('SCANNED_FILES\t824', 'WORLD_WRITABLE\trelative/path\nSCANNED_FILES\t824'),
    completedOutput().replace('SCANNED_FILES\t824', 'UNRECOGNIZED\tvalue\nSCANNED_FILES\t824'),
    completedOutput('SIGNATURES_ONLY', 'COMPLETED'), completedOutput('CLAMAV', 'NOT_INSTALLED')
  ])('rejects incomplete or inconsistent evidence rather than returning zero findings', output => {
    expect(() => parseServerInspectionOutput(output)).toThrow(expect.objectContaining({ code: expect.stringMatching(/^SSH_INSPECTION_(?:INCOMPLETE|SCOPE_INVALID)$/u) }));
  });

  it.each(['COMPLETED','TIMED_OUT','FAILED'])('rejects impossible external-antivirus status %s for the v4 website runner', status => {
    expect(() => parseServerInspectionOutput(completedOutput('CLAMAV', status))).toThrow(expect.objectContaining({ code: 'SSH_INSPECTION_INCOMPLETE' }));
  });

  it.each([
    `CLAMAV_DETECTION\t${protocolRoot}/malware.php\tSynthetic.Signature`,
    'INSPECTION_PROGRESS\tANTIVIRUS\t12', 'INSPECTION_PROGRESS\tCHECKING_PERSISTENCE\t12'
  ])('rejects impossible AV findings or account-wide progress instead of claiming execution', record => {
    expect(() => parseServerInspectionOutput(completedOutput().replace('SCANNED_FILES\t824', `${record}\nSCANNED_FILES\t824`))).toThrow(expect.objectContaining({ code: 'SSH_INSPECTION_INCOMPLETE' }));
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
    const output = completedOutput().replace('SCANNED_FILES\t824', Array.from({ length: 501 }, (_, index) => `WORLD_WRITABLE\t${protocolRoot}/${index}\tpermission indicator`).join('\n') + '\nSCANNED_FILES\t824');
    const result = parseServerInspectionOutput(output);
    expect(result.observations).toHaveLength(500); expect(result.coverageState).toBe('INCOMPLETE'); expect(result.scanLimitReached).toBe(true);
    expect(() => parseServerInspectionOutput('x'.repeat(1_048_577))).toThrow(expect.objectContaining({ code: 'SSH_INSPECTION_OUTPUT_LIMIT' }));
  });

  it.skipIf(!pythonAvailable)('does not launch available external antivirus without a scope-preserving verified runner', () => {
    const target = fixture(); writeFileSync(join(target.root, 'index.php'), '<?php echo "fixture";');
    const marker = join(target.directory, 'external-antivirus-was-executed');
    writeFileSync(join(target.bin, 'clamscan'), `#!/bin/sh\nprintf 'unexpected' > '${marker}'\nexit 0\n`);
    const checked = runFixture(target); expect(checked.result).toMatchObject({ malwareScanner: 'CLAMAV', malwareScannerStatus: 'NOT_RUN_SCOPE', coverageState: 'INCOMPLETE', scannedFiles: 1 });
    expect(checked.result.observations).toEqual([]); expect(existsSync(marker)).toBe(false); expect(checked.result.coverageLimitations.join(' ')).toContain('External antivirus was not run');
  });

  it.skipIf(!pythonAvailable)('distinguishes actually missing antivirus from present but unexecuted antivirus', () => {
    const target = fixture(); writeFileSync(join(target.root, 'index.php'), '<?php echo 1;');
    const checked = runFixture(target, [["shutil.which('clamscan')", 'None']]);
    expect(checked.result).toMatchObject({ malwareScanner: 'SIGNATURES_ONLY', malwareScannerStatus: 'NOT_INSTALLED', scannedFiles: 1, coverageState: 'INCOMPLETE' });
  });

  it('keeps the remote workflow read-only and resource bounded', () => {
    expect(serverInspectionScript).toContain('MAX_FILES = 2500'); expect(serverInspectionScript).toContain('TOTAL_SECONDS = 55');
    expect(serverInspectionScript).toContain('dir_fd='); expect(serverInspectionScript).toContain('os.O_NOFOLLOW');
    expect(serverInspectionScript).toContain('python3 -I -B -'); expect(serverInspectionScript).not.toContain('find ');
    expect(serverInspectionScript).not.toMatch(/\b(?:rm|mv|cp|chmod|chown|truncate|mktemp)\b/u);
    expect(serverInspectionScript).toContain('INSPECTION_COMPLETE');
    expect(serverInspectionScript).not.toMatch(/subprocess|crontab|authorized_keys|\/proc\/|os\.realpath/u);
    const syntax = spawnSync('/bin/sh', ['-n'], { input: serverInspectionScript, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    expect(syntax.status).toBe(0); expect(syntax.stderr).toBe('');
  });

  it('rejects malformed or fabricated progress rather than treating it as completion', () => {
    const output = completedOutput().replace('SCANNED_FILES\t824', 'INSPECTION_PROGRESS\tINSPECTING_FILES\t12\nSCANNED_FILES\t824');
    expect(parseServerInspectionOutput(output)).toMatchObject({ scannedFiles: 824, coverageState: 'INCOMPLETE' });
    for (const malformed of ['INSPECTION_PROGRESS\tREPAIRED\t12', 'INSPECTION_PROGRESS\tINSPECTING_FILES\t2501', 'INSPECTION_PROGRESS\tINSPECTING_FILES\tno']) expect(() => parseServerInspectionOutput(output.replace('INSPECTION_PROGRESS\tINSPECTING_FILES\t12', malformed))).toThrow();
  });

  it('returns explicit metadata-only incomplete evidence when Python is unavailable', () => {
    const target = fixture();
    const checked = spawnSync('/bin/sh', ['-s'], { input: serverInspectionScript, encoding: 'utf8', env: { HOME: target.directory, PATH: target.bin }, timeout: 2000, maxBuffer: 20000 });
    expect(checked.status, checked.stderr).toBe(0); const result = parseServerInspectionOutput(checked.stdout);
    expect(result).toMatchObject({ scope: { mode: 'WEBSITE', hostname, rootBinding: 'UNRESOLVED' }, roots: [], observations: [], coverageState: 'INCOMPLETE', scannedFiles: 0, scanLimitReached: true, malwareScannerStatus: 'NOT_RUN_SCOPE' }); expect(result.coverageLimitations.join(' ')).toContain('Python 3 is unavailable'); expect(checked.stdout).not.toContain(target.directory);
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

  it.skipIf(!pythonAvailable)('does not recursively inspect generic HOME or assume its primary public_html belongs to the selected website', () => {
    const target = fixture(); rmSync(target.root, { recursive: true }); mkdirSync(join(target.directory, 'private'));
    writeFileSync(join(target.directory, 'private', 'hidden.js'), 'eval(base64_decode("not-a-web-root"))');
    mkdirSync(join(target.directory, 'public_html')); writeFileSync(join(target.directory, 'public_html', 'index.php'), 'eval(base64_decode("not-proven-primary-domain"))');
    const checked = runFixture(target); expect(checked.result).toMatchObject({ scope: { rootBinding: 'UNRESOLVED' }, roots: [], scannedFiles: 0, observations: [] }); expect(checked.result.coverageLimitations.join(' ')).toContain('No exact domain-directory'); expect(checked.output).not.toContain(target.directory);
  });

  it.skipIf(!pythonAvailable)('never scans or returns sibling website, account-persistence or generic-root evidence', () => {
    const target = fixture(); writeFileSync(join(target.root, 'index.php'), '<?php echo "selected website";');
    const sibling = join(target.directory, 'domains', 'other-domain.test', 'public_html'); mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, '.env'), 'SECRET=must-never-read'); writeFileSync(join(sibling, 'malware.php'), 'eval(base64_decode("unrelated-website"))');
    mkdirSync(join(target.directory, '.ssh')); writeFileSync(join(target.directory, '.ssh', 'authorized_keys'), 'account-global-key'); chmodSync(join(target.directory, '.ssh', 'authorized_keys'), 0o666);
    const checked = runFixture(target); expect(checked.result).toMatchObject({ roots: [target.root], scannedFiles: 1, observations: [] });
    expect(checked.output).not.toContain('other-domain.test'); expect(checked.output).not.toContain('authorized_keys'); expect(checked.output).not.toContain('must-never-read'); expect(checked.output).not.toContain('unrelated-website');
  });

  it.skipIf(!pythonAvailable).each(['unknown.test', 'www.example.test'])('does not guess aliases or sibling roots for %s', selectedHostname => {
    const target = fixture(); writeFileSync(join(target.root, 'malware.php'), 'eval(base64_decode("not-selected"))');
    const checked = runFixture(target, [], selectedHostname); expect(checked.result).toMatchObject({ scope: { hostname: selectedHostname, rootBinding: 'UNRESOLVED' }, roots: [], observations: [], scannedFiles: 0 }); expect(checked.output).not.toContain(target.root);
  });

  it.skipIf(!pythonAvailable)('fails closed when more than one exact-domain convention matches', () => {
    const target = fixture(); const alternate = join(target.directory, 'domains', hostname, 'httpdocs'); mkdirSync(alternate); writeFileSync(join(target.root, 'index.php'), '<?php echo 1;'); writeFileSync(join(alternate, 'index.php'), '<?php echo 2;');
    const checked = runFixture(target); expect(checked.result).toMatchObject({ scope: { rootBinding: 'UNRESOLVED' }, roots: [], observations: [], scannedFiles: 0 }); expect(checked.result.coverageLimitations.join(' ')).toContain('More than one'); expect(checked.output).not.toContain(target.directory);
  });

  it.skipIf(!pythonAvailable)('does not follow an ancestor symlink when resolving the selected domain root', () => {
    const target = fixture(); const sibling = join(target.directory, 'private-other-root'); mkdirSync(sibling); writeFileSync(join(sibling, 'malware.php'), 'eval(base64_decode("wrong-site"))');
    rmSync(target.root, { recursive: true }); symlinkSync(sibling, target.root);
    const checked = runFixture(target); expect(checked.result).toMatchObject({ scope: { rootBinding: 'UNRESOLVED' }, roots: [], observations: [], scannedFiles: 0 }); expect(checked.output).not.toContain('private-other-root');
  });

  it.skipIf(!pythonAvailable)('keeps reads on the pinned directory handle if its pathname is replaced by another-site symlink', () => {
    const target = fixture(); writeFileSync(join(target.root, 'index.php'), '<?php echo "selected website";');
    const sibling = join(target.directory, 'unrelated-site'); mkdirSync(sibling); writeFileSync(join(sibling, 'malware.php'), 'eval(base64_decode("never-read-other-site"))');
    const replacement = `        os.rename(roots[0], roots[0] + '-original')\n        os.symlink(${JSON.stringify(sibling)}, roots[0])\n        progress('INSPECTING_FILES'); walk()`;
    const checked = runFixture(target, [["        progress('INSPECTING_FILES'); walk()", replacement]]);
    expect(checked.result).toMatchObject({ roots: [target.root], observations: [], scannedFiles: 1 }); expect(checked.output).not.toContain('unrelated-site'); expect(checked.output).not.toContain('never-read-other-site');
  });

  it.skipIf(!pythonAvailable).each(['before', 'after'])('drops all file evidence when a hard link appears %s the content read', timing => {
    const target = fixture(); const file = join(target.root, 'malware.php'); writeFileSync(file, 'eval(base64_decode("shared-site-file"))'); chmodSync(file, 0o666);
    const shared = join(target.directory, 'other-site-hardlink');
    const before = timing === 'before' ? '        before = os.fstat(descriptor)' : '        after = os.fstat(descriptor)';
    const replacement = `        os.link(path, ${JSON.stringify(shared)})\n${before}`;
    const checked = runFixture(target, [[before, replacement]]); expect(checked.result).toMatchObject({ observations: [], scannedFiles: 0 }); expect(checked.result.coverageLimitations.join(' ')).toContain('multiple hard links'); expect(checked.output).not.toContain('malware.php');
  });

  it.skipIf(!pythonAvailable)('skips descendant symlinks, shared hard links and nested hosting trees without returning other-site paths', () => {
    const target = fixture(); writeFileSync(join(target.root, 'index.php'), '<?php echo 1;');
    const sibling = join(target.directory, 'other-site'); mkdirSync(sibling); const shared = join(sibling, 'private.php'); writeFileSync(shared, 'eval(base64_decode("wrong-site-hardlink"))');
    symlinkSync(sibling, join(target.root, 'linked-site')); symlinkSync(shared, join(target.root, 'linked.php')); linkSync(shared, join(target.root, 'shared.php')); chmodSync(shared, 0o666);
    const nested = join(target.root, 'domains', 'nested-other.test', 'public_html'); mkdirSync(nested, { recursive: true }); writeFileSync(join(nested, '.env'), 'SECRET=nested-site');
    const checked = runFixture(target); expect(checked.result).toMatchObject({ scannedFiles: 1, observations: [] }); expect(checked.output).not.toContain('other-site'); expect(checked.output).not.toContain('nested-other.test'); expect(checked.output).not.toContain('shared.php'); expect(checked.result.coverageLimitations.join(' ')).toMatch(/multiple hard links/u); expect(checked.result.coverageLimitations.join(' ')).toMatch(/nested hosting-layout/u);
  });
});
