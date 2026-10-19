import { database } from '@zerochack/database';

/** Test-only guard. An arbitrary URL containing "test" is not authorization.
 * The coordinator derives these non-secret identifiers in a protected server
 * env file and creates a fresh database with the matching ownership comment. */
export async function assertSecurityWorkplaceTestDatabase(): Promise<void> {
  const source = process.env.SECURITY_WORKPLACE_TEST_SOURCE_SHA ?? '';
  const attempt = process.env.SECURITY_WORKPLACE_TEST_ATTEMPT ?? '';
  const mode = process.env.SECURITY_WORKPLACE_TEST_MODE;
  const legacy = mode === 'LEGACY_INTEGRATION';
  const expected = `codebandage_security_workplace_test_${source.slice(0, 12)}_${attempt}${legacy ? '_test' : ''}`;
  const marker = `codebandage-security-workplace-test-v1:${source}:${attempt}${legacy ? ':legacy-integration' : ''}`;
  const reject = () => new Error('An explicitly authorized isolated Security Workplace database is required.');
  if (process.env.NODE_ENV !== 'test' || !/^[a-f0-9]{64}$/u.test(source) || !/^[a-f0-9]{8}$/u.test(attempt) || (mode !== undefined && mode !== 'LEGACY_INTEGRATION') || process.env.SECURITY_WORKPLACE_TEST_DATABASE !== expected || process.env.SECURITY_WORKPLACE_TEST_MARKER !== marker) throw reject();
  let url: URL;
  try { url = new URL(process.env.DATABASE_URL ?? ''); } catch { throw reject(); }
  if (!['postgresql:', 'postgres:'].includes(url.protocol) || url.hostname !== 'postgres' || url.pathname !== `/${expected}`) throw reject();
  const rows = await database.$queryRaw<Array<{ name: string; marker: string | null; owned: boolean }>>`SELECT current_database() AS name, shobj_description(oid, 'pg_database') AS marker, datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user) AS owned FROM pg_database WHERE datname = current_database()`;
  if (rows.length !== 1 || rows[0]!.name !== expected || rows[0]!.marker !== marker || rows[0]!.owned !== true) throw reject();
}
