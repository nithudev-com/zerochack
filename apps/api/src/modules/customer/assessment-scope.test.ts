import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../errors.js';
import { assertWebsiteInspectionScope, websiteFindingScope } from './assessment-scope.js';

const hostname = 'nithudev.example';
const root = `/home/fixture/domains/${hostname}/public_html`;
function fixture() {
  return {
    scope: { mode: 'WEBSITE', hostname, rootBinding: 'DOMAIN_DIRECTORY_CONVENTION' },
    roots: [root], scannedFiles: 1, coverageState: 'INCOMPLETE', scanLimitReached: false,
    malwareScanner: 'SIGNATURES_ONLY', malwareScannerStatus: 'NOT_INSTALLED',
    coverageLimitations: ['Domain-directory convention is not live vhost attestation.'],
    observations: [{ kind: 'WORLD_WRITABLE', path: root + '/index.php' }]
  };
}

function rejected(value: unknown, expectedHost = hostname) {
  expect(() => assertWebsiteInspectionScope(value, expectedHost)).toThrow(ApiError);
  try { assertWebsiteInspectionScope(value, expectedHost); }
  catch (error) {
    expect(error).toMatchObject({ statusCode: 409, code: 'ASSESSMENT_SCOPE_VIOLATION' });
    expect(String(error)).not.toContain('/home/');
    expect(String(error)).not.toContain('sibling.example');
  }
}

describe('website-only assessment result scope', () => {
  it.each([
    root, `/home/fixture/domains/${hostname}/httpdocs`,
    `/var/www/${hostname}/public_html`, `/var/www/${hostname}/html`,
    `/srv/www/${hostname}/public_html`, `/var/www/vhosts/${hostname}/httpdocs`
  ])('accepts only a single conventional root and its strict descendants: %s', selectedRoot => {
    const result = fixture(); result.roots = [selectedRoot]; result.observations[0]!.path = selectedRoot + '/wp-content/index.php';
    expect(() => assertWebsiteInspectionScope(result, hostname)).not.toThrow();
  });

  it('accepts unresolved scope only as empty, explicitly incomplete evidence', () => {
    const result = { ...fixture(), scope: { mode: 'WEBSITE', hostname, rootBinding: 'UNRESOLVED' }, roots: [], observations: [], scannedFiles: 0, coverageState: 'INCOMPLETE', scanLimitReached: true };
    expect(() => assertWebsiteInspectionScope(result, hostname)).not.toThrow();
    for (const changed of [
      { roots: [root] }, { observations: fixture().observations }, { scannedFiles: 1 },
      { coverageState: 'BOUNDED' }, { scanLimitReached: false }, { coverageLimitations: [] }
    ]) rejected({ ...result, ...changed });
  });

  it.each([
    undefined, null, {}, { mode: 'ACCOUNT', hostname, rootBinding: 'DOMAIN_DIRECTORY_CONVENTION' },
    { mode: 'WEBSITE', hostname: 'sibling.example', rootBinding: 'DOMAIN_DIRECTORY_CONVENTION' },
    { mode: 'WEBSITE', hostname: 'NITHUDEV.EXAMPLE', rootBinding: 'DOMAIN_DIRECTORY_CONVENTION' },
    { mode: 'WEBSITE', hostname, rootBinding: 'GUESSED' }
  ])('rejects absent, broader, changed or unrecognized scope: %j', scope => {
    rejected({ ...fixture(), scope });
  });

  it.each([
    '/var/www', '/srv/www', '/home/fixture', '/home/fixture/public_html',
    '/home/fixture/domains/sibling.example/public_html',
    `/var/www/${hostname}.attacker.example/public_html`,
    `/var/www/www.${hostname}/public_html`, `/var/www/${hostname}/public_html/child`,
    `/var/www/${hostname}/public_html/`, `/var/www/${hostname}/../${hostname}/public_html`,
    `//var/www/${hostname}/public_html`, `/var/www/${hostname}/html\u0000`,
    `/var/www/${hostname}/html\n`, `/var/www/${hostname}/html\\child`
  ])('rejects generic, sibling, alias, nested or noncanonical roots: %s', selectedRoot => {
    rejected({ ...fixture(), roots: [selectedRoot], observations: [] });
  });

  it.each([{ roots: [] }, { roots: [root, root] }, { roots: [root, '/var/www/sibling.example/html'] }])('rejects zero or multiple resolved roots: %j', ({ roots }) => {
    rejected({ ...fixture(), roots });
  });

  it.each([
    root, root + '-sibling/index.php', root + '/../sibling.example/index.php',
    root + '/./index.php', root + '//index.php', '/etc/passwd',
    '/home/fixture/domains/sibling.example/public_html/index.php',
    root + '/index.php\u0000', root + '/index.php\n', root + '/dir\\index.php', 'index.php'
  ])('rejects escaped, prefix-only or malformed affected resources: %s', path => {
    rejected({ ...fixture(), observations: [{ kind: 'WORLD_WRITABLE', path }] });
  });

  it.each(['SUSPICIOUS_PROCESS', 'SUSPICIOUS_CRON', 'SSH_AUTH_FILE_WRITABLE', 'CLAMAV_DETECTION', 'UNRECOGNIZED'])('rejects account-global and unsupported observation kinds: %s', kind => {
    rejected({ ...fixture(), observations: [{ kind, path: root + '/index.php' }] });
  });

  it('accepts ClamAV presence only as explicitly unexecuted, incomplete coverage', () => {
    expect(() => assertWebsiteInspectionScope({ ...fixture(), malwareScanner: 'CLAMAV', malwareScannerStatus: 'NOT_RUN_SCOPE' }, hostname)).not.toThrow();
  });

  it.each([
    { malwareScanner: 'CLAMAV', malwareScannerStatus: 'COMPLETED' },
    { malwareScanner: 'CLAMAV', malwareScannerStatus: 'TIMED_OUT' },
    { malwareScanner: 'CLAMAV', malwareScannerStatus: 'FAILED' },
    { malwareScanner: 'CLAMAV', malwareScannerStatus: 'NOT_INSTALLED' },
    { malwareScanner: 'SIGNATURES_ONLY', malwareScannerStatus: 'NOT_RUN_SCOPE' },
    { malwareScanner: 'SIGNATURES_ONLY', malwareScannerStatus: 'COMPLETED' },
    { malwareScanner: 'UNKNOWN', malwareScannerStatus: 'NOT_INSTALLED' },
    { coverageState: 'BOUNDED' }, { coverageState: 'HEALTHY' }
  ])('rejects unsupported antivirus execution or clean-coverage claims: %j', changed => {
    rejected({ ...fixture(), ...changed });
  });

  it.each([null, undefined, [], 'raw output', { ...fixture(), roots: null }, { ...fixture(), observations: null }, { ...fixture(), scannedFiles: -1 }, { ...fixture(), scannedFiles: 2501 }, { ...fixture(), scannedFiles: 1.5 }].map(value => ({ value })))('fails closed on malformed result shape', ({ value }) => {
    rejected(value);
  });

  it.each(['', 'localhost', 'https://nithudev.example/', 'NITHUDEV.EXAMPLE', 'nithudev.example.', 'nithudev.example/other', 'nithudev..example', '-nithudev.example', 'nithudev.example\n'])('requires a canonical persisted hostname: %s', invalidHost => {
    rejected(fixture(), invalidHost);
    expect(() => websiteFindingScope(invalidHost)).toThrow(ApiError);
  });
});

