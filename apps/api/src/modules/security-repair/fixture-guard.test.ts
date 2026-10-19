import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { database } from '@zerochack/database';
import { assertSecurityWorkplaceTestDatabase } from './fixture-guard.test-helper.js';

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
  ['NODE_ENV', 'production']
])('refuses incorrect %s binding before database access', async (key, value) => {
  vi.stubEnv(key, value);
  await expect(assertSecurityWorkplaceTestDatabase()).rejects.toThrow('explicitly authorized isolated');
  expect(database.$queryRaw).not.toHaveBeenCalled();
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
