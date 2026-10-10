import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { database } from '@zerochack/database';
import type { Environment } from '@zerochack/config';
import { coordinateKey, digestBytes, inventoryDependencies, prepareReviewSnapshot, REVIEW_POLICY_VERSION } from '@zerochack/care';
import { ApiError } from '../../errors.js';
import { requirePermission } from '../auth/security.js';
import { careEvent, careWebsite } from './service.js';
import { assertRepairActor, readArtifact, writeArtifact } from './repair-service.js';
import { observationAdapters, observationTarget, type ObservationAdapters } from './external-observations.js';

const uuid = z.string().uuid();
const coordinate = z.object({ ecosystem: z.enum(['npm', 'Packagist']), name: z.string().min(1).max(180), version: z.string().min(1).max(100) }).strict();
const schema = z.discriminatedUnion('toolId', [
  z.object({ requestKey: uuid, toolId: z.literal('T20'), revisionId: uuid, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), packages: z.array(coordinate).min(1).max(50), consentToSharePackageVersions: z.literal(true) }).strict(),
  z.object({ requestKey: uuid, toolId: z.enum(['T23', 'T24']), confirmTarget: z.string().url().max(2048), authorizeReadOnlyObservation: z.literal(true) }).strict()
]);
type Input = z.infer<typeof schema>;
function parse<T>(shape: z.ZodType<T>, value: unknown): T {
  const checked = shape.safeParse(value);
  if (!checked.success) throw new ApiError(400, 'OBSERVATION_INPUT_INVALID', 'Review the selected scope and explicit consent.');
  return checked.data;
}
const runFields = { id: true, toolId: true, state: true, errorCode: true, resultArtifactId: true, createdAt: true, completedAt: true, expiresAt: true } as const;
const blockedStates = ['CANCELLED', 'FAILED', 'PAUSED', 'PAUSE_REQUESTED', 'CANCEL_REQUESTED'];