describe('legacy SSH evidence filtering predicate', () => {
  it.each(['198.51.100.171', '[2001:db8::171]', '2001:db8::171'])('keeps existing IP website HTTP findings readable without permitting SSH directory inference: %s', address => {
    expect(websiteFindingScope(address)).toEqual({ evidence: { none: { engine: 'ssh-forensics' } } });
    rejected({ ...fixture(), scope: { ...fixture().scope, hostname: address } }, address);
  });

  it('preserves non-SSH-only findings and requires positively scoped SSH evidence without any invalid mixed SSH record', () => {
    expect(websiteFindingScope(hostname)).toEqual({ OR: [
      { evidence: { none: { engine: 'ssh-forensics' } } },
      { evidence: {
        some: { engine: 'ssh-forensics', AND: [
          { metadata: { path: ['scope', 'mode'], equals: 'WEBSITE' } },
          { metadata: { path: ['scope', 'hostname'], equals: hostname } }
        ] },
        none: { engine: 'ssh-forensics', OR: [
          { metadata: { path: ['scope', 'mode'], equals: Prisma.AnyNull } },
          { metadata: { path: ['scope', 'hostname'], equals: Prisma.AnyNull } },
          { NOT: { metadata: { path: ['scope', 'mode'], equals: 'WEBSITE' } } },
          { NOT: { metadata: { path: ['scope', 'hostname'], equals: hostname } } }
        ] }
      } }
    ] });
  });

  it('returns independent predicates without adding or replacing caller tenant/site constraints', () => {
    const current = websiteFindingScope(hostname);
    const sibling = websiteFindingScope('sibling.example');
    expect(JSON.stringify(current)).toContain(hostname);
    expect(JSON.stringify(current)).not.toContain('sibling.example');
    expect(JSON.stringify(sibling)).not.toContain(hostname);
    expect(current).not.toHaveProperty('tenantId');
    expect(current).not.toHaveProperty('websiteId');
  });
});
