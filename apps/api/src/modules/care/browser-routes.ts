import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { database } from '@zerochack/database';
import type { Environment } from '@zerochack/config';
import { CareError, digestBytes, inspectStaticHtml, prepareReviewSnapshot } from '@zerochack/care';
import { ApiError } from '../../errors.js';
import { requirePermission } from '../auth/security.js';
import { careEvent, careWebsite } from './service.js';
import { readArtifact, writeArtifact } from './repair-service.js';
import { BROWSER_POLICY, runStaticBrowser, type BrowserAdapter } from './static-browser.js';

const uuid = z.string().uuid(); const digest = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z.object({ requestKey: uuid, toolId: z.enum(['T25', 'T26', 'T27', 'T28']), revisionId: uuid, artifactId: uuid, sourceDigest: digest,
  path: z.string().min(1).max(240).optional(), viewport: z.enum(['MOBILE', 'TABLET', 'DESKTOP']), privateIds: z.array(z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)).max(20),
  authorizeStaticBrowser: z.literal(true), privacyReviewed: z.literal(true) }).strict();
type Input = z.infer<typeof schema>;
function parse<T>(shape: z.ZodType<T>, value: unknown): T {
  const checked = shape.safeParse(value);
  if (!checked.success) throw new ApiError(400, 'BROWSER_INPUT_INVALID', 'Review the source, viewport, private IDs and explicit consent.');
  return checked.data;
}
const stopped = ['CANCELLED', 'FAILED', 'PAUSED', 'PAUSE_REQUESTED', 'CANCEL_REQUESTED'];
const runFields = { id: true, toolId: true, state: true, errorCode: true, resultArtifactId: true, screenshotArtifactId: true, createdAt: true, completedAt: true, expiresAt: true } as const;
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
  if (!env.CARE_BROWSER_ENABLED || !(job.kind === 'REPAIR' ? env.CARE_REPAIR_ENABLED : env.CARE_REVIEW_ENABLED)) throw new ApiError(503, 'BROWSER_DISABLED', 'Browser tools and the selected source workflow must be enabled.');
  if (job.environment !== 'STAGING' || !['REPAIR', 'REVIEW', 'WORKSPACE'].includes(job.kind) || stopped.includes(job.state) || (job.kind === 'WORKSPACE' && job.state !== 'WAITING_FOR_INPUT')) throw new ApiError(409, 'BROWSER_SCOPE_INVALID', 'Choose a current source in an active staging job.');
  const revision = await tx.careRevision.findFirst({ where: { id: input.revisionId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, version: job.planVersion } });
  if (!revision || !((revision.sourceId === input.artifactId && revision.sourceDigest === input.sourceDigest) || (revision.candidateId === input.artifactId && revision.candidateDigest === input.sourceDigest))) throw new ApiError(409, 'BROWSER_SOURCE_STALE', 'Reload and confirm the current saved source version.');
  const artifact = await tx.careArtifact.findFirst({ where: { id: input.artifactId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, environment: 'STAGING', kind: { in: ['SOURCE', 'CANDIDATE', 'SOURCE_BUNDLE'] } } });
  if (!artifact || artifact.digest !== input.sourceDigest) throw new ApiError(409, 'BROWSER_SOURCE_STALE', 'The selected source is unavailable or changed.');
  let source = readArtifact(artifact, env).toString('utf8');
  if (artifact.kind === 'SOURCE_BUNDLE') {
    const snapshot = prepareReviewSnapshot(JSON.parse(source).files.map(({ path, content }: { path: string; content: string }) => ({ path, content })));
    const file = snapshot.files.find((file) => file.path === input.path && /\.html?$/i.test(file.path));
    if (!file) throw new ApiError(400, 'BROWSER_PATH_INVALID', 'Select an HTML file from this exact saved snapshot.');
    source = file.content;
  } else if (input.path) throw new ApiError(400, 'BROWSER_PATH_INVALID', 'Standalone HTML does not accept a bundle path.');
  inspectStaticHtml(source);
  return { job, source, binding: digestBytes(JSON.stringify({ revisionId: revision.id, artifactId: artifact.id, digest: artifact.digest, path: input.path ?? null, policy: BROWSER_POLICY })) };
}

