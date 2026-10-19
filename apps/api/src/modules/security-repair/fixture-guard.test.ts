import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { database } from '@zerochack/database';
import { assertSecurityWorkplaceTestDatabase, assertSecurityWorkplaceTestRedisUrl, securityWorkplaceTestFixtureHost } from './fixture-guard.test-helper.js';
import { githubActionsFixtureIdentity } from '../../../../../scripts/security/prepare-ci-integration.js';

vi.mock('@zerochack/database', () => ({ database: { $queryRaw: vi.fn() } }));

const source = 'a'.repeat(64);
const attempt = '0123abcd';
const standardName = `codebandage_security_workplace_test_${source.slice(0, 12)}_${attempt}`;
const standardMarker = `codebandage-security-workplace-test-v1:${source}:${attempt}`;

function configure(legacy = false): void {
  const name = standardName + (legacy ? '_test' : '');
  const marker = standardMarker + (legacy ? ':legacy-integration' : '');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('SECURITY_WORKPLACE_TEST_SOURCE_SHA', source);
  vi.stubEnv('SECURITY_WORKPLACE_TEST_ATTEMPT', attempt);
  vi.stubEnv('SECURITY_WORKPLACE_TEST_DATABASE', name);
  vi.stubEnv('SECURITY_WORKPLACE_TEST_MARKER', marker);
  vi.stubEnv('SECURITY_WORKPLACE_TEST_MODE', legacy ? 'LEGACY_INTEGRATION' : undefined);
  vi.stubEnv('DATABASE_URL', `postgresql://synthetic:synthetic@postgres:5432/${name}`);
  vi.mocked(database.$queryRaw).mockResolvedValue([{ name, marker, owned: true }]);
}
function configureGithub(): void {
  const context = { NODE_ENV: 'test', CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'nithudev-com/zerochack', GITHUB_RUN_ID: '123456789', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: 'b'.repeat(40) };
  const binding = githubActionsFixtureIdentity(context, source);
  for (const [key, value] of Object.entries({ ...context, ...binding })) vi.stubEnv(key, value);
  vi.stubEnv('DATABASE_URL', `postgresql://zerochack:synthetic@127.0.0.1:5432/${binding.SECURITY_WORKPLACE_TEST_DATABASE}?schema=public`);
  vi.mocked(database.$queryRaw).mockResolvedValue([{ name: binding.SECURITY_WORKPLACE_TEST_DATABASE, marker: binding.SECURITY_WORKPLACE_TEST_MARKER, owned: true, owner: 'zerochack' }]);
}

beforeEach(() => { vi.clearAllMocks(); configure(); });
afterEach(() => { vi.unstubAllEnvs(); });

it.each([false, true])('requires the exact owned database/comment for fixture legacy mode %s', async legacy => {
  configure(legacy);
  await expect(assertSecurityWorkplaceTestDatabase()).resolves.toBeUndefined();
  expect(database.$queryRaw).toHaveBeenCalledOnce();
});

it.each([
  ['SECURITY_WORKPLACE_TEST_MODE', ''],
  ['SECURITY_WORKPLACE_TEST_MODE', 'P1'],
  ['SECURITY_WORKPLACE_TEST_MODE', 'legacy-integration'],
  ['SECURITY_WORKPLACE_TEST_SOURCE_SHA', 'b'.repeat(64)],
  ['SECURITY_WORKPLACE_TEST_ATTEMPT', 'abcd0123'],
  ['SECURITY_WORKPLACE_TEST_DATABASE', `${standardName}_test`],
  ['SECURITY_WORKPLACE_TEST_MARKER', `${standardMarker}:legacy-integration`],
  ['DATABASE_URL', 'postgresql://synthetic:synthetic@postgres/anything_test'],
  ['DATABASE_URL', `postgresql://synthetic:synthetic@elsewhere/${standardName}`],
  ['DATABASE_URL', `postgresql://synthetic:synthetic@127.0.0.1/${standardName}`],
  ['NODE_ENV', 'production']
])('refuses incorrect %s binding before database access', async (key, value) => {
  vi.stubEnv(key, value);
  await expect(assertSecurityWorkplaceTestDatabase()).rejects.toThrow('explicitly authorized isolated');
  expect(database.$queryRaw).not.toHaveBeenCalled();
});