async function context(tx: Prisma.TransactionClient, request: FastifyRequest, jobId: string, input: Input | null, env: Environment) {
  const job = await tx.careJob.findFirst({ where: { id: jobId, tenantId: request.tenantId! } });
  if (!job) throw new ApiError(404, 'NOT_FOUND', 'Job was not found.');
  const session = await tx.session.findFirst({ where: { id: request.sessionId!, userId: request.userId!, tenantId: request.tenantId!, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
  if (!session) throw new ApiError(401, 'SESSION_INVALID', 'The session expired or was revoked.');
  const site = await careWebsite(request, job.websiteId, tx);
  await assertRepairActor(tx, { ...job, userId: request.userId! });
  if (input && blockedStates.includes(job.state)) throw new ApiError(409, 'JOB_NOT_ACTIVE', 'The job is stopped. Start a new explicitly authorized job.');
  if (input?.toolId === 'T20') {
    if (!env.CARE_ADVISORIES_ENABLED || !env.CARE_REVIEW_ENABLED) throw new ApiError(503, 'ADVISORIES_DISABLED', 'Advisory matching is not enabled.');
    const revision = await tx.careRevision.findFirst({ where: { id: input.revisionId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, version: job.planVersion } });
    if (job.kind !== 'REVIEW' || job.state === 'WAITING_FOR_INPUT' || !revision?.approvedBy || !revision.approvalExpiresAt || revision.approvalExpiresAt <= new Date() || !['APPROVED', 'COMPLETED'].includes(revision.state) || (revision.plan as { policy?: string }).policy !== REVIEW_POLICY_VERSION || revision.sourceDigest !== input.sourceDigest) throw new ApiError(403, 'SOURCE_APPROVAL_REQUIRED', 'An exact current source-review approval is required.');
    const artifact = await tx.careArtifact.findFirst({ where: { id: revision.sourceId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, environment: job.environment, kind: 'SOURCE_BUNDLE' } });
    if (!artifact || artifact.digest !== input.sourceDigest) throw new ApiError(409, 'APPROVAL_STALE', 'The approved source is no longer available.');
    const inventory = inventoryDependencies(prepareReviewSnapshot(JSON.parse(readArtifact(artifact, env).toString('utf8')).files));
    const allowed = new Set(inventory.entries.map(coordinateKey));
    if (new Set(input.packages.map(coordinateKey)).size !== input.packages.length || input.packages.some((p) => !allowed.has(coordinateKey(p)))) throw new ApiError(400, 'PACKAGE_SELECTION_INVALID', 'Choose exact package coordinates present in the approved source snapshot.');
    return { job, site, binding: revision.sourceDigest };
  }
  if (input) {
    if (!env.CARE_OBSERVATIONS_ENABLED) throw new ApiError(503, 'OBSERVATIONS_DISABLED', 'Website observations are not enabled.');
    if (job.environment !== 'PRODUCTION' || site.connectionStatus !== 'VERIFIED') throw new ApiError(403, 'VERIFIED_TARGET_REQUIRED', 'This observation requires the verified production website binding.');
    const target = observationTarget(site.url).toString();
    if (input.confirmTarget !== target || new URL(target).hostname !== site.normalizedHost) throw new ApiError(409, 'TARGET_CHANGED', 'The website target changed. Review the current target before consenting.');
    if (input.toolId === 'T24' && new URL(target).protocol !== 'https:') throw new ApiError(409, 'HTTPS_REQUIRED', 'TLS observation requires a registered HTTPS target.');
    return { job, site, binding: digestBytes(Buffer.from(JSON.stringify({ url: site.url, host: site.normalizedHost, connectedAt: site.connectedAt }))) };
  }
  return { job, site, binding: '' };
}

export async function careObservationRoutes(app: FastifyInstance, options: { environment: Environment; adapters?: ObservationAdapters }) {
  const env = options.environment; const adapters = options.adapters ?? observationAdapters;
  app.get('/jobs/:id/observation-options', async (request) => {
    requirePermission(request, 'websites.manage'); requirePermission(request, 'ai.use');
    const { id } = parse(z.object({ id: uuid }), request.params);
    const { job, site } = await database.$transaction((tx) => context(tx, request, id, null, env));
    const revision = job.kind === 'REVIEW' ? await database.careRevision.findFirst({ where: { jobId: job.id, tenantId: job.tenantId, version: job.planVersion } }) : null;
    let inventory: ReturnType<typeof inventoryDependencies> | null = null;
    const approved = Boolean(revision?.approvedBy && revision.approvalExpiresAt && revision.approvalExpiresAt > new Date() && ['APPROVED', 'COMPLETED'].includes(revision.state) && (revision.plan as { policy?: string }).policy === REVIEW_POLICY_VERSION && !blockedStates.includes(job.state));
    if (approved && revision) {
      const source = await database.careArtifact.findFirst({ where: { id: revision.sourceId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, environment: job.environment, kind: 'SOURCE_BUNDLE' } });
      if (source && source.digest === revision.sourceDigest) inventory = inventoryDependencies(prepareReviewSnapshot(JSON.parse(readArtifact(source, env).toString('utf8')).files));
    }
    let target: string | null = null;
    try { target = observationTarget(site.url).toString(); } catch { /* Invalid legacy targets stay unavailable. */ }
    const { before } = parse(z.object({ before: uuid.optional() }).strict(), request.query);
    const anchor = before ? await database.careToolObservation.findFirst({ where: { id: before, tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id } }) : null;
    if (before && !anchor) throw new ApiError(404, 'HISTORY_CURSOR_INVALID', 'The cursor is outside this job.');
    const history = await database.careToolObservation.findMany({ where: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id }, ...(anchor ? { cursor: { id: anchor.id }, skip: 1 } : {}), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 21, select: runFields });
    return { target, environment: job.environment, networkAvailable: Boolean(env.CARE_OBSERVATIONS_ENABLED && job.environment === 'PRODUCTION' && site.connectionStatus === 'VERIFIED' && target && !blockedStates.includes(job.state)),
      advisoriesAvailable: Boolean(env.CARE_ADVISORIES_ENABLED && env.CARE_REVIEW_ENABLED && approved && inventory),
      revisionId: revision?.id ?? null, sourceDigest: revision?.sourceDigest ?? null, inventory,
      nextCursor: history.length > 20 ? history[19]!.id : null, history: history.slice(0, 20).map((run) => ({ ...run, state: run.state === 'RUNNING' && run.expiresAt <= new Date() ? 'INTERRUPTED' : run.state })) };
  });
  app.get('/jobs/:id/observations/:runId', async (request) => {
    requirePermission(request, 'chat.read');
    const { id, runId } = parse(z.object({ id: uuid, runId: uuid }), request.params);
    const run = await database.careToolObservation.findFirst({ where: { id: runId, jobId: id, tenantId: request.tenantId! } });
    if (!run) throw new ApiError(404, 'NOT_FOUND', 'The observation was not found.');
    await careWebsite(request, run.websiteId);
    const artifact = run.resultArtifactId ? await database.careArtifact.findFirst({ where: { id: run.resultArtifactId, tenantId: run.tenantId, websiteId: run.websiteId, jobId: id, kind: 'OBSERVATION_RESULT' } }) : null;
    return { id: run.id, toolId: run.toolId, state: run.state === 'RUNNING' && run.expiresAt <= new Date() ? 'INTERRUPTED' : run.state, errorCode: run.errorCode,
      observedAt: run.completedAt, result: artifact ? JSON.parse(readArtifact(artifact, env).toString('utf8')) as unknown : null };
  });
  app.post('/jobs/:id/observations', { bodyLimit: 24576, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    requirePermission(request, 'websites.manage'); requirePermission(request, 'ai.use');
    const { id } = parse(z.object({ id: uuid }), request.params); const input = parse(schema, request.body);
    // Sorted canonical package selection makes retries with the same intended set identical.
    if (input.toolId === 'T20') input.packages.sort((a, b) => coordinateKey(a).localeCompare(coordinateKey(b)));
    const inputDigest = digestBytes(Buffer.from(JSON.stringify(input)));
    const claimed = await database.$transaction(async (tx) => {
      const initial = await tx.careJob.findFirst({ where: { id, tenantId: request.tenantId! } });
      if (!initial) throw new ApiError(404, 'NOT_FOUND', 'The job was not found.');
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${initial.websiteId}::uuid FOR UPDATE`;
      const current = await context(tx, request, id, input, env);
      const existing = await tx.careToolObservation.findUnique({ where: { jobId_requestKey: { jobId: id, requestKey: input.requestKey } } });
      if (existing) {
        if (existing.actorId !== request.userId || existing.inputDigest !== inputDigest || existing.targetBinding !== current.binding) throw new ApiError(409, 'REQUEST_KEY_CONFLICT', 'This request key belongs to another input, actor or target binding.');
        return { ...current, run: existing, duplicate: true };
      }
      await tx.careToolObservation.updateMany({ where: { tenantId: current.job.tenantId, websiteId: current.job.websiteId, state: 'RUNNING', expiresAt: { lte: new Date() } }, data: { state: 'INTERRUPTED', errorCode: 'OUTCOME_NOT_REPLAYED' } });
      if (await tx.careToolObservation.count({ where: { tenantId: current.job.tenantId, websiteId: current.job.websiteId, state: 'RUNNING' } })) throw new ApiError(409, 'OBSERVATION_ACTIVE', 'Another observation is active for this website.');
      if (await tx.careToolObservation.count({ where: { tenantId: current.job.tenantId, websiteId: current.job.websiteId, createdAt: { gte: new Date(Date.now() - 3600000) } } }) >= 30) throw new ApiError(429, 'OBSERVATION_LIMIT', 'The website observation allowance is exhausted for this hour.');
      const run = await tx.careToolObservation.create({ data: { tenantId: current.job.tenantId, websiteId: current.job.websiteId, jobId: id, actorId: request.userId!, requestKey: input.requestKey, toolId: input.toolId, inputDigest, targetBinding: current.binding, state: 'RUNNING', expiresAt: new Date(Date.now() + 60000) } });
      await tx.auditLog.create({ data: { tenantId: run.tenantId, actorUserId: run.actorId, requestId: request.id, action: 'care.observation_authorized', resourceType: 'observation', resourceId: run.id, metadata: { toolId: run.toolId, inputDigest, externalPackageDisclosure: input.toolId === 'T20' } } });
      await careEvent(tx, current.job, 'observation.started', 'RUNNING', 'An explicitly approved, bounded observation started. No model or production credentials are used.', { jobId: id });
      return { ...current, run, duplicate: false };
    });
    if (claimed.duplicate) return reply.code(200).send({ runId: claimed.run.id, state: claimed.run.state === 'RUNNING' && claimed.run.expiresAt <= new Date() ? 'INTERRUPTED' : claimed.run.state, duplicate: true });
    let result: unknown;
    try {
      result = input.toolId === 'T20' ? await adapters.advisories(input.packages) : input.toolId === 'T23' ? await adapters.http(input.confirmTarget) : await adapters.tls(input.confirmTarget);
      const bytes = Buffer.from(JSON.stringify(result));
      if (bytes.length > 65536) throw new ApiError(413, 'OBSERVATION_OUTPUT_LIMIT', 'The observation exceeded its output limit.');
      await database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM websites WHERE id = ${claimed.job.websiteId}::uuid FOR UPDATE`;
        const current = await context(tx, request, id, input, env);
        const run = await tx.careToolObservation.findUniqueOrThrow({ where: { id: claimed.run.id } });
        if (run.state !== 'RUNNING' || run.expiresAt <= new Date() || current.binding !== run.targetBinding) throw new ApiError(409, 'OBSERVATION_SCOPE_CHANGED', 'The scope, authorization or execution window changed.');
        const artifact = await writeArtifact(tx, { tenantId: run.tenantId, websiteId: run.websiteId, environment: claimed.job.environment, jobId: id, createdBy: request.userId! }, bytes, 'OBSERVATION_RESULT', `${run.toolId}-${run.id}.json`, 'application/json', env);
        await tx.careToolObservation.update({ where: { id: run.id }, data: { state: 'COMPLETED', resultArtifactId: artifact.id, completedAt: new Date() } });
        await tx.auditLog.create({ data: { tenantId: run.tenantId, actorUserId: run.actorId, requestId: request.id, action: 'care.observation_completed', resourceType: 'observation', resourceId: run.id, metadata: { toolId: run.toolId, artifactId: artifact.id, digest: artifact.digest } } });
        await careEvent(tx, current.job, 'observation.completed', 'COMPLETED', 'The bounded observation result and its limitations were saved. This is not a repair or a security certification.', { jobId: id });
      });
      return reply.code(201).send({ runId: claimed.run.id, state: 'COMPLETED', duplicate: false });
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'OBSERVATION_FAILED';
      await database.$transaction(async (tx) => {
        const changed = await tx.careToolObservation.updateMany({ where: { id: claimed.run.id, state: 'RUNNING' }, data: { state: 'FAILED', errorCode: code, completedAt: new Date() } });
        if (changed.count) {
          await tx.auditLog.create({ data: { tenantId: claimed.run.tenantId, actorUserId: claimed.run.actorId, requestId: request.id, action: 'care.observation_failed', resourceType: 'observation', resourceId: claimed.run.id, metadata: { toolId: input.toolId, errorCode: code } } });
          await careEvent(tx, claimed.job, 'observation.failed', 'FAILED', 'The observation did not produce an authorized successful result. Review saved status before starting another request.', { jobId: id });
        }
      });
      throw error instanceof ApiError ? error : new ApiError(502, 'OBSERVATION_FAILED', 'The observation failed. No successful result is claimed.');
    }
  });
}
