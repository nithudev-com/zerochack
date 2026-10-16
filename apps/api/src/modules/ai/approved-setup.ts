import { z } from 'zod';
import { database } from '@zerochack/database';
import { decryptSecret } from '@zerochack/auth';

const inputSchema = z.object({
  approvalReference: z.string().min(12).max(120), tenantId: z.string().uuid(), providerId: z.string().uuid(), credentialId: z.string().uuid(),
  name: z.string().min(2).max(120), providerModel: z.string().regex(/^claude-[a-z0-9-]+$/),
  maxOutputTokens: z.number().int().min(256).max(4096), requestsPerMinute: z.number().int().min(1).max(30), requestsPerUserMinute: z.number().int().min(1).max(10),
  maxConcurrent: z.number().int().min(1).max(4), dailyCostLimitMicros: z.number().int().min(1).max(10_000_000),
  inputCostMicrosPerM: z.number().int().positive().max(100_000_000), outputCostMicrosPerM: z.number().int().positive().max(100_000_000)
}).strict();

// Internal maintenance logic. Production callers must use the guarded CLI, not an HTTP endpoint.
export async function configureApprovedTenantAi(value: unknown, context: { approvalReference: string | undefined; encryptionKey: string; fetchImplementation?: typeof fetch }) {
  const input = inputSchema.parse(value);
  if (!context.approvalReference || context.approvalReference !== input.approvalReference) throw new Error('EXPLICIT_APPROVAL_REQUIRED');
  const credential = await database.aiCredential.findUniqueOrThrow({ where: { id: input.credentialId }, include: { provider: true } });
  if (!credential.enabled || credential.providerId !== input.providerId || credential.provider.adapterKey !== 'anthropic-messages') throw new Error('CONFIGURATION_CHANGED');
  // Authentication/model discovery only: this is not a paid generation or a health claim.
  const response = await (context.fetchImplementation ?? fetch)(`https://api.anthropic.com/v1/models/${input.providerModel}`, { headers: { 'x-api-key': decryptSecret(credential.encryptedSecret, context.encryptionKey), 'anthropic-version': '2023-06-01' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok || (await response.json() as { id?: string }).id !== input.providerModel) throw new Error('PROVIDER_MODEL_NOT_AVAILABLE');
  const policy = { enabled: true, requestsPerMinute: input.requestsPerMinute, requestsPerUserMinute: input.requestsPerUserMinute, maxConcurrent: input.maxConcurrent, dailyCostLimitMicros: input.dailyCostLimitMicros };
  const modelData = { providerModel: input.providerModel, enabled: true, maxOutputTokens: input.maxOutputTokens, requestsPerMinute: input.requestsPerMinute, maxConcurrent: input.maxConcurrent, inputCostMicrosPerM: input.inputCostMicrosPerM, outputCostMicrosPerM: input.outputCostMicrosPerM };
  const equal = (row: object, values: object) => Object.entries(values).every(([key, value]) => (row as Record<string, unknown>)[key] === value);
  const result = await database.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${input.tenantId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM ai_providers WHERE id = ${input.providerId}::uuid FOR UPDATE`;
    await tx.tenant.findUniqueOrThrow({ where: { id: input.tenantId }, select: { id: true } });
    await tx.$queryRaw`SELECT id FROM ai_credentials WHERE id = ${input.credentialId}::uuid FOR UPDATE`;
    const current = await tx.aiCredential.findUniqueOrThrow({ where: { id: input.credentialId } });
    if (!current.enabled || current.updatedAt.getTime() !== credential.updatedAt.getTime()) throw new Error('CREDENTIAL_CHANGED');
    const provider = await tx.aiProvider.findUniqueOrThrow({ where: { id: input.providerId } });
    if (provider.updatedAt.getTime() !== credential.provider.updatedAt.getTime()) throw new Error('PROVIDER_CHANGED');
    const existingPolicy = await tx.aiTenantPolicy.findUnique({ where: { tenantId: input.tenantId } });
    if (existingPolicy && !equal(existingPolicy, policy)) throw new Error('EXISTING_POLICY_REQUIRES_REVIEW');
    const models = await tx.aiModel.findMany({ where: { providerId: input.providerId, OR: [{ name: input.name }, { providerModel: input.providerModel }] } });
    if (models.length > 1 || (models[0] && (models[0].name !== input.name || !equal(models[0], modelData)))) throw new Error('EXISTING_MODEL_REQUIRES_REVIEW');
    const providerLimits = { enabled: true, requestsPerMinute: input.requestsPerMinute, maxConcurrent: input.maxConcurrent };
    if (provider.enabled && !equal(provider, providerLimits)) throw new Error('EXISTING_PROVIDER_REQUIRES_REVIEW');
    const changed = !existingPolicy || !models[0] || !equal(provider, providerLimits);
    const model = models[0] ?? await tx.aiModel.create({ data: { providerId: input.providerId, name: input.name, ...modelData } });
    if (!existingPolicy) await tx.aiTenantPolicy.create({ data: { tenantId: input.tenantId, ...policy } });
    if (!equal(provider, providerLimits)) await tx.aiProvider.update({ where: { id: input.providerId }, data: providerLimits });
    if (changed) await tx.auditLog.create({ data: { tenantId: input.tenantId, requestId: `ai-setup-${crypto.randomUUID()}`, action: 'ai.tenant_setup_applied', resourceType: 'tenant', resourceId: input.tenantId, metadata: { source: 'approved-server-maintenance', approvalReference: input.approvalReference, providerId: input.providerId, modelId: model.id, ...policy, maxOutputTokens: input.maxOutputTokens, inputCostMicrosPerM: input.inputCostMicrosPerM, outputCostMicrosPerM: input.outputCostMicrosPerM } } });
    return { changed, tenantId: input.tenantId, providerId: input.providerId, modelId: model.id, ...policy };
  });
  return { ...result, providerModel: input.providerModel, modelDiscovery: 'PASS', paidGenerations: 0 };
}
