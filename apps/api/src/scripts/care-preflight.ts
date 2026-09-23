import { database } from '@zerochack/database';
import { loadEnvironment } from '@zerochack/config';
import { agentCatalogue, toolCatalogue } from '@zerochack/care';
import Redis from 'ioredis';

// Read-only deployment checks. This never invokes a model or connects to a customer website.
type Check = { name: string; state: 'PASS' | 'BLOCKED' | 'NOT_VERIFIED'; detail: string };
const checks: Check[] = [];
let redis: Redis | undefined;
try {
  const env = loadEnvironment();
  const tenantId = process.argv[2];
  if (!tenantId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(tenantId)) throw new Error('Pass the tenant UUID as the first argument.');
  await database.$queryRaw`SELECT 1`;
  const columns = await database.$queryRaw<Array<{ column_name: string }>>`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'care_agent_runs' AND column_name IN ('step_index','depends_on','result_artifact_id','usage_id')`;
  checks.push({ name: 'database_schema', state: columns.length === 4 ? 'PASS' : 'BLOCKED', detail: columns.length === 4 ? 'Care review columns are present.' : 'Apply all repository migrations.' });
  redis = new Redis(env.REDIS_URL, { lazyConnect: true, connectTimeout: 3000, commandTimeout: 3000, maxRetriesPerRequest: 0, retryStrategy: () => null });
  redis.on('error', () => undefined);
  try {
    await redis.connect(); await redis.ping();
    checks.push({ name: 'redis', state: 'PASS', detail: 'Redis responded.' });
    const heartbeat = await redis.get('zerochack:worker:heartbeat'); const age = heartbeat ? Date.now() - Date.parse(heartbeat) : Number.POSITIVE_INFINITY;
    checks.push({ name: 'worker', state: age >= 0 && age < 90000 ? 'PASS' : 'BLOCKED', detail: age >= 0 && age < 90000 ? 'A recent worker heartbeat is present; verify that all worker instances run the deployed revision.' : 'No recent worker heartbeat. Start the compatible worker.' });
  } catch { checks.push({ name: 'redis_and_worker', state: 'BLOCKED', detail: 'Redis or worker readiness could not be verified.' }); }
  const policy = await database.aiTenantPolicy.findUnique({ where: { tenantId }, select: { enabled: true, dailyCostLimitMicros: true } });
  const providers = await database.aiProvider.count({ where: { enabled: true, adapterKey: { in: ['openai-responses','anthropic-messages'] }, healthStatus: { not: 'UNAVAILABLE' }, credentials: { some: { enabled: true, healthStatus: { not: 'UNAVAILABLE' } } }, models: { some: { enabled: true, inputCostMicrosPerM: { gt: 0 }, outputCostMicrosPerM: { gt: 0 } } } } });
  checks.push({ name: 'ai_configuration', state: policy?.enabled && providers > 0 ? 'PASS' : 'BLOCKED', detail: policy?.enabled && providers > 0 ? 'An enabled tenant policy, provider, credential and priced model exist. Live API access is not tested by this command.' : 'Configure the tenant AI policy, provider credential and nonzero model prices in AI Gateway.' });
  checks.push({ name: 'review_flags', state: env.CARE_ENABLED && env.CARE_REVIEW_ENABLED ? 'PASS' : 'BLOCKED', detail: 'Source reviews require CARE_ENABLED=true and CARE_REVIEW_ENABLED=true on API and worker instances.' });
  checks.push({ name: 'artifact_key', state: Boolean(env.CARE_ARTIFACT_KEY) ? 'PASS' : 'BLOCKED', detail: 'A distinct persistent artifact-encryption key is required; production startup also enforces key separation.' });
  checks.push({ name: 'live_provider_evaluation', state: 'NOT_VERIFIED', detail: 'Run an approved small source review with the real configured model, inspect its citations and actual provider usage, then evaluate representative cases before customer rollout.' });
  checks.push({ name: 'production_recovery', state: 'NOT_VERIFIED', detail: 'A disposable publish/restore drill and operational recovery evidence are separate from source-review readiness.' });
} catch (error) {
  checks.push({ name: 'configuration_or_database', state: 'BLOCKED', detail: error instanceof Error && /^(Invalid environment configuration|Care |Pass the tenant)/.test(error.message) ? error.message : 'Configuration or database checks failed. Inspect server configuration without exposing credentials.' });
} finally {
  redis?.disconnect(); await database.$disconnect();
}
process.stdout.write(JSON.stringify({ sourceReviewRoles: agentCatalogue.filter((role) => role.sourceReview).length, implementedOfflineTools: toolCatalogue.filter((tool) => tool.enabled).length, checks, productionCertified: false }, null, 2) + '\n');
process.exitCode = checks.some((check) => check.state === 'BLOCKED') ? 1 : 0;
