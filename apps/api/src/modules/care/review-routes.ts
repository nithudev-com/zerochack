import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { database } from '@zerochack/database';
import type { Environment } from '@zerochack/config';
import { digestBytes, looksSensitive, prepareReviewSnapshot, reviewFilesSchema, reviewResultSchema, reviewSteps, REVIEW_POLICY_VERSION } from '@zerochack/care';
import type { AiService } from '../ai/service.js';
import { requirePermission } from '../auth/security.js';
import { ApiError } from '../../errors.js';
import { careEvent, careWebsite } from './service.js';
import { artifactMetadata, assertRepairActor, readArtifact, repairConfiguration, reserveRepairBudget, writeArtifact } from './repair-service.js';
import { reviewEstimate, reviewReport, type ReviewPlan } from './review-service.js';

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
function input<T>(schema: z.ZodType<T>, value: unknown): T { const parsed = schema.safeParse(value); if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Check the required source-review fields.'); return parsed.data; }
async function reviewJob(request: FastifyRequest) {
  const { id } = input(z.object({ id: uuid }), request.params);
  const job = await database.careJob.findFirst({ where: { id, tenantId: request.tenantId!, kind: 'REVIEW' } });
  if (!job) throw new ApiError(404, 'NOT_FOUND', 'Source review was not found.');
  await careWebsite(request, job.websiteId); return job;
}
export async function reviewRoutes(app: FastifyInstance, options: { environment: Environment; ai: AiService }) {
  const env = options.environment;
  app.post('/websites/:websiteId/reviews', { bodyLimit: 500_000, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    requirePermission(request, 'websites.manage'); requirePermission(request, 'ai.use');
    if (!env.CARE_REVIEW_ENABLED) throw new ApiError(503, 'REVIEW_DISABLED', 'Source review is not enabled on this deployment.');
    const { websiteId } = input(z.object({ websiteId: uuid }), request.params); await careWebsite(request, websiteId);
    const body = input(z.object({ requestKey: uuid, summary: z.string().trim().min(10).max(1000), expectedBehavior: z.string().trim().min(10).max(4000), environment: z.enum(['PRODUCTION','STAGING']), language: z.enum(['en','ta']).default('en'), roleIds: z.array(z.string()).min(1).max(24), files: reviewFilesSchema, privacyReviewed: z.literal(true), budgetMicros: z.number().int().min(1000).max(env.CARE_REVIEW_BUDGET_MICROS) }).strict(), request.body);
    if (looksSensitive(body.summary + '\n' + body.expectedBehavior)) throw new ApiError(400, 'SENSITIVE_CONTENT_BLOCKED', 'Remove credentials from the review description.');
    const steps = reviewSteps(body.roleIds); const snapshot = prepareReviewSnapshot(body.files);
    const bytes = Buffer.from(JSON.stringify({ policy: snapshot.policy, files: snapshot.files.map(({ path, content }) => ({ path, content })) }));
    const configuration = await options.ai.configuration(request.tenantId!);
    if (!configuration.tenantEnabled) throw new ApiError(403, 'AI_TENANT_DISABLED', 'AI is disabled for this tenant.');
    const estimate = reviewEstimate(bytes, steps.length, configuration);
    if (estimate.maximumEstimateMicros > body.budgetMicros) throw new ApiError(400, 'BUDGET_EXCEEDED', `This source and role selection require an allowance of at least $${(estimate.maximumEstimateMicros / 1_000_000).toFixed(3)} at the configured prices. Select fewer roles, use smaller inputs, or adjust the allowance.`);
    const requestFingerprint = digestBytes(Buffer.from(JSON.stringify({ sourceDigest: digestBytes(bytes), summary: body.summary, expectedBehavior: body.expectedBehavior, environment: body.environment, language: body.language, roleIds: steps.map((step) => step.roleId), budgetMicros: body.budgetMicros })));
    return database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${websiteId}::uuid FOR UPDATE`;
      const existing = await tx.careJob.findUnique({ where: { tenantId_websiteId_requestKey: { tenantId: request.tenantId!, websiteId, requestKey: body.requestKey } }, include: { revisions: true } });
      if (existing) {
        if (existing.kind !== 'REVIEW' || (existing.revisions[0]?.plan as unknown as ReviewPlan)?.requestFingerprint !== requestFingerprint) throw new ApiError(409, 'REQUEST_KEY_CONFLICT', 'This request key belongs to a different review scope.');
        return { jobId: existing.id, state: existing.state };
      }
      if (await tx.careJob.count({ where: { tenantId: request.tenantId!, kind: 'REVIEW', state: { in: ['AWAITING_APPROVAL','QUEUED','RUNNING'] } } }) >= 10) throw new ApiError(429, 'REVIEW_QUEUE_LIMIT', 'Finish or cancel existing reviews before creating more.');
      const job = await tx.careJob.create({ data: { tenantId: request.tenantId!, websiteId, userId: request.userId!, requestKey: body.requestKey, environment: body.environment, kind: 'REVIEW', state: 'AWAITING_APPROVAL', summary: body.summary, expectedBehavior: body.expectedBehavior, sourceRevision: digestBytes(bytes) } });
      const artifact = await writeArtifact(tx, { tenantId: job.tenantId, websiteId, environment: job.environment, jobId: job.id, createdBy: request.userId! }, bytes, 'SOURCE_BUNDLE', 'reviewed-source.json', 'application/json', env);
      const plan: ReviewPlan = { policy: REVIEW_POLICY_VERSION, mode: 'SOURCE_REVIEW', roleIds: steps.map((step) => step.roleId), language: body.language, maximumContextBytes: estimate.maximumContextBytes, maximumEstimatePerStepMicros: estimate.maximumEstimatePerStepMicros, configuration: repairConfiguration(configuration), requestFingerprint, boundary: 'Review approved uploaded source with cited observations. No source execution, automatic repairs, live connections, tests or release.' };
      await tx.careRevision.create({ data: { tenantId: job.tenantId, websiteId, jobId: job.id, version: 1, sourceId: artifact.id, sourceDigest: artifact.digest, budgetMicros: body.budgetMicros, plan } });
      await careEvent(tx, job, 'review.approval_required', 'AWAITING_APPROVAL', `Review the ${steps.length}-role source-review plan and model allowance before any AI call.`, { jobId: job.id });
      await tx.auditLog.create({ data: { tenantId: job.tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.review_prepared', resourceType: 'job', resourceId: job.id, metadata: { sourceDigest: artifact.digest, roleIds: plan.roleIds, privacyReviewed: true } } });
      return reply.code(201).send({ jobId: job.id, state: job.state });
    });
  });
  app.get('/jobs/:id/review', async (request) => {
    requirePermission(request, 'chat.read'); const job = await reviewJob(request);
    const revision = await database.careRevision.findUniqueOrThrow({ where: { jobId_version: { jobId: job.id, version: job.planVersion } } });
    const agents = await database.careAgentRun.findMany({ where: { jobId: job.id, tenantId: job.tenantId }, orderBy: { stepIndex: 'asc' } });
    const artifacts = await database.careArtifact.findMany({ where: { jobId: job.id, tenantId: job.tenantId }, select: artifactMetadata });
    const reports = [];
    for (const agent of agents.filter((run) => run.resultArtifactId)) {
      const stored = await database.careArtifact.findFirst({ where: { id: agent.resultArtifactId!, jobId: job.id, tenantId: job.tenantId, websiteId: job.websiteId, status: 'ACCEPTED', expiresAt: { gt: new Date() } } });
      if (stored) reports.push({ agentRunId: agent.id, ...reviewReport(reviewResultSchema.parse(JSON.parse(readArtifact(stored, env).toString('utf8')))) });
    }
    return { job, revision, agents, artifacts, reports, capabilities: { enabled: env.CARE_REVIEW_ENABLED, maximumBudgetMicros: env.CARE_REVIEW_BUDGET_MICROS }, completedSteps: agents.filter((agent) => agent.state === 'COMPLETED').length, totalSteps: (revision.plan as unknown as ReviewPlan).roleIds.length };
  });
  app.post('/review-plans/:id/approve', async (request) => {
    requirePermission(request, 'websites.manage'); requirePermission(request, 'ai.use');
    if (!env.CARE_REVIEW_ENABLED) throw new ApiError(503, 'REVIEW_DISABLED', 'Source review is not enabled on this deployment.');
    const { id } = input(z.object({ id: uuid }), request.params);
    const body = input(z.object({ sourceDigest: digest, planFingerprint: digest, version: z.number().int().positive(), budgetMicros: z.number().int().positive(), authorizeSourceReview: z.literal(true) }).strict(), request.body);
    const revision = await database.careRevision.findFirst({ where: { id, tenantId: request.tenantId! } });
    if (!revision) throw new ApiError(404, 'NOT_FOUND', 'Review plan was not found.'); await careWebsite(request, revision.websiteId);
    const plan = revision.plan as unknown as ReviewPlan;
    const configuration = await options.ai.configuration(revision.tenantId, { providerId: plan.configuration.providerId, modelId: plan.configuration.modelId });
    return database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${revision.websiteId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${revision.jobId}::uuid FOR UPDATE`;
      const job = await tx.careJob.findUniqueOrThrow({ where: { id: revision.jobId } });
      const current = await tx.careRevision.findUniqueOrThrow({ where: { id } });
      await assertRepairActor(tx, { ...job, userId: request.userId! });
      if (job.kind !== 'REVIEW' || job.state !== 'AWAITING_APPROVAL' || current.state !== 'AWAITING_APPROVAL' || current.version !== body.version || current.sourceDigest !== body.sourceDigest || body.planFingerprint !== plan.requestFingerprint || current.budgetMicros !== body.budgetMicros || current.budgetMicros > env.CARE_REVIEW_BUDGET_MICROS || plan.policy !== REVIEW_POLICY_VERSION || !configuration.tenantEnabled || Object.entries(repairConfiguration(configuration)).some(([key, value]) => plan.configuration[key as keyof typeof plan.configuration] !== value)) throw new ApiError(409, 'APPROVAL_STALE', 'This approval no longer matches the source, roles, model settings or allowance.');
      const source = await tx.careArtifact.findFirstOrThrow({ where: { id: current.sourceId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, kind: 'SOURCE_BUNDLE' } });
      const bytes = readArtifact(source, env);
      if (source.digest !== current.sourceDigest || reviewEstimate(bytes, plan.roleIds.length, configuration).maximumEstimateMicros > current.budgetMicros) throw new ApiError(409, 'APPROVAL_STALE', 'The current source or allowance differs from this plan.');
      await reserveRepairBudget(tx, current, configuration.dailyCostLimitMicros > 0 ? configuration.dailyCostLimitMicros : env.CARE_REVIEW_BUDGET_MICROS * 20);
      const expires = new Date(Date.now() + 3600000);
      await tx.careRevision.update({ where: { id }, data: { state: 'APPROVED', approvedBy: request.userId!, approvalExpiresAt: expires, budgetState: 'RESERVED' } });
      for (const step of reviewSteps(plan.roleIds)) await tx.careAgentRun.create({ data: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, ...step, roleVersion: 1, task: `Review approved source: ${step.roleId}. No live changes or test execution.`, state: step.stepIndex === 0 ? 'QUEUED' : 'WAITING_FOR_DEPENDENCY' } });
      await tx.careJob.update({ where: { id: job.id }, data: { state: 'QUEUED', userId: request.userId!, approvedBy: request.userId!, approvedVersion: current.version, approvalExpiresAt: expires } });
      await careEvent(tx, job, 'review.queued', 'QUEUED', `${plan.roleIds.length} source-review roles are assigned in dependency order.`, { jobId: job.id });
      await tx.auditLog.create({ data: { tenantId: job.tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.review_approved', resourceType: 'revision', resourceId: id, metadata: { sourceDigest: current.sourceDigest, roleIds: plan.roleIds, budgetMicros: current.budgetMicros } } });
      return { state: 'QUEUED' };
    });
  });
}