it('permits only the explicitly source/run-bound GitHub-hosted loopback database and actual expected owner', async () => {
  configureGithub();
  await expect(assertSecurityWorkplaceTestDatabase()).resolves.toBeUndefined(); expect(securityWorkplaceTestFixtureHost()).toBe('127.0.0.1');
  vi.mocked(database.$queryRaw).mockResolvedValue([{ name: process.env.SECURITY_WORKPLACE_TEST_DATABASE, marker: process.env.SECURITY_WORKPLACE_TEST_MARKER, owned: true, owner: 'someone-else' }]);
  await expect(assertSecurityWorkplaceTestDatabase()).rejects.toThrow('explicitly authorized isolated');
});
it.each([
  ['CI', 'false'], ['GITHUB_ACTIONS', 'false'], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['GITHUB_REPOSITORY', 'other/repo'],
  ['GITHUB_RUN_ID', '123456790'], ['GITHUB_RUN_ATTEMPT', '2'], ['GITHUB_SHA', 'c'.repeat(40)],
  ['SECURITY_WORKPLACE_TEST_ATTEMPT', '0123abcd'], ['SECURITY_WORKPLACE_TEST_SOURCE_SHA', 'c'.repeat(64)],
  ['SECURITY_WORKPLACE_TEST_MARKER', standardMarker], ['DATABASE_URL', `postgresql://zerochack:synthetic@postgres:5432/${standardName}_test`]
])('refuses mismatched GitHub-hosted %s binding before database access', async (key, value) => {
  configureGithub(); vi.stubEnv(key, value);
  await expect(assertSecurityWorkplaceTestDatabase()).rejects.toThrow(); expect(database.$queryRaw).not.toHaveBeenCalled();
});
it.each([false, true])('keeps Redis local-container-only in ordinary legacy mode %s', legacy => {
  configure(legacy);
  expect(() => assertSecurityWorkplaceTestRedisUrl('rediss://synthetic:synthetic@redis:6379/3')).not.toThrow();
  expect(() => assertSecurityWorkplaceTestRedisUrl('redis://127.0.0.1:6379/3')).toThrow();
  expect(() => assertSecurityWorkplaceTestRedisUrl('redis://redis:6379/0')).toThrow();
});
it('permits Redis loopback database3 only in the same fully bound GitHub-hosted mode', () => {
  configureGithub();
  expect(() => assertSecurityWorkplaceTestRedisUrl('redis://127.0.0.1:6379/3')).not.toThrow();
  for (const value of ['redis://redis:6379/3', 'redis://127.0.0.1:6380/3', 'redis://127.0.0.1:6379/0', 'http://127.0.0.1:6379/3', 'rediss://127.0.0.1:6379/3', 'redis://synthetic@127.0.0.1:6379/3', 'redis://:synthetic@127.0.0.1:6379/3', 'redis://127.0.0.1:6379/3?path=/some/socket', 'redis://127.0.0.1:6379/3?host=elsewhere', 'redis://127.0.0.1:6379/3#fragment']) expect(() => assertSecurityWorkplaceTestRedisUrl(value)).toThrow();
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '2'); expect(() => assertSecurityWorkplaceTestRedisUrl('redis://127.0.0.1:6379/3')).toThrow();
});

it.each(['?schema=private', '?schema=public&host=elsewhere', '?options=unsafe', '#fragment'])('refuses GitHub-hosted PostgreSQL query/fragment override %s before connecting', async suffix => {
  configureGithub();
  const url = new URL(process.env.DATABASE_URL!); url.search = ''; url.hash = '';
  vi.stubEnv('DATABASE_URL', url.href + suffix);
  await expect(assertSecurityWorkplaceTestDatabase()).rejects.toThrow('explicitly authorized isolated'); expect(database.$queryRaw).not.toHaveBeenCalled();
});

it('does not treat an explicit legacy mode as permission to use the default database', async () => {
  vi.stubEnv('SECURITY_WORKPLACE_TEST_MODE', 'LEGACY_INTEGRATION');
  await expect(assertSecurityWorkplaceTestDatabase()).rejects.toThrow('explicitly authorized isolated');
  expect(database.$queryRaw).not.toHaveBeenCalled();
});

it.each([false, true])('refuses an unowned or incorrectly marked actual database in legacy mode %s', async legacy => {
  configure(legacy);
  const name = standardName + (legacy ? '_test' : '');
  const marker = standardMarker + (legacy ? ':legacy-integration' : '');
  for (const row of [{ name, marker, owned: false }, { name, marker: null, owned: true }, { name, marker: `${marker}:other`, owned: true }, { name: `${name}_other`, marker, owned: true }]) {
    vi.mocked(database.$queryRaw).mockResolvedValue([row]);
    await expect(assertSecurityWorkplaceTestDatabase()).rejects.toThrow('explicitly authorized isolated');
  }
});
