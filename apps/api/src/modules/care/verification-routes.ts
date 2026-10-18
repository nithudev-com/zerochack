import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { database } from '@zerochack/database';
import type { Environment } from '@zerochack/config';
import { CareError, digestBytes, prepareReviewSnapshot, verificationProfiles, VERIFICATION_POLICY, looksSensitive } from '@zerochack/care';
import { ApiError } from '../../errors.js';
import { requirePermission } from '../auth/security.js';
import { careEvent, careWebsite } from './service.js';
import { readArtifact, writeArtifact } from './repair-service.js';
import { runVerification, verificationResultSchema, type VerificationAdapter } from './verification-runner.js';

const uuid = z.string().uuid(); const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({ requestKey: uuid, toolId: z.enum(['T35','T36','T37','T39','T40','T41','T42','T43','T44','T46','T48']), revisionId: uuid, artifactId: uuid, sourceDigest: digest,
  baselineArtifactId: uuid.optional(), baselineDigest: digest.optional(), imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  authorizeVerification: z.literal(true), syntheticDataOnly: z.literal(true) }).strict();
type Input = z.infer<typeof schema>;
function parse<T>(shape: z.ZodType<T>, value: unknown): T {
  const checked = shape.safeParse(value);
  if (!checked.success) throw new ApiError(400, 'VERIFICATION_INPUT_INVALID', 'Review the source, runtime image and explicit synthetic-data consent.');
  return checked.data;
}
const stopped = ['CANCELLED', 'FAILED', 'PAUSED', 'PAUSE_REQUESTED', 'CANCEL_REQUESTED'];
const runFields = { id: true, toolId: true, state: true, errorCode: true, resultArtifactId: true, createdAt: true, completedAt: true, expiresAt: true } as const;
const stateOf = (run: { state: string; expiresAt: Date }) => run.state === 'RUNNING' && run.expiresAt <= new Date() ? 'INTERRUPTED' : run.state;
async function context(tx: Prisma.TransactionClient, request: FastifyRequest, id: string) {
  const job = await tx.careJob.findFirst({ where: { id, tenantId: request.tenantId! } });
  if (!job) throw new ApiError(404, 'NOT_FOUND', 'The job was not found.');
  const session = await tx.session.findFirst({ where: { id: request.sessionId!, userId: request.userId!, tenantId: request.tenantId!, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } });
  if (!session) throw new ApiError(401, 'SESSION_INVALID', 'The session expired or was revoked.');
  const actor = await tx.user.findFirst({ where: { id: request.userId!, status: 'APPROVED', memberships: { some: { tenantId: request.tenantId!, status: 'ACTIVE' } }, userRoles: { some: { tenantId: request.tenantId!, role: { permissions: { some: { permission: { key: 'websites.manage' } } } } } } }, select: { id: true } });
  if (!actor) throw new ApiError(403, 'AUTHORIZATION_REVOKED', 'Current website-management permission is required.');
  await careWebsite(request, job.websiteId, tx);
  return job;
}
async function sourceFor(tx: Prisma.TransactionClient, request: FastifyRequest, id: string, input: Input, env: Environment) {
  const job = await context(tx, request, id);
  if (!env.CARE_VERIFICATION_ENABLED || !env.CARE_REVIEW_ENABLED) throw new ApiError(503, 'VERIFICATION_DISABLED', 'Verification and source reviews must be enabled.');
  if (input.imageDigest !== env.CARE_VERIFICATION_IMAGE) throw new ApiError(409, 'VERIFICATION_IMAGE_CHANGED', 'Review the current runner image before authorizing execution.');
  if (job.environment !== 'STAGING' || !['REVIEW', 'WORKSPACE'].includes(job.kind) || stopped.includes(job.state) || (job.kind === 'WORKSPACE' && job.state !== 'WAITING_FOR_INPUT')) throw new ApiError(409, 'VERIFICATION_SCOPE_INVALID', 'Choose a current source in an active staging review or workspace.');
  const revision = await tx.careRevision.findFirst({ where: { id: input.revisionId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, version: job.planVersion } });
  if (!revision || revision.sourceId !== input.artifactId || revision.sourceDigest !== input.sourceDigest) throw new ApiError(409, 'VERIFICATION_SOURCE_STALE', 'Reload and confirm the current saved source version.');
  const read = async (artifactId: string, expected: string) => {
    const artifact = await tx.careArtifact.findFirst({ where: { id: artifactId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, environment: 'STAGING', kind: 'SOURCE_BUNDLE' } });
    if (!artifact || artifact.digest !== expected) throw new ApiError(409, 'VERIFICATION_SOURCE_STALE', 'The selected source is unavailable or changed.');
    const decoded = JSON.parse(readArtifact(artifact, env).toString('utf8'));
    return prepareReviewSnapshot(decoded.files.map(({ path, content }: { path: string; content: string }) => ({ path, content }))).files.map(({ path, content }) => ({ path, content }));
  };
  const source = await read(input.artifactId, input.sourceDigest);
  if (Boolean(input.baselineArtifactId && input.baselineDigest) !== (input.toolId === 'T40') || (input.toolId !== 'T40' && (input.baselineArtifactId || input.baselineDigest)) || input.baselineArtifactId === input.artifactId) throw new ApiError(400, 'VERIFICATION_BASELINE_INVALID', 'Performance comparison requires a different saved source in this job and its exact digest.');
  const baseline = input.baselineArtifactId && input.baselineDigest ? await read(input.baselineArtifactId, input.baselineDigest) : undefined;

  return { job, source, baseline, binding: digestBytes(JSON.stringify({ revisionId: revision.id, artifactId: input.artifactId, digest: input.sourceDigest, baselineArtifactId: input.baselineArtifactId ?? null, baselineDigest: input.baselineDigest ?? null, imageDigest: input.imageDigest, leaseVersion: job.leaseVersion, policy: VERIFICATION_POLICY })) };
}

