import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { database } from '@zerochack/database';
import { encryptSecret } from '@zerochack/auth';

let tenantId: string; let providerId: string; let credentialId: string; let directory: string; let configPath: string;
const approvalReference = 'synthetic-ai-approval-only';
const execute = (approved = true) => spawnSync(process.execPath, ['--import', 'tsx', '--import', './apps/api/src/fixtures/ai-models-fetch.mjs', 'apps/api/src/scripts/configure-tenant-ai.ts', configPath], { env: { ...process.env, NODE_ENV: 'production', AI_SETUP_APPROVAL: approved ? approvalReference : '' }, encoding: 'utf8' });
beforeAll(async () => {
  if (!new URL(process.env.DATABASE_URL ?? '').pathname.endsWith('_test')) throw new Error('Disposable *_test database required');
  if (!process.env.AI_CREDENTIAL_ENCRYPTION_KEY) throw new Error('Fixture encryption key required');
  tenantId = (await database.tenant.create({ data: { name: 'CLI AI fixture', slug: 'cli-ai-' + crypto.randomUUID() } })).id;
  const provider = await database.aiProvider.create({ data: { name: 'CLI fixture ' + crypto.randomUUID(), adapterKey: 'anthropic-messages', enabled: false, credentials: { create: { label: 'Synthetic only', encryptedSecret: encryptSecret('synthetic-cli-key-no-network', process.env.AI_CREDENTIAL_ENCRYPTION_KEY) } } }, include: { credentials: true } });
  providerId = provider.id; credentialId = provider.credentials[0]!.id;
  directory = await mkdtemp(join(tmpdir(), 'codebandage-ai-approval-test-')); configPath = join(directory, 'approval.json');
  await writeFile(configPath, JSON.stringify({ approvalReference, tenantId, providerId, credentialId, name: 'Synthetic model', providerModel: 'claude-synthetic-fixture', maxOutputTokens: 1024, requestsPerMinute: 6, requestsPerUserMinute: 3, maxConcurrent: 1, dailyCostLimitMicros: 1_000_000, inputCostMicrosPerM: 2_000_000, outputCostMicrosPerM: 10_000_000 }), { mode: 0o600 });
});
afterAll(async () => {
  if (providerId) { await database.aiModel.deleteMany({ where: { providerId } }); await database.aiCredential.deleteMany({ where: { providerId } }); await database.aiProvider.delete({ where: { id: providerId } }); }
  if (tenantId) { await database.aiTenantPolicy.deleteMany({ where: { tenantId } }); await database.auditLog.deleteMany({ where: { tenantId } }); await database.tenant.delete({ where: { id: tenantId } }); }
  if (directory) await rm(directory, { recursive: true });
  await database.$disconnect();
});
it('requires explicit approval, configures exactly one bounded tenant, and preserves the encrypted key on rerun', async () => {
  const denied = execute(false); expect(denied.status, denied.stderr).toBe(1); expect(await database.aiTenantPolicy.findUnique({ where: { tenantId } })).toBeNull();
  const credential = await database.aiCredential.findUniqueOrThrow({ where: { id: credentialId } });
  const first = execute(); expect(first.status, first.stderr).toBe(0); expect(JSON.parse(first.stdout)).toMatchObject({ changed: true, tenantId, maxConcurrent: 1, dailyCostLimitMicros: 1_000_000, paidGenerations: 0 });
  const again = execute(); expect(again.status, again.stderr).toBe(0); expect(JSON.parse(again.stdout).changed).toBe(false);
  expect(await database.aiCredential.findUniqueOrThrow({ where: { id: credentialId } })).toEqual(credential);
  expect(await database.aiUsage.count({ where: { tenantId } })).toBe(0);
  expect(await database.auditLog.count({ where: { tenantId, action: 'ai.tenant_setup_applied' } })).toBe(1);
  expect(await database.aiProvider.findUniqueOrThrow({ where: { id: providerId } })).toMatchObject({ enabled: true, requestsPerMinute: 6, maxConcurrent: 1 });
  expect(await database.aiModel.findFirstOrThrow({ where: { providerId } })).toMatchObject({ inputCostMicrosPerM: 2_000_000, outputCostMicrosPerM: 10_000_000, maxOutputTokens: 1024 });
});
it('refuses to overwrite an existing policy with different limits', async () => {
  await database.aiTenantPolicy.update({ where: { tenantId }, data: { maxConcurrent: 2 } });
  const result = execute(); expect(result.status).toBe(1); expect(result.stderr).toContain('EXISTING_POLICY_REQUIRES_REVIEW');
  expect((await database.aiTenantPolicy.findUniqueOrThrow({ where: { tenantId } })).maxConcurrent).toBe(2);
});
