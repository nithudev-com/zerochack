import { afterAll, beforeAll, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { database } from '@zerochack/database';
import { encryptSecret } from '@zerochack/auth';
import { configureApprovedTenantAi } from './modules/ai/approved-setup.js';

let tenantId: string; let providerId: string; let credentialId: string; let input: Record<string, unknown>;
const approvalReference = 'synthetic-ai-approval-only'; const encryptionKey = randomBytes(32).toString('base64');
let discoveryCalls = 0;
const context = { approvalReference, encryptionKey, fetchImplementation: (async (url, init) => {
  expect(String(url)).toBe('https://api.anthropic.com/v1/models/claude-synthetic-fixture');
  expect(new Headers(init?.headers).get('x-api-key')).toBe('synthetic-cli-key-no-network');
  discoveryCalls++;
  return new Response(JSON.stringify({ id: 'claude-synthetic-fixture' }), { status: 200 });
}) as typeof fetch };
beforeAll(async () => {
  if (!new URL(process.env.DATABASE_URL ?? '').pathname.endsWith('_test')) throw new Error('Disposable *_test database required');
  tenantId = (await database.tenant.create({ data: { name: 'CLI AI fixture', slug: 'cli-ai-' + crypto.randomUUID() } })).id;
  const provider = await database.aiProvider.create({ data: { name: 'CLI fixture ' + crypto.randomUUID(), adapterKey: 'anthropic-messages', enabled: false, credentials: { create: { label: 'Synthetic only', encryptedSecret: encryptSecret('synthetic-cli-key-no-network', encryptionKey) } } }, include: { credentials: true } });
  providerId = provider.id; credentialId = provider.credentials[0]!.id;
  input = { approvalReference, tenantId, providerId, credentialId, name: 'Synthetic model', providerModel: 'claude-synthetic-fixture', maxOutputTokens: 1024, requestsPerMinute: 6, requestsPerUserMinute: 3, maxConcurrent: 1, dailyCostLimitMicros: 1_000_000, inputCostMicrosPerM: 2_000_000, outputCostMicrosPerM: 10_000_000 };
});
afterAll(async () => {
  if (providerId) { await database.aiModel.deleteMany({ where: { providerId } }); await database.aiCredential.deleteMany({ where: { providerId } }); await database.aiProvider.delete({ where: { id: providerId } }); }
  if (tenantId) { await database.aiTenantPolicy.deleteMany({ where: { tenantId } }); await database.auditLog.deleteMany({ where: { tenantId } }); await database.tenant.delete({ where: { id: tenantId } }); }
  await database.$disconnect();
});
it('production CLI rejects non-production execution rather than bypassing production validation', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'apps/api/src/scripts/configure-tenant-ai.ts', '/nonexistent-approval.json'], { env: { ...process.env, NODE_ENV: 'test' }, encoding: 'utf8' });
  expect(result.status).toBe(1); expect(result.stderr).toContain('PROTECTED_APPROVAL_REQUIRED');
});
it('requires approval, configures one bounded tenant, and preserves the key on rerun with synthetic model discovery', async () => {
  await expect(configureApprovedTenantAi(input, { ...context, approvalReference: undefined })).rejects.toThrow('EXPLICIT_APPROVAL_REQUIRED');
  expect(discoveryCalls).toBe(0); expect(await database.aiTenantPolicy.findUnique({ where: { tenantId } })).toBeNull();
  const credential = await database.aiCredential.findUniqueOrThrow({ where: { id: credentialId } });
  expect(await configureApprovedTenantAi(input, context)).toMatchObject({ changed: true, tenantId, maxConcurrent: 1, dailyCostLimitMicros: 1_000_000, paidGenerations: 0 });
  expect((await configureApprovedTenantAi(input, context)).changed).toBe(false);
  expect(await database.aiCredential.findUniqueOrThrow({ where: { id: credentialId } })).toEqual(credential);
  expect(await database.aiUsage.count({ where: { tenantId } })).toBe(0);
  expect(await database.auditLog.count({ where: { tenantId, action: 'ai.tenant_setup_applied' } })).toBe(1);
  expect(await database.aiProvider.findUniqueOrThrow({ where: { id: providerId } })).toMatchObject({ enabled: true, requestsPerMinute: 6, maxConcurrent: 1 });
  expect(await database.aiModel.findFirstOrThrow({ where: { providerId } })).toMatchObject({ inputCostMicrosPerM: 2_000_000, outputCostMicrosPerM: 10_000_000, maxOutputTokens: 1024 });
});
it('does not mutate configuration when provider authentication/model discovery fails', async () => {
  const before = await database.aiTenantPolicy.findUniqueOrThrow({ where: { tenantId } });
  await expect(configureApprovedTenantAi(input, { ...context, fetchImplementation: async () => new Response('{}', { status: 401 }) })).rejects.toThrow('PROVIDER_MODEL_NOT_AVAILABLE');
  expect(await database.aiTenantPolicy.findUniqueOrThrow({ where: { tenantId } })).toEqual(before);
});
it('refuses to overwrite an existing policy with different limits', async () => {
  await database.aiTenantPolicy.update({ where: { tenantId }, data: { maxConcurrent: 2 } });
  await expect(configureApprovedTenantAi(input, context)).rejects.toThrow('EXISTING_POLICY_REQUIRES_REVIEW');
  expect((await database.aiTenantPolicy.findUniqueOrThrow({ where: { tenantId } })).maxConcurrent).toBe(2);
});
