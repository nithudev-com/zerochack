import { database } from '@zerochack/database';
import { githubActionsFixtureIdentity } from '../../../../../scripts/security/prepare-ci-integration.js';

export function securityWorkplaceTestFixtureHost(): 'postgres' | '127.0.0.1' {
  if (process.env.SECURITY_WORKPLACE_TEST_MODE !== 'LEGACY_GITHUB_ACTIONS') return 'postgres';
  const binding = githubActionsFixtureIdentity(process.env, process.env.SECURITY_WORKPLACE_TEST_SOURCE_SHA ?? '');
  if (Object.entries(binding).some(([key, value]) => process.env[key] !== value)) throw new Error('An explicitly authorized isolated Security Workplace database is required.');
  return '127.0.0.1';
}

export function assertSecurityWorkplaceTestRedisUrl(value: string | undefined): void {
  let url: URL; try { url = new URL(value ?? ''); } catch { throw new Error('Explicit isolated Security Workplace Redis fixture required.'); }
  const host = securityWorkplaceTestFixtureHost();
  if (!['redis:', 'rediss:'].includes(url.protocol) || url.hostname !== (host === '127.0.0.1' ? host : 'redis') || url.pathname !== '/3' || (host === '127.0.0.1' && (url.protocol !== 'redis:' || url.port !== '6379' || !!url.username || !!url.password || !!url.search || !!url.hash))) throw new Error('Explicit isolated Security Workplace Redis database 3 required.');
}

/** Test-only guard. An arbitrary URL containing "test" is not authorization.
 * The coordinator derives these non-secret identifiers in a protected server
 * env file and creates a fresh database with the matching ownership comment. */
export async function assertSecurityWorkplaceTestDatabase(): Promise<void> {
  const source = process.env.SECURITY_WORKPLACE_TEST_SOURCE_SHA ?? '';
  const attempt = process.env.SECURITY_WORKPLACE_TEST_ATTEMPT ?? '';
  const mode = process.env.SECURITY_WORKPLACE_TEST_MODE;
  const legacy = mode === 'LEGACY_INTEGRATION';
  const github = mode === 'LEGACY_GITHUB_ACTIONS' ? githubActionsFixtureIdentity(process.env, source) : null;
  const expected = github?.SECURITY_WORKPLACE_TEST_DATABASE ?? `codebandage_security_workplace_test_${source.slice(0, 12)}_${attempt}${legacy ? '_test' : ''}`;
  const marker = github?.SECURITY_WORKPLACE_TEST_MARKER ?? `codebandage-security-workplace-test-v1:${source}:${attempt}${legacy ? ':legacy-integration' : ''}`;
  const reject = () => new Error('An explicitly authorized isolated Security Workplace database is required.');
  if (process.env.NODE_ENV !== 'test' || !/^[a-f0-9]{64}$/u.test(source) || !/^[a-f0-9]{8}$/u.test(attempt) || (mode !== undefined && mode !== 'LEGACY_INTEGRATION' && mode !== 'LEGACY_GITHUB_ACTIONS') || process.env.SECURITY_WORKPLACE_TEST_DATABASE !== expected || process.env.SECURITY_WORKPLACE_TEST_MARKER !== marker) throw reject();
  let url: URL;
  try { url = new URL(process.env.DATABASE_URL ?? ''); } catch { throw reject(); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || url.hostname !== securityWorkplaceTestFixtureHost() || url.pathname !== `/${expected}` || (github && (url.username !== 'zerochack' || url.port !== '5432' || !!url.hash || [...url.searchParams].some(([key, value]) => key !== 'schema' || value !== 'public')))) throw reject();
  const rows = await database.$queryRaw<Array<{ name: string; marker: string | null; owned: boolean; owner: string }>>`SELECT current_database() AS name, shobj_description(oid, 'pg_database') AS marker, datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()`;
  if (rows.length !== 1 || rows[0]!.name !== expected || rows[0]!.marker !== marker || rows[0]!.owned !== true || (github && rows[0]!.owner !== 'zerochack')) throw reject();
}
