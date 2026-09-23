import { randomUUID } from 'node:crypto';
import { database } from '@zerochack/database';
import type { CareArtifact, CareJob, CareRevision, Prisma } from '@prisma/client';
import type { Environment } from '@zerochack/config';
import { applyStaticProposal, digestBytes, inspectStaticHtml, openSecret, sealSecret, CareError, STATIC_POLICY_VERSION } from '@zerochack/care';
import type { AiProviderConfiguration } from '@zerochack/ai-gateway';
import type { AiService } from '../ai/service.js';
import { careEvent } from './runtime.js';

export const artifactMetadata = { id: true, jobId: true, environment: true, kind: true, filename: true, contentType: true, status: true, digest: true, sizeBytes: true, expiresAt: true, createdAt: true } as const;
export const artifactKey = (env: Environment) => env.CARE_ARTIFACT_KEY ?? env.CARE_VAULT_KEY ?? env.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY;
export function readArtifact(artifact: CareArtifact, env: Environment): Buffer {
  if (artifact.status !== 'ACCEPTED' || artifact.expiresAt <= new Date()) throw new CareError('ARTIFACT_UNAVAILABLE', 'The artifact is unavailable or expired.');
  const value = Buffer.from(openSecret(artifact.encryptedBody, { ...artifact, version: 1 }, { v1: artifactKey(env) }), 'base64');
  if (digestBytes(value) !== artifact.digest) throw new CareError('ARTIFACT_INTEGRITY', 'Artifact integrity validation failed.');
  return value;
}
export async function writeArtifact(tx: Prisma.TransactionClient, scope: { tenantId: string; websiteId: string; environment: string; jobId: string | null; createdBy: string }, bytes: Buffer, kind: string, filename: string, contentType: string, env: Environment) {
  if (bytes.length > 4_000_000) throw new CareError('ARTIFACT_LIMIT', 'Artifact size exceeds the storage limit.');
  await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${scope.tenantId}::uuid FOR UPDATE`;
  const usage = await tx.careArtifact.aggregate({ where: { tenantId: scope.tenantId, status: 'ACCEPTED' }, _sum: { sizeBytes: true }, _count: true });
  if (usage._count >= 200 || (usage._sum.sizeBytes ?? 0) + bytes.length > 50_000_000) throw new CareError('ARTIFACT_QUOTA', 'The tenant artifact allowance is exhausted.');
  const id = randomUUID();
  return tx.careArtifact.create({ data: { id, ...scope, kind, filename, contentType, status: 'ACCEPTED', digest: digestBytes(bytes), sizeBytes: bytes.length, encryptedBody: sealSecret(bytes.toString('base64'), { ...scope, id, version: 1 }, artifactKey(env)), expiresAt: new Date(Date.now() + 7 * 86400000) } });
}
export function repairConfiguration(configuration: AiProviderConfiguration) {
  return { providerId: configuration.providerId, modelId: configuration.modelId, model: configuration.model, maxOutputTokens: configuration.maxOutputTokens, inputPrice: configuration.inputCostMicrosPerMillion, outputPrice: configuration.outputCostMicrosPerMillion };
}
export function reserveEstimate(source: Buffer, configuration: AiProviderConfiguration) {
  if (configuration.inputCostMicrosPerMillion <= 0 || configuration.outputCostMicrosPerMillion <= 0) throw new CareError('BUDGET_NOT_CONFIGURED', 'Configure nonzero model input/output prices before approving repair work.');
  // Byte-based worst-case allowance includes JSON escaping, trusted instructions, and the requested change.
  return Math.ceil(((source.length * 6 + 32000) * configuration.inputCostMicrosPerMillion + configuration.maxOutputTokens * configuration.outputCostMicrosPerMillion) / 1_000_000);
}
export async function assertRepairActor(tx: Prisma.TransactionClient, job: Pick<CareJob, 'userId' | 'tenantId' | 'websiteId'>) {
  const user = await tx.user.findFirst({ where: { id: job.userId, status: 'APPROVED', memberships: { some: { tenantId: job.tenantId, status: 'ACTIVE' } } }, include: { userRoles: { where: { tenantId: job.tenantId }, include: { role: { include: { permissions: { include: { permission: true } } } } } } } });
  const site = await tx.website.findFirst({ where: { id: job.websiteId, tenantId: job.tenantId, lifecycle: 'ACTIVE' } });
  const permissions = user?.userRoles.flatMap((assignment) => assignment.role.permissions.map((item) => item.permission.key)) ?? [];
  if (!user || !site || !permissions.includes('websites.manage') || !permissions.includes('ai.use')) throw new CareError('AUTHORIZATION_REVOKED', 'The actor or website is no longer authorized for this repair.');
  return user.userRoles.map((assignment) => assignment.role.name);
}
export async function reserveRepairBudget(tx: Prisma.TransactionClient, revision: CareRevision, dailyCeiling: number) {
  await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${revision.tenantId}::uuid FOR UPDATE`;
  const day = new Date(); day.setUTCHours(0,0,0,0);
  const used = await tx.aiUsage.aggregate({ where: { tenantId: revision.tenantId, createdAt: { gte: day }, status: 'SUCCEEDED' }, _sum: { estimatedCostMicros: true } });
  const reserved = await tx.careRevision.aggregate({ where: { tenantId: revision.tenantId, budgetState: { in: ['RESERVED','UNKNOWN'] } }, _sum: { budgetMicros: true } });
  if ((used._sum.estimatedCostMicros ?? 0) + (reserved._sum.budgetMicros ?? 0) + revision.budgetMicros > dailyCeiling) throw new CareError('BUDGET_EXCEEDED', 'The tenant ceiling cannot cover this reservation.');
}
type RepairAi = Pick<AiService, 'configuration' | 'execute'>;
export async function invalidateRepair(tx: Prisma.TransactionClient, job: CareJob) {
  if (job.kind !== 'REPAIR') return;
  await tx.$queryRaw`SELECT id FROM websites WHERE id = ${job.websiteId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
  if (await tx.careRelease.count({ where: { websiteId: job.websiteId, state: { in: ['QUEUED','RUNNING','VERIFYING','OUTCOME_UNKNOWN'] } } })) throw new CareError('RELEASE_ACTIVE', 'Resolve the active release before changing its approved scope.');
  const current = await tx.careJob.findUniqueOrThrow({ where: { id: job.id } });
  await tx.careRevision.updateMany({ where: { jobId: job.id, state: { in: ['AWAITING_APPROVAL','APPROVED','VERIFIED'] } }, data: { state: 'SUPERSEDED', ...(current.state === 'QUEUED' ? { budgetState: 'RELEASED' } : {}) } });
  await tx.careRelease.updateMany({ where: { jobId: job.id, state: 'AWAITING_APPROVAL' }, data: { state: 'CANCELLED' } });
}
export async function runOneRepair(env: Environment, ai: RepairAi): Promise<boolean> {
  if (!env.CARE_ENABLED || !env.CARE_REPAIR_ENABLED) return false;
  const owner = randomUUID();
  const claimed = await database.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM care_jobs AS candidate WHERE kind = 'REPAIR' AND state = 'QUEUED' AND NOT EXISTS (SELECT 1 FROM care_jobs AS active WHERE active.website_id = candidate.website_id AND active.kind = 'REPAIR' AND active.state IN ('RUNNING','VERIFYING')) ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`;
    if (!rows[0]) return null;
    const job = await tx.careJob.update({ where: { id: rows[0].id }, data: { state: 'RUNNING', leaseOwner: owner, leaseVersion: { increment: 1 }, heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + 90000) } });
    const revision = await tx.careRevision.findUnique({ where: { jobId_version: { jobId: job.id, version: job.planVersion } } });
    if (!revision || revision.state !== 'APPROVED' || !revision.approvalExpiresAt || revision.approvalExpiresAt <= new Date()) {
      await tx.careJob.update({ where: { id: job.id }, data: { state: 'WAITING_FOR_INPUT', errorCode: 'APPROVAL_STALE' } });
      if (revision?.budgetState === 'RESERVED') await tx.careRevision.update({ where: { id: revision.id }, data: { budgetState: 'RELEASED' } });
      return null;
    }
    const agent = await tx.careAgentRun.create({ data: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, roleId: 'A08', roleVersion: 1, task: 'Prepare the approved static HTML patch', state: 'RUNNING' } });
    await careEvent(tx, job, 'agent.started', 'RUNNING', 'Frontend Repair Engineer is preparing the approved isolated candidate.', { jobId: job.id, agentRunId: agent.id });
    return { job, revision, agent };
  });
  if (!claimed) return false;
  const { job, revision, agent } = claimed; const controller = new AbortController(); let modelStarted = false; let charged: { cost: number; usageId: string } | undefined; let ticking = false;
  const deadline = setTimeout(() => controller.abort(), 120000);
  const timer = setInterval(() => { if (ticking) return; ticking = true; void database.careJob.updateMany({ where: { id: job.id, state: 'RUNNING', leaseOwner: owner, leaseVersion: job.leaseVersion }, data: { heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + 90000) } }).then(async ({ count }) => { if (!count) controller.abort(); else await database.careAgentRun.updateMany({ where: { id: agent.id, state: 'RUNNING' }, data: { heartbeatAt: new Date() } }); }).catch(() => controller.abort()).finally(() => { ticking = false; }); }, 10000);
  try {
    const source = await database.careArtifact.findFirstOrThrow({ where: { id: revision.sourceId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id } });
    const bytes = readArtifact(source, env); inspectStaticHtml(bytes.toString('utf8'));
    if (source.digest !== revision.sourceDigest) throw new CareError('APPROVAL_STALE', 'The source changed.');
    const plan = revision.plan as { configuration: ReturnType<typeof repairConfiguration> };
    const config = await ai.configuration(job.tenantId, { providerId: plan.configuration.providerId, modelId: plan.configuration.modelId });
    if (Object.entries(repairConfiguration(config)).some(([key, value]) => plan.configuration[key as keyof typeof plan.configuration] !== value) || reserveEstimate(bytes, config) > revision.budgetMicros) throw new CareError('APPROVAL_STALE', 'Provider configuration changed after approval.');
    const roles = await database.$transaction((tx) => assertRepairActor(tx, job));
    modelStarted = true;
    const result = await ai.execute({ tenantId: job.tenantId, userId: job.userId, roles, requestId: job.id, idempotencyKey: revision.id, purpose: 'ISOLATED_REPAIR', signal: controller.signal, prompt: `Approved issue: ${job.summary}\nExpected behavior: ${job.expectedBehavior}\nReturn a minimal replacement patch for index.html. Preserve unrelated content and appearance.`, untrustedContext: JSON.stringify({ source: bytes.toString('utf8'), policy: STATIC_POLICY_VERSION }) }, { providerId: config.providerId, modelId: config.modelId });
    charged = { cost: result.estimatedCostMicros, usageId: result.usageId };
    const verified = applyStaticProposal(bytes.toString('utf8'), result.text);
    if (result.estimatedCostMicros > revision.budgetMicros) throw new CareError('BUDGET_EXCEEDED', 'Reported usage exceeded the approved budget.');
    await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
      const current = await tx.careJob.findUniqueOrThrow({ where: { id: job.id } });
      await assertRepairActor(tx, job);
      if (current.state !== 'RUNNING' || current.leaseOwner !== owner || current.leaseVersion !== job.leaseVersion || current.planVersion !== revision.version || controller.signal.aborted) throw new CareError('JOB_CANCELLED', 'The scope or execution lease changed.');
      readArtifact(await tx.careArtifact.findUniqueOrThrow({ where: { id: revision.sourceId } }), env);
      const candidate = await writeArtifact(tx, { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, environment: job.environment, createdBy: job.userId }, Buffer.from(verified.candidate), 'CANDIDATE', 'index.html', 'text/html', env);
      await tx.careRevision.update({ where: { id: revision.id }, data: { state: 'VERIFIED', candidateId: candidate.id, candidateDigest: candidate.digest, verification: verified.verification, chargedMicros: result.estimatedCostMicros, usageId: result.usageId, budgetState: 'SETTLED' } });
      const message = await tx.chatMessage.create({ data: { tenantId: job.tenantId, websiteId: job.websiteId, environment: job.environment, type: 'SYSTEM', content: `A static HTML candidate is ready: ${verified.summary}\nIndependent structural checks passed. Review the before/after preview and requested behavior. Your live website has not been changed.` } });
      await tx.careJob.update({ where: { id: job.id }, data: { state: 'AWAITING_APPROVAL', candidateDigest: candidate.digest, sourceRevision: source.digest, resultMessageId: message.id, errorCode: null, leaseOwner: null, leaseExpiresAt: null } });
      await tx.careAgentRun.update({ where: { id: agent.id }, data: { state: 'COMPLETED', completedAt: new Date(), resultMessageId: message.id } });
      await careEvent(tx, job, 'verification.completed', 'AWAITING_APPROVAL', 'Independent static checks passed. Preview review and separate release approval are required.', { jobId: job.id });
    });
  } catch (error) {
    const code = error instanceof CareError ? error.code : 'REPAIR_FAILED';
    await database.$transaction(async (tx) => {
      const usage = await tx.aiUsage.findUnique({ where: { tenantId_userId_idempotencyKey: { tenantId: job.tenantId, userId: job.userId, idempotencyKey: revision.id } } });
      if (!charged && usage?.status === 'SUCCEEDED' && usage.estimatedCostMicros !== null) charged = { cost: usage.estimatedCostMicros, usageId: usage.id };
      if (!usage) modelStarted = false; // The gateway writes usage before invoking a provider.
      await tx.careRevision.update({ where: { id: revision.id }, data: { state: 'FAILED', budgetState: charged ? 'SETTLED' : modelStarted ? 'UNKNOWN' : 'RELEASED', chargedMicros: charged?.cost ?? (modelStarted ? revision.budgetMicros : 0), ...(charged ? { usageId: charged.usageId } : {}) } });
      await tx.careAgentRun.updateMany({ where: { id: agent.id, state: 'RUNNING' }, data: { state: 'FAILED', completedAt: new Date() } });
      const changed = await tx.careJob.updateMany({ where: { id: job.id, state: 'RUNNING', leaseOwner: owner, leaseVersion: job.leaseVersion }, data: { state: 'FAILED', errorCode: code, leaseOwner: null, leaseExpiresAt: null } });
      if (changed.count) await careEvent(tx, job, 'job.failed', 'FAILED', 'Candidate preparation stopped. Review the error and scope before a new approval; production was not changed.', { jobId: job.id });
    });
  } finally { clearInterval(timer); clearTimeout(deadline); }
  return true;
}
