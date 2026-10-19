import { expect, it, vi } from 'vitest';
import { githubActionsFixtureIdentity, prepareGitHubActionsIntegration, sqlIdentifier, sqlLiteral, type CiFixtureDatabase } from './prepare-ci-integration.js';

const head = 'b'.repeat(40), source = 'a'.repeat(64);
const environment = () => ({ NODE_ENV: 'test', CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', GITHUB_REPOSITORY: 'nithudev-com/zerochack', GITHUB_RUN_ID: '123456789', GITHUB_RUN_ATTEMPT: '1', GITHUB_SHA: head, DATABASE_URL: 'postgresql://zerochack:synthetic-test-password@127.0.0.1:5432/zerochack_test?schema=public', REDIS_URL: 'redis://127.0.0.1:6379' });
type Row = { name: string; owner: string; marker: string | null; owned: boolean };
function fixture() {
  const env = environment(), binding = githubActionsFixtureIdentity(env, source);
  let target: Row | undefined;
  const bootstrap: Row = { name: 'zerochack_test', owner: 'zerochack', marker: null, owned: true };
  const actual = { name: 'zerochack_test', user: 'zerochack', count: 0 };
  const execute = vi.fn(async (sql: string) => {
    if (sql === `CREATE DATABASE ${sqlIdentifier(binding.SECURITY_WORKPLACE_TEST_DATABASE)} OWNER "zerochack"`) target = { name: binding.SECURITY_WORKPLACE_TEST_DATABASE, owner: 'zerochack', owned: true, marker: null };
    else if (sql === `COMMENT ON DATABASE ${sqlIdentifier(binding.SECURITY_WORKPLACE_TEST_DATABASE)} IS ${sqlLiteral(binding.SECURITY_WORKPLACE_TEST_MARKER)}` && target) target.marker = binding.SECURITY_WORKPLACE_TEST_MARKER;
    else throw new Error('Unexpected synthetic SQL');
  });
  const client: CiFixtureDatabase = {
    async query<T>(sql: string, ...parameters: unknown[]) { return (sql.startsWith('SELECT current_database()') ? [{ ...actual }] : parameters[0] === 'zerochack_test' ? [{ ...bootstrap }] : target ? [{ ...target }] : []) as T; },
    execute, close: vi.fn(async () => {})
  };
  const connect = vi.fn(async (_url: string) => client), exportEnvironment = vi.fn();
  return { env, binding, bootstrap, actual, execute, connect, exportEnvironment, client,
    setTarget(row: Row | undefined) { target = row; },
    run() { return prepareGitHubActionsIntegration({ env, gitHead: head, sourceArchiveSha256: source, connect, exportEnvironment }); }
  };
}

it('derives a bounded source/run-specific *_test database and distinct CI marker', () => {
  const env = environment(), a = githubActionsFixtureIdentity(env, source);
  expect(a.SECURITY_WORKPLACE_TEST_MODE).toBe('LEGACY_GITHUB_ACTIONS');
  expect(a.SECURITY_WORKPLACE_TEST_DATABASE).toMatch(/^codebandage_security_workplace_test_[a-f0-9]{12}_[a-f0-9]{8}_test$/u);
  expect(a.SECURITY_WORKPLACE_TEST_DATABASE.length).toBeLessThanOrEqual(63);
  expect(a.SECURITY_WORKPLACE_TEST_MARKER).toContain(':legacy-github-actions:123456789:1');
  for (const change of [{ GITHUB_RUN_ID: '123456790' }, { GITHUB_RUN_ATTEMPT: '2' }, { GITHUB_SHA: 'c'.repeat(40) }]) expect(githubActionsFixtureIdentity({ ...env, ...change }, source).SECURITY_WORKPLACE_TEST_ATTEMPT).not.toBe(a.SECURITY_WORKPLACE_TEST_ATTEMPT);
  expect(githubActionsFixtureIdentity(env, 'd'.repeat(64)).SECURITY_WORKPLACE_TEST_DATABASE).not.toBe(a.SECURITY_WORKPLACE_TEST_DATABASE);
});
it.each([
  ['NODE_ENV', 'production'], ['CI', 'false'], ['GITHUB_ACTIONS', 'false'], ['RUNNER_ENVIRONMENT', 'self-hosted'],
  ['GITHUB_REPOSITORY', 'other/zerochack'], ['GITHUB_RUN_ID', ''], ['GITHUB_RUN_ID', '1;DROP DATABASE'],
  ['GITHUB_RUN_ID', '01'], ['GITHUB_RUN_ATTEMPT', '0'], ['GITHUB_RUN_ATTEMPT', '1\n2'], ['GITHUB_SHA', 'bad']
])('refuses an unsupported %s context before connecting', async (key, value) => {
  const f = fixture(); Object.assign(f.env, { [key]: value });
  await expect(f.run()).rejects.toThrow(/^CI_/u); expect(f.connect).not.toHaveBeenCalled(); expect(f.exportEnvironment).not.toHaveBeenCalled();
});
it('refuses a source/commit mismatch before database effects', async () => {
  const f = fixture(); await expect(prepareGitHubActionsIntegration({ env: f.env, gitHead: 'c'.repeat(40), sourceArchiveSha256: source, connect: f.connect, exportEnvironment: f.exportEnvironment })).rejects.toThrow('CI_GIT_HEAD_MISMATCH');
  expect(f.connect).not.toHaveBeenCalled(); expect(() => githubActionsFixtureIdentity(f.env, head)).toThrow('CI_EXACT_SOURCE_AND_RUN_REQUIRED');
});
it.each([
  ['DATABASE_URL', 'postgresql://zerochack:synthetic@production.example/zerochack_test'],
  ['DATABASE_URL', 'postgresql://zerochack:synthetic@localhost:5432/zerochack_test'],
  ['DATABASE_URL', 'postgresql://zerochack:synthetic@127.0.0.1:5432/another_test'],
  ['DATABASE_URL', 'postgresql://other:synthetic@127.0.0.1:5432/zerochack_test'],
  ['DATABASE_URL', 'postgresql://zerochack:synthetic@127.0.0.1:5432/zerochack_test?options=unsafe'],
  ['REDIS_URL', 'redis://127.0.0.1:6379/3'], ['REDIS_URL', 'redis://redis:6379'], ['REDIS_URL', 'redis://127.0.0.1:6380']
])('refuses an unsupported bootstrap %s before connecting', async (key, value) => {
  const f = fixture(); Object.assign(f.env, { [key]: value }); await expect(f.run()).rejects.toThrow(/^CI_BOOTSTRAP_/u); expect(f.connect).not.toHaveBeenCalled();
});
it('creates and marks only the exact new database, exports only selected values, and preserves bootstrap credentials without logging', async () => {
  const f = fixture(); expect(await f.run()).toEqual({ databaseCreated: true, sourceArchiveSha256: source });
  expect(f.execute.mock.calls.map(([sql]) => sql)).toEqual([`CREATE DATABASE ${sqlIdentifier(f.binding.SECURITY_WORKPLACE_TEST_DATABASE)} OWNER "zerochack"`, `COMMENT ON DATABASE ${sqlIdentifier(f.binding.SECURITY_WORKPLACE_TEST_DATABASE)} IS ${sqlLiteral(f.binding.SECURITY_WORKPLACE_TEST_MARKER)}`]);
  const output = f.exportEnvironment.mock.calls[0]![0] as Record<string, string>;
  expect(output).toMatchObject(f.binding); expect(Object.keys(output).sort()).toEqual([...Object.keys(f.binding), 'DATABASE_URL', 'REDIS_URL'].sort());
  const url = new URL(output.DATABASE_URL!); expect(url.hostname).toBe('127.0.0.1'); expect(url.pathname).toBe(`/${f.binding.SECURITY_WORKPLACE_TEST_DATABASE}`); expect(url.password).toBe(new URL(f.env.DATABASE_URL).password); expect(output.REDIS_URL).toBe('redis://127.0.0.1:6379/3');
  expect(f.client.close).toHaveBeenCalledOnce();
});
it('safely reruns only with the exact existing marker and owner without SQL mutation', async () => {
  const f = fixture(); f.setTarget({ name: f.binding.SECURITY_WORKPLACE_TEST_DATABASE, owner: 'zerochack', owned: true, marker: f.binding.SECURITY_WORKPLACE_TEST_MARKER });
  expect(await f.run()).toMatchObject({ databaseCreated: false }); expect(f.execute).not.toHaveBeenCalled(); expect(f.exportEnvironment).toHaveBeenCalledOnce();
});
it.each(['unknown-marker', 'unmarked', 'wrong-owner', 'not-owned'] as const)('refuses an existing %s target without relabel/reset/drop', async change => {
  const f = fixture(); f.setTarget({ name: f.binding.SECURITY_WORKPLACE_TEST_DATABASE, owner: change === 'wrong-owner' ? 'someone' : 'zerochack', owned: change !== 'not-owned', marker: change === 'unmarked' ? null : change === 'unknown-marker' ? 'unknown-test' : f.binding.SECURITY_WORKPLACE_TEST_MARKER });
  await expect(f.run()).rejects.toThrow('CI_TARGET_DATABASE_REFUSED'); expect(f.execute).not.toHaveBeenCalled(); expect(f.exportEnvironment).not.toHaveBeenCalled(); expect(f.client.close).toHaveBeenCalledOnce();
});
it.each(['marker', 'owner', 'database', 'tables', 'user'] as const)('refuses an unconfirmed bootstrap %s without SQL mutation', async change => {
  const f = fixture(); if (change === 'marker') f.bootstrap.marker = 'other'; if (change === 'owner') f.bootstrap.owner = 'other'; if (change === 'database') f.actual.name = 'other'; if (change === 'tables') f.actual.count = 1; if (change === 'user') f.actual.user = 'other';
  await expect(f.run()).rejects.toThrow('CI_FRESH_BOOTSTRAP_REQUIRED'); expect(f.execute).not.toHaveBeenCalled(); expect(f.exportEnvironment).not.toHaveBeenCalled();
});
it('fails a create race without adopting or relabeling an unknown database', async () => {
  const f = fixture(); f.execute.mockRejectedValueOnce(new Error('synthetic duplicate database')); await expect(f.run()).rejects.toThrow('synthetic duplicate'); expect(f.execute).toHaveBeenCalledOnce(); expect(f.exportEnvironment).not.toHaveBeenCalled(); expect(f.client.close).toHaveBeenCalledOnce();
});
it('quotes literals safely and refuses unsafe SQL identifiers and control characters', () => {
  expect(sqlIdentifier('safe_test')).toBe('"safe_test"'); expect(sqlLiteral("quoted'value")).toBe("'quoted''value'");
  for (const value of ['unsafe"name', 'a;drop', 'a\nb', 'a'.repeat(64), '']) expect(() => sqlIdentifier(value)).toThrow('CI_SQL_IDENTIFIER_REFUSED');
  for (const value of ['x\0y', 'x\ny', 'x\ry', '']) expect(() => sqlLiteral(value)).toThrow('CI_SQL_LITERAL_REFUSED');
});
