/** Test-only GitHub-hosted fixture preparation. Never a production TLS/setup path. */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { constants, closeSync, fstatSync, openSync, realpathSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type Environment = Record<string, string | undefined>;
type DatabaseRow = { name: string; owner: string; marker: string | null; owned: boolean };
export type CiFixtureDatabase = {
  query<T>(sql: string, ...parameters: unknown[]): Promise<T>;
  execute(sql: string): Promise<unknown>;
  close(): Promise<void>;
};
export class CiFixtureError extends Error {
  constructor(readonly code: string) { super(code); this.name = 'CiFixtureError'; }
}
function requireFixture(condition: unknown, code: string): asserts condition { if (!condition) throw new CiFixtureError(code); }

/** Source is SHA256(git archive HEAD), not the commit SHA or an arbitrary URL. */
export function githubActionsFixtureIdentity(env: Environment, source: string) {
  requireFixture(env.NODE_ENV === 'test' && env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted' && env.GITHUB_REPOSITORY === 'nithudev-com/zerochack', 'CI_HOSTED_CONTEXT_REQUIRED');
  requireFixture(/^[1-9][0-9]{0,19}$/u.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]{0,9}$/u.test(env.GITHUB_RUN_ATTEMPT ?? '') && /^[a-f0-9]{40}$/u.test(env.GITHUB_SHA ?? '') && /^[a-f0-9]{64}$/u.test(source), 'CI_EXACT_SOURCE_AND_RUN_REQUIRED');
  const attempt = createHash('sha256').update(JSON.stringify(['codebandage-legacy-github-actions-v1', env.GITHUB_REPOSITORY, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT, env.GITHUB_SHA, source])).digest('hex').slice(0, 8);
  return {
    SECURITY_WORKPLACE_TEST_MODE: 'LEGACY_GITHUB_ACTIONS',
    SECURITY_WORKPLACE_TEST_SOURCE_SHA: source,
    SECURITY_WORKPLACE_TEST_ATTEMPT: attempt,
    SECURITY_WORKPLACE_TEST_DATABASE: `codebandage_security_workplace_test_${source.slice(0, 12)}_${attempt}_test`,
    SECURITY_WORKPLACE_TEST_MARKER: `codebandage-security-workplace-test-v1:${source}:${attempt}:legacy-github-actions:${env.GITHUB_RUN_ID}:${env.GITHUB_RUN_ATTEMPT}`
  };
}

export function sqlIdentifier(value: string): string {
  requireFixture(/^[a-z][a-z0-9_]{0,62}$/u.test(value), 'CI_SQL_IDENTIFIER_REFUSED');
  return `"${value}"`;
}
export function sqlLiteral(value: string): string {
  requireFixture(value.length > 0 && value.length <= 512 && !/[\0\r\n]/u.test(value), 'CI_SQL_LITERAL_REFUSED');
  return `'${value.replace(/'/gu, "''")}'`;
}
function bootstrapUrls(env: Environment) {
  let database: URL; let redis: URL;
  try { database = new URL(env.DATABASE_URL ?? ''); redis = new URL(env.REDIS_URL ?? ''); } catch { throw new CiFixtureError('CI_BOOTSTRAP_URL_REFUSED'); }
  requireFixture(['postgresql:', 'postgres:'].includes(database.protocol) && database.hostname === '127.0.0.1' && database.port === '5432' && database.pathname === '/zerochack_test' && database.username === 'zerochack' && !!database.password && !database.hash && [...database.searchParams].every(([key, value]) => key === 'schema' && value === 'public'), 'CI_BOOTSTRAP_URL_REFUSED');
  requireFixture(redis.protocol === 'redis:' && redis.hostname === '127.0.0.1' && redis.port === '6379' && ['', '/'].includes(redis.pathname) && !redis.username && !redis.password && !redis.search && !redis.hash, 'CI_BOOTSTRAP_REDIS_REFUSED');
  return { database, redis };
}
const databaseRowSql = "SELECT datname AS name,pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker,datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned FROM pg_database WHERE datname=$1";
function owned(row: DatabaseRow | undefined, name: string, marker: string | null): boolean { return row?.name === name && row.owner === 'zerochack' && row.owned === true && row.marker === marker; }

/** All inputs are trusted CI dependencies, never browser/model-provided authority. */
export async function prepareGitHubActionsIntegration(input: {
  env: Environment; gitHead: string; sourceArchiveSha256: string;
  connect: (bootstrapUrl: string) => Promise<CiFixtureDatabase>;
  exportEnvironment: (values: Record<string, string>) => void;
}): Promise<{ databaseCreated: boolean; sourceArchiveSha256: string }> {
  const binding = githubActionsFixtureIdentity(input.env, input.sourceArchiveSha256);
  requireFixture(input.gitHead === input.env.GITHUB_SHA, 'CI_GIT_HEAD_MISMATCH');
  const urls = bootstrapUrls(input.env);
  const client = await input.connect(urls.database.href);
  let created = false;
  try {
    const bootstrap = await client.query<DatabaseRow[]>(databaseRowSql, 'zerochack_test');
    const actual = await client.query<Array<{ name: string; user: string; count: number }>>("SELECT current_database() AS name,current_user AS user,(SELECT count(*)::int FROM information_schema.tables WHERE table_schema='public') AS count");
    requireFixture(bootstrap.length === 1 && owned(bootstrap[0], 'zerochack_test', null) && actual.length === 1 && actual[0]?.name === 'zerochack_test' && actual[0].user === 'zerochack' && actual[0].count === 0, 'CI_FRESH_BOOTSTRAP_REQUIRED');
    const name = binding.SECURITY_WORKPLACE_TEST_DATABASE, marker = binding.SECURITY_WORKPLACE_TEST_MARKER;
    const existing = await client.query<DatabaseRow[]>(databaseRowSql, name);
    requireFixture(existing.length <= 1, 'CI_TARGET_DATABASE_REFUSED');
    if (existing.length === 0) {
      // CREATE DATABASE cannot run inside a transaction. A duplicate/race fails
      // closed; it is not permission to adopt or relabel an unknown database.
      await client.execute(`CREATE DATABASE ${sqlIdentifier(name)} OWNER ${sqlIdentifier('zerochack')}`);
      created = true;
      const fresh = await client.query<DatabaseRow[]>(databaseRowSql, name);
      requireFixture(fresh.length === 1 && owned(fresh[0], name, null), 'CI_FRESH_TARGET_REQUIRED');
      await client.execute(`COMMENT ON DATABASE ${sqlIdentifier(name)} IS ${sqlLiteral(marker)}`);
    } else requireFixture(owned(existing[0], name, marker), 'CI_TARGET_DATABASE_REFUSED');
    const verified = await client.query<DatabaseRow[]>(databaseRowSql, name);
    requireFixture(verified.length === 1 && owned(verified[0], name, marker), 'CI_TARGET_DATABASE_REFUSED');
    urls.database.pathname = `/${name}`; urls.redis.pathname = '/3';
    input.exportEnvironment({ ...binding, DATABASE_URL: urls.database.href, REDIS_URL: urls.redis.href });
    return { databaseCreated: created, sourceArchiveSha256: input.sourceArchiveSha256 };
  } finally { await client.close(); }
}

function appendGitHubEnvironment(env: Environment, values: Record<string, string>): void {
  const path = env.GITHUB_ENV ?? '', temporary = env.RUNNER_TEMP ?? '';
  requireFixture(isAbsolute(path) && isAbsolute(temporary), 'CI_ENV_FILE_REQUIRED');
  const parent = realpathSync(dirname(path)), root = realpathSync(temporary), within = relative(root, parent);
  requireFixture(within !== '..' && !within.startsWith('../') && !isAbsolute(within), 'CI_ENV_FILE_OUTSIDE_RUNNER');
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    requireFixture(info.isFile() && info.nlink === 1 && info.uid === process.getuid?.() && (info.mode & 0o022) === 0 && info.size <= 1_000_000, 'CI_ENV_FILE_REFUSED');
    requireFixture(Object.entries(values).every(([key, value]) => /^[A-Z][A-Z0-9_]+$/u.test(key) && !/[\0\r\n]/u.test(value)), 'CI_ENV_VALUE_REFUSED');
    // Write directly to the runner's environment file; never echo a URI/password.
    writeSync(fd, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
  } finally { closeSync(fd); }
}
async function cli(): Promise<void> {
  // Context validation precedes Git, filesystem exports and any DB connection.
  githubActionsFixtureIdentity(process.env, '0'.repeat(64));
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 10000 });
  requireFixture(head.status === 0 && head.stdout.trim() === process.env.GITHUB_SHA, 'CI_GIT_HEAD_MISMATCH');
  const clean = spawnSync('git', ['diff', '--quiet', 'HEAD', '--'], { timeout: 10000 });
  requireFixture(clean.status === 0, 'CI_DIRTY_TRACKED_SOURCE_REFUSED');
  const archive = spawnSync('git', ['archive', '--format=tar', 'HEAD'], { timeout: 30000, maxBuffer: 64 * 1024 * 1024 });
  requireFixture(archive.status === 0 && archive.stdout.length > 0, 'CI_SOURCE_ARCHIVE_FAILED');
  const source = createHash('sha256').update(archive.stdout).digest('hex');
  const { PrismaClient } = await import('@prisma/client');
  const result = await prepareGitHubActionsIntegration({ env: process.env, gitHead: head.stdout.trim(), sourceArchiveSha256: source,
    async connect(url) { const client = new PrismaClient({ datasources: { db: { url } } }); return { query: <T>(sql: string, ...parameters: unknown[]) => client.$queryRawUnsafe<T>(sql, ...parameters), execute: sql => client.$executeRawUnsafe(sql), close: () => client.$disconnect() }; },
    exportEnvironment(values) { appendGitHubEnvironment(process.env, values); }
  });
  process.stdout.write(JSON.stringify({ result: 'GITHUB_HOSTED_TEST_FIXTURE_READY', ...result, productionTlsVerified: false, credentialsPrinted: false }) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => {
  process.stderr.write(JSON.stringify({ result: 'GITHUB_HOSTED_TEST_FIXTURE_REFUSED', code: error instanceof CiFixtureError ? error.code : 'CI_PREPARATION_FAILED' }) + '\n'); process.exitCode = 1;
});