export async function careBrowserRoutes(app: FastifyInstance, options: { environment: Environment; adapter?: BrowserAdapter }) {
  const env = options.environment; const adapter = options.adapter ?? runStaticBrowser;
  app.get('/jobs/:id/browser-options', async (request) => {
    requirePermission(request, 'websites.manage');
    const { id } = parse(z.object({ id: uuid }), request.params);
    const job = await database.$transaction((tx) => context(tx, request, id));
    const revision = await database.careRevision.findFirst({ where: { jobId: id, tenantId: job.tenantId, version: job.planVersion } });
    const sources: Array<{ revisionId: string; artifactId: string; sourceDigest: string; label: string; path?: string }> = [];
    if (revision && job.environment === 'STAGING') {
      const artifacts = await database.careArtifact.findMany({ where: { id: { in: [revision.sourceId, revision.candidateId].filter((value): value is string => Boolean(value)) }, tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, environment: 'STAGING', status: 'ACCEPTED' } });
      for (const artifact of artifacts) {
        try {
          if (artifact.digest !== (artifact.id === revision.sourceId ? revision.sourceDigest : revision.candidateDigest)) continue;
          const text = readArtifact(artifact, env).toString('utf8');
          const base = { revisionId: revision.id, artifactId: artifact.id, sourceDigest: artifact.digest };
          if (artifact.kind === 'SOURCE_BUNDLE') {
            const snapshot = prepareReviewSnapshot(JSON.parse(text).files.map(({ path, content }: { path: string; content: string }) => ({ path, content })));
            for (const file of snapshot.files.filter((file) => /\.html?$/i.test(file.path))) {
              try { inspectStaticHtml(file.content); sources.push({ ...base, path: file.path, label: `Version ${revision.version}: ${file.path}` }); } catch { /* Unsupported files are not browser inputs. */ }
            }
          } else if (['SOURCE', 'CANDIDATE'].includes(artifact.kind)) { inspectStaticHtml(text); sources.push({ ...base, label: `${artifact.kind === 'CANDIDATE' ? 'Candidate' : 'Source'}: ${artifact.filename}` }); }
        } catch { /* Expired, changed or unsupported artifacts remain unavailable. */ }
      }
    }
    const { before } = parse(z.object({ before: uuid.optional() }).strict(), request.query);
    const anchor = before ? await database.careBrowserRun.findFirst({ where: { id: before, tenantId: job.tenantId, websiteId: job.websiteId, jobId: id } }) : null;
    if (before && !anchor) throw new ApiError(404, 'HISTORY_CURSOR_INVALID', 'The cursor is outside this job.');
    const history = await database.careBrowserRun.findMany({ where: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: id }, ...(anchor ? { cursor: { id: anchor.id }, skip: 1 } : {}), orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 21, select: runFields });
    return { sources, enabled: Boolean(env.CARE_BROWSER_ENABLED && (job.kind === 'REPAIR' ? env.CARE_REPAIR_ENABLED : env.CARE_REVIEW_ENABLED) && job.environment === 'STAGING' && sources.length && !stopped.includes(job.state) && (job.kind !== 'WORKSPACE' || job.state === 'WAITING_FOR_INPUT')), policy: BROWSER_POLICY,
      nextCursor: history.length > 20 ? history[19]!.id : null, history: history.slice(0, 20).map((run) => ({ ...run, state: stateOf(run) })) };
  });
  app.get('/jobs/:id/browser-runs/:runId', async (request) => {
    requirePermission(request, 'websites.manage');
    const { id, runId } = parse(z.object({ id: uuid, runId: uuid }), request.params);
    const job = await database.$transaction((tx) => context(tx, request, id));
    const run = await database.careBrowserRun.findFirst({ where: { id: runId, jobId: id, tenantId: job.tenantId, websiteId: job.websiteId } });
    if (!run) throw new ApiError(404, 'NOT_FOUND', 'The browser result was not found.');
    const artifact = run.resultArtifactId ? await database.careArtifact.findFirst({ where: { id: run.resultArtifactId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, kind: 'BROWSER_RESULT' } }) : null;
    const screenshot = run.screenshotArtifactId ? await database.careArtifact.findFirst({ where: { id: run.screenshotArtifactId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, kind: 'SCREENSHOT' } }) : null;
    return { ...runFieldsResponse(run), result: artifact ? JSON.parse(readArtifact(artifact, env).toString('utf8')) as unknown : null, screenshot: screenshot ? `data:image/png;base64,${readArtifact(screenshot, env).toString('base64')}` : null };
  });
  app.post('/jobs/:id/browser-runs', { bodyLimit: 8192, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    requirePermission(request, 'websites.manage');
    const { id } = parse(z.object({ id: uuid }), request.params); const input = parse(schema, request.body);
    input.privateIds.sort();
    if (new Set(input.privateIds).size !== input.privateIds.length) throw new ApiError(400, 'BROWSER_INPUT_INVALID', 'Private region IDs must be unique.');
    const inputDigest = digestBytes(JSON.stringify(input));
    const claimed = await database.$transaction(async (tx) => {
      const initial = await tx.careJob.findFirst({ where: { id, tenantId: request.tenantId! } });
      if (!initial) throw new ApiError(404, 'NOT_FOUND', 'The job was not found.');
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${initial.websiteId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await sourceFor(tx, request, id, input, env);
      const existing = await tx.careBrowserRun.findUnique({ where: { jobId_requestKey: { jobId: id, requestKey: input.requestKey } } });
      if (existing) {
        if (existing.actorId !== request.userId || existing.inputDigest !== inputDigest || existing.sourceBinding !== current.binding) throw new ApiError(409, 'REQUEST_KEY_CONFLICT', 'This request key belongs to another selection or actor.');
        return { ...current, run: existing, duplicate: true };
      }
      await tx.careBrowserRun.updateMany({ where: { tenantId: current.job.tenantId, websiteId: current.job.websiteId, state: 'RUNNING', expiresAt: { lte: new Date() } }, data: { state: 'INTERRUPTED', errorCode: 'OUTCOME_NOT_REPLAYED' } });
      if (await tx.careBrowserRun.count({ where: { tenantId: current.job.tenantId, websiteId: current.job.websiteId, state: 'RUNNING' } })) throw new ApiError(409, 'BROWSER_ACTIVE', 'A browser run is already active for this website.');
      if (await tx.careBrowserRun.count({ where: { tenantId: current.job.tenantId, websiteId: current.job.websiteId, createdAt: { gte: new Date(Date.now() - 3600000) } } }) >= 30) throw new ApiError(429, 'BROWSER_LIMIT', 'This website has reached its hourly browser allowance.');
      const run = await tx.careBrowserRun.create({ data: { tenantId: current.job.tenantId, websiteId: current.job.websiteId, jobId: id, actorId: request.userId!, requestKey: input.requestKey, toolId: input.toolId, inputDigest, sourceBinding: current.binding, state: 'RUNNING', expiresAt: new Date(Date.now() + 60000) } });
      await tx.auditLog.create({ data: { tenantId: run.tenantId, actorUserId: run.actorId, requestId: request.id, action: 'care.browser_authorized', resourceType: 'browser_run', resourceId: run.id, metadata: { toolId: input.toolId, inputDigest, sourceBinding: current.binding, policy: BROWSER_POLICY, privacyReviewed: true } } });
      await careEvent(tx, current.job, 'browser.started', 'RUNNING', 'An approved offline static browser check started.', { jobId: id });
      return { ...current, run, duplicate: false };
    });
    if (claimed.duplicate) return reply.send({ runId: claimed.run.id, state: stateOf(claimed.run), duplicate: true });
    try {
      const result = await adapter({ source: claimed.source, toolId: input.toolId, viewport: input.viewport, privateIds: input.privateIds });
      const bytes = Buffer.from(JSON.stringify({ ...result.report, selection: { revisionId: input.revisionId, artifactId: input.artifactId, sourceDigest: input.sourceDigest, path: input.path ?? null }, sourceBinding: claimed.binding }));
      if (bytes.length > 200000 || Boolean(result.screenshot) !== (input.toolId === 'T27')) throw new ApiError(502, 'BROWSER_RESULT_INVALID', 'The browser returned an incomplete or oversized result.');
      await database.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM websites WHERE id = ${claimed.job.websiteId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${id}::uuid FOR UPDATE`;
        const current = await sourceFor(tx, request, id, input, env);
        const run = await tx.careBrowserRun.findUniqueOrThrow({ where: { id: claimed.run.id } });
        if (run.state !== 'RUNNING' || run.expiresAt <= new Date() || current.binding !== run.sourceBinding) throw new ApiError(409, 'BROWSER_SCOPE_CHANGED', 'The source, authorization or execution window changed.');
        const scope = { tenantId: run.tenantId, websiteId: run.websiteId, jobId: id, environment: 'STAGING', createdBy: request.userId! };
        const artifact = await writeArtifact(tx, scope, bytes, 'BROWSER_RESULT', `${run.toolId}-${run.id}.json`, 'application/json', env);
        const screenshot = result.screenshot ? await writeArtifact(tx, scope, result.screenshot, 'SCREENSHOT', `${run.id}.png`, 'image/png', env) : null;
        await tx.careBrowserRun.update({ where: { id: run.id }, data: { state: 'COMPLETED', resultArtifactId: artifact.id, screenshotArtifactId: screenshot?.id ?? null, completedAt: new Date() } });
        await tx.auditLog.create({ data: { tenantId: run.tenantId, actorUserId: run.actorId, requestId: request.id, action: 'care.browser_completed', resourceType: 'browser_run', resourceId: run.id, metadata: { artifactId: artifact.id, screenshotArtifactId: screenshot?.id ?? null, digest: artifact.digest } } });
        await careEvent(tx, current.job, 'browser.completed', 'COMPLETED', 'The static browser evidence and its limits were saved. Review the actual findings.', { jobId: id });
      });
      return reply.code(201).send({ runId: claimed.run.id, state: 'COMPLETED', duplicate: false });
    } catch (error) {
      const code = error instanceof ApiError || error instanceof CareError ? error.code : 'BROWSER_FAILED';
      await database.$transaction(async (tx) => {
        const changed = await tx.careBrowserRun.updateMany({ where: { id: claimed.run.id, state: 'RUNNING' }, data: { state: 'FAILED', errorCode: code, completedAt: new Date() } });
        if (changed.count) {
          await tx.auditLog.create({ data: { tenantId: claimed.run.tenantId, actorUserId: claimed.run.actorId, requestId: request.id, action: 'care.browser_failed', resourceType: 'browser_run', resourceId: claimed.run.id, metadata: { toolId: input.toolId, errorCode: code } } });
          await careEvent(tx, claimed.job, 'browser.failed', 'FAILED', 'The browser run did not produce an authorized successful result. Its status is retained.', { jobId: id });
        }
      });
      throw error instanceof ApiError ? error : new ApiError(502, code, 'The browser check failed. Review its saved status before a new request.');
    }
  });
}
function runFieldsResponse(run: { id: string; toolId: string; state: string; errorCode: string | null; screenshotArtifactId: string | null; expiresAt: Date }) {
  return { id: run.id, toolId: run.toolId, state: stateOf(run), errorCode: run.errorCode, screenshotArtifactId: run.screenshotArtifactId };
}