export async function careVerificationRoutes(app: FastifyInstance, options: { environment: Environment; adapter?: VerificationAdapter }) {
  const env = options.environment; const adapter = options.adapter ?? runVerification;
  app.get('/jobs/:id/verification-options', async (request) => {
    requirePermission(request, 'websites.manage');
    const { id } = parse(z.object({ id: uuid }), request.params);
    const job = await database.$transaction((tx) => context(tx, request, id));
    const revision = await database.careRevision.findFirst({ where: { jobId: id, tenantId: job.tenantId, version: job.planVersion } });
    const sources: Array<{ revisionId: string; artifactId: string; sourceDigest: string; label: string }> = [];
    const snapshots = await database.careArtifact.findMany({ where: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, environment: 'STAGING', kind: 'SOURCE_BUNDLE', status: 'ACCEPTED', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, orderBy: { createdAt: 'desc' }, take: 100 });
    if (revision && job.environment === 'STAGING') {
      const artifact = snapshots.find((item) => item.id === revision.sourceId && item.digest === revision.sourceDigest);
      if (artifact) sources.push({ revisionId: revision.id, artifactId: artifact.id, sourceDigest: artifact.digest, label: `Version ${revision.version}: ${artifact.filename}` });
    }
    const { before } = parse(z.object({ before: uuid.optional() }).strict(), request.query);
    const anchor = before ? await database.careVerificationRun.findFirst({ where: { id: before, tenantId: job.tenantId, websiteId: job.websiteId, jobId: id } }) : null;
    if (before && !anchor) throw new ApiError(404, 'HISTORY_CURSOR_INVALID', 'The cursor is outside this job.');
    const history = await database.careVerificationRun.findMany({ where: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: id }, ...(anchor ? { cursor: { id: anchor.id }, skip: 1 } : {}), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 21, select: runFields });
    return { sources, profiles: verificationProfiles, imageDigest: env.CARE_VERIFICATION_IMAGE ?? null,
      baselines: snapshots.filter((item) => item.id !== revision?.sourceId).map((item) => ({ artifactId: item.id, sourceDigest: item.digest, label: `${item.filename} · ${item.createdAt.toISOString()}` })),
      enabled: Boolean(env.CARE_VERIFICATION_ENABLED && env.CARE_REVIEW_ENABLED && env.CARE_VERIFICATION_IMAGE && job.environment === 'STAGING' && ['REVIEW','WORKSPACE'].includes(job.kind) && sources.length && !stopped.includes(job.state) && (job.kind !== 'WORKSPACE' || job.state === 'WAITING_FOR_INPUT')), policy: VERIFICATION_POLICY, runtimeState: 'DEPLOYMENT_PREFLIGHT_REQUIRED',

      nextCursor: history.length > 20 ? history[19]!.id : null, history: history.slice(0, 20).map((run) => ({ ...run, state: stateOf(run) })) };
  });
  app.get('/jobs/:id/verification-runs/:runId', async (request) => {
    requirePermission(request, 'websites.manage');
    const { id, runId } = parse(z.object({ id: uuid, runId: uuid }), request.params);
    const job = await database.$transaction((tx) => context(tx, request, id));
    const run = await database.careVerificationRun.findFirst({ where: { id: runId, jobId: id, tenantId: job.tenantId, websiteId: job.websiteId } });
    if (!run) throw new ApiError(404, 'NOT_FOUND', 'The verification result was not found.');
    const artifact = run.resultArtifactId ? await database.careArtifact.findFirst({ where: { id: run.resultArtifactId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, kind: 'VERIFICATION_RESULT' } }) : null;
    return { ...runFieldsResponse(run), result: artifact ? JSON.parse(readArtifact(artifact, env).toString('utf8')) as unknown : null };

  });
  app.post('/jobs/:id/verification-runs', { bodyLimit: 8192, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    requirePermission(request, 'websites.manage');
    const { id } = parse(z.object({ id: uuid }), request.params); const input = parse(schema, request.body);
    const inputDigest = digestBytes(JSON.stringify(input));
    const claimed = await database.$transaction(async (tx) => {
      const initial = await tx.careJob.findFirst({ where: { id, tenantId: request.tenantId! } });
      if (!initial) throw new ApiError(404, 'NOT_FOUND', 'The job was not found.');
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${initial.websiteId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await sourceFor(tx, request, id, input, env);
      const existing = await tx.careVerificationRun.findUnique({ where: { jobId_requestKey: { jobId: id, requestKey: input.requestKey } } });
      if (existing) {
        if (existing.actorId !== request.userId || existing.inputDigest !== inputDigest || existing.sourceBinding !== current.binding) throw new ApiError(409, 'REQUEST_KEY_CONFLICT', 'This request key belongs to another selection or actor.');
        return { ...current, run: existing, duplicate: true };
      }
      await tx.careVerificationRun.updateMany({ where: { tenantId: current.job.tenantId, websiteId: current.job.websiteId, state: 'RUNNING', expiresAt: { lte: new Date() } }, data: { state: 'INTERRUPTED', errorCode: 'OUTCOME_NOT_REPLAYED' } });
      if (await tx.careVerificationRun.count({ where: { tenantId: current.job.tenantId, websiteId: current.job.websiteId, state: 'RUNNING' } })) throw new ApiError(409, 'VERIFICATION_ACTIVE', 'A verification run is already active for this website.');
      if (await tx.careVerificationRun.count({ where: { tenantId: current.job.tenantId, websiteId: current.job.websiteId, createdAt: { gte: new Date(Date.now() - 3600000) } } }) >= 30) throw new ApiError(429, 'VERIFICATION_LIMIT', 'This website has reached its hourly verification allowance.');
      const run = await tx.careVerificationRun.create({ data: { tenantId: current.job.tenantId, websiteId: current.job.websiteId, jobId: id, actorId: request.userId!, requestKey: input.requestKey, toolId: input.toolId, inputDigest, sourceBinding: current.binding, state: 'RUNNING', expiresAt: new Date(Date.now() + 75000) } });
      await tx.auditLog.create({ data: { tenantId: run.tenantId, actorUserId: run.actorId, requestId: request.id, action: 'care.verification_authorized', resourceType: 'verification_run', resourceId: run.id, metadata: { toolId: input.toolId, inputDigest, sourceBinding: current.binding, policy: VERIFICATION_POLICY, syntheticDataOnly: true, imageDigest: input.imageDigest } } });
      await careEvent(tx, current.job, 'verification.started', 'RUNNING', 'An approved isolated source verification started.', { jobId: id });
      return { ...current, run, duplicate: false };
    });
    if (claimed.duplicate) return reply.send({ runId: claimed.run.id, state: stateOf(claimed.run), duplicate: true });
    try {
      const result = verificationResultSchema.parse(await adapter({ policy: VERIFICATION_POLICY, files: claimed.source, toolId: input.toolId, ...(claimed.baseline ? { baseline: claimed.baseline } : {}) }, env));
      if (result.toolId !== input.toolId || Boolean(result.candidateFiles) !== (input.toolId === 'T43') || (result.outcome === 'PASSED' && result.checks.some((check) => !check.passed))) throw new ApiError(502, 'VERIFICATION_RESULT_INVALID', 'The runner returned inconsistent evidence.');
      if (result.candidateFiles) prepareReviewSnapshot(result.candidateFiles);
      const bytes = Buffer.from(JSON.stringify({ ...result, selection: { revisionId: input.revisionId, artifactId: input.artifactId, sourceDigest: input.sourceDigest, baselineArtifactId: input.baselineArtifactId ?? null, baselineDigest: input.baselineDigest ?? null, imageDigest: input.imageDigest }, sourceBinding: claimed.binding }));
      if (bytes.length > 500000 || looksSensitive(bytes.toString('utf8'))) throw new ApiError(502, 'VERIFICATION_RESULT_INVALID', 'The runner returned oversized or sensitive evidence.');
      await database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM websites WHERE id = ${claimed.job.websiteId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${id}::uuid FOR UPDATE`;
        const current = await sourceFor(tx, request, id, input, env);
        const run = await tx.careVerificationRun.findUniqueOrThrow({ where: { id: claimed.run.id } });
        if (run.state !== 'RUNNING' || run.expiresAt <= new Date() || current.binding !== run.sourceBinding) throw new ApiError(409, 'VERIFICATION_SCOPE_CHANGED', 'The source, authorization or execution window changed.');
        const scope = { tenantId: run.tenantId, websiteId: run.websiteId, jobId: id, environment: 'STAGING', createdBy: request.userId! };
        const artifact = await writeArtifact(tx, scope, bytes, 'VERIFICATION_RESULT', `${run.toolId}-${run.id}.json`, 'application/json', env);
        await tx.careVerificationRun.update({ where: { id: run.id }, data: { state: 'COMPLETED', resultArtifactId: artifact.id, completedAt: new Date() } });
        await tx.auditLog.create({ data: { tenantId: run.tenantId, actorUserId: run.actorId, requestId: request.id, action: 'care.verification_completed', resourceType: 'verification_run', resourceId: run.id, metadata: { artifactId: artifact.id, digest: artifact.digest } } });
        await careEvent(tx, current.job, 'verification.completed', 'COMPLETED', 'The verification result and its limits were saved. Completion does not mean every check passed.', { jobId: id });
      });
      return reply.code(201).send({ runId: claimed.run.id, state: 'COMPLETED', duplicate: false });
    } catch (error) {
      const code = error instanceof ApiError || error instanceof CareError ? error.code : 'VERIFICATION_FAILED';
      await database.$transaction(async (tx) => {
        const changed = await tx.careVerificationRun.updateMany({ where: { id: claimed.run.id, state: 'RUNNING' }, data: { state: 'FAILED', errorCode: code, completedAt: new Date() } });
        if (changed.count) {
          await tx.auditLog.create({ data: { tenantId: claimed.run.tenantId, actorUserId: claimed.run.actorId, requestId: request.id, action: 'care.verification_failed', resourceType: 'verification_run', resourceId: claimed.run.id, metadata: { toolId: input.toolId, errorCode: code } } });
          await careEvent(tx, claimed.job, 'verification.failed', 'FAILED', 'The verification run did not produce an authorized successful result. Its status is retained.', { jobId: id });
        }
      });
      throw error instanceof ApiError ? error : new ApiError(502, code, 'The verification check failed. Review its saved status before a new request.');
    }
  });
}
function runFieldsResponse(run: { id: string; toolId: string; state: string; errorCode: string | null; expiresAt: Date }) {
  return { id: run.id, toolId: run.toolId, state: stateOf(run), errorCode: run.errorCode };
}
