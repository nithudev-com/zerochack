import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CareJob, CareRevision, Prisma } from '@prisma/client';
import { database } from '@zerochack/database';
import type { Environment } from '@zerochack/config';
import { z } from 'zod';
import { applyWorkspacePatch, digestBytes, prepareReviewSnapshot, runSourceQuality, WORKSPACE_POLICY, workspacePatchSchema } from '@zerochack/care';
import { ApiError } from '../../errors.js';
import { requirePermission } from '../auth/security.js';
import { careEvent, careWebsite } from './service.js';
import { artifactMetadata, readArtifact, writeArtifact } from './repair-service.js';

const uuid = z.string().uuid(); const digest = z.string().regex(/^[a-f0-9]{64}$/);
const baseSchema = z.object({ requestKey: uuid, version: z.number().int().min(1).max(50), sourceDigest: digest });
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'WORKSPACE_INPUT_INVALID', 'Check the workspace input and exact revision.');
  return result.data;
}
const fingerprint = (value: unknown) => digestBytes(Buffer.from(JSON.stringify(value)));
const revisionMetadata = { id: true, version: true, sourceId: true, sourceDigest: true, state: true, createdAt: true } as const;
type Db = Prisma.TransactionClient;
async function assertWorkspaceActor(request: FastifyRequest, tx: Db) {
  const actor = await tx.user.findFirst({ where: { id: request.userId!, status: 'APPROVED', memberships: { some: { tenantId: request.tenantId!, status: 'ACTIVE' } }, userRoles: { some: { tenantId: request.tenantId!, role: { permissions: { some: { permission: { key: 'websites.manage' } } } } } } }, select: { id: true } });
  if (!actor) throw new ApiError(403, 'AUTHORIZATION_REVOKED', 'Current website-management authority is required.');
}
async function workspace(request: FastifyRequest, id: string, tx: Db = database) {
  const job = await tx.careJob.findFirst({ where: { id, tenantId: request.tenantId!, kind: 'WORKSPACE', environment: 'STAGING' } });
  if (!job) throw new ApiError(404, 'WORKSPACE_UNAVAILABLE', 'The workspace is unavailable.');
  await careWebsite(request, job.websiteId, tx);
  return job;
}
async function lockWorkspace(request: FastifyRequest, id: string, tx: Db) {
  const job = await workspace(request, id, tx);
  await tx.$queryRaw`SELECT id FROM websites WHERE id = ${job.websiteId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
  await assertWorkspaceActor(request, tx);
  return workspace(request, id, tx);
}
function assertEditable(job: CareJob) {
  if (job.state !== 'WAITING_FOR_INPUT') throw new ApiError(409, 'WORKSPACE_CLOSED', 'This workspace is closed. Its history remains available.');
}
async function currentRevision(tx: Db, job: CareJob, expected?: { version: number; sourceDigest: string }) {
  const revision = await tx.careRevision.findFirst({ where: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, version: job.planVersion } });
  if (!revision || (revision.plan as { policy?: string })?.policy !== WORKSPACE_POLICY) throw new ApiError(409, 'WORKSPACE_POLICY', 'The current workspace revision is unavailable.');
  if (expected && (revision.version !== expected.version || revision.sourceDigest !== expected.sourceDigest)) throw new ApiError(409, 'WORKSPACE_STALE', 'The workspace changed. Reload and review the current version before applying this action.');
  return revision;
}
async function sourceFor(tx: Db, job: CareJob, revision: CareRevision, env: Environment) {
  const artifact = await tx.careArtifact.findFirst({ where: { id: revision.sourceId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, environment: 'STAGING', kind: 'SOURCE_BUNDLE' } });
  if (!artifact || artifact.digest !== revision.sourceDigest) throw new ApiError(409, 'WORKSPACE_INTEGRITY', 'The workspace source does not match its recorded revision.');
  return prepareReviewSnapshot(JSON.parse(readArtifact(artifact, env).toString('utf8')).files.map(({ path, content }: { path: string; content: string }) => ({ path, content })));
}
function revisionResponse(revision: CareRevision) { return { id: revision.id, version: revision.version, sourceId: revision.sourceId, sourceDigest: revision.sourceDigest, state: revision.state, createdAt: revision.createdAt }; }

export async function careWorkspaceRoutes(app: FastifyInstance, options: { environment: Environment }) {
  const env = options.environment;
  app.addHook('preHandler', async () => { if (!env.CARE_REVIEW_ENABLED) throw new ApiError(503, 'WORKSPACE_DISABLED', 'Enable source review to use text workspaces.'); });
  app.post('/jobs/:id/workspaces', { bodyLimit: 4096, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    requirePermission(request, 'websites.manage');
    const { id } = parse(z.object({ id: uuid }).strict(), request.params);
    const args = parse(z.object({ requestKey: uuid, revisionId: uuid, sourceDigest: digest, authorizeTextWorkspace: z.literal(true) }).strict(), request.body);
    const result = await database.$transaction(async (tx) => {
      const parent = await tx.careJob.findFirst({ where: { id, tenantId: request.tenantId!, kind: 'REVIEW', environment: 'STAGING' } });
      if (!parent) throw new ApiError(404, 'SOURCE_UNAVAILABLE', 'Select a staging source-review job.');
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${parent.websiteId}::uuid FOR UPDATE`;
      await careWebsite(request, parent.websiteId, tx);
      await assertWorkspaceActor(request, tx);
      const requestFingerprint = fingerprint({ parentJobId: id, revisionId: args.revisionId, sourceDigest: args.sourceDigest, actor: request.userId });
      const existing = await tx.careJob.findUnique({ where: { tenantId_websiteId_requestKey: { tenantId: parent.tenantId, websiteId: parent.websiteId, requestKey: args.requestKey } } });
      if (existing) {
        if (existing.kind !== 'WORKSPACE' || existing.expectedBehavior !== requestFingerprint) throw new ApiError(409, 'REQUEST_KEY_CONFLICT', 'This key belongs to a different workspace request.');
        return { jobId: existing.id, created: false };
      }
      const revision = await tx.careRevision.findFirst({ where: { id: args.revisionId, jobId: parent.id, tenantId: parent.tenantId, websiteId: parent.websiteId, version: parent.planVersion, sourceDigest: args.sourceDigest } });
      if (!revision) throw new ApiError(409, 'WORKSPACE_STALE', 'Reload the source-review plan and confirm its current source.');
      const source = await tx.careArtifact.findFirst({ where: { id: revision.sourceId, tenantId: parent.tenantId, websiteId: parent.websiteId, jobId: parent.id, environment: 'STAGING', kind: 'SOURCE_BUNDLE', digest: args.sourceDigest } });
      if (!source) throw new ApiError(404, 'SOURCE_UNAVAILABLE', 'The approved source selection is unavailable.');
      const snapshot = prepareReviewSnapshot(JSON.parse(readArtifact(source, env).toString('utf8')).files.map(({ path, content }: { path: string; content: string }) => ({ path, content })));
      if (await tx.careJob.count({ where: { tenantId: parent.tenantId, websiteId: parent.websiteId, kind: 'WORKSPACE', state: 'WAITING_FOR_INPUT' } }) >= 10) throw new ApiError(429, 'WORKSPACE_LIMIT', 'Close an existing workspace before creating more. Saved versions are retained.');
      const job = await tx.careJob.create({ data: { tenantId: parent.tenantId, websiteId: parent.websiteId, userId: request.userId!, requestKey: args.requestKey, kind: 'WORKSPACE', environment: 'STAGING', state: 'WAITING_FOR_INPUT', summary: `Text workspace: ${parent.summary}`.slice(0, 1000), expectedBehavior: requestFingerprint } });
      const artifact = await writeArtifact(tx, { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, environment: 'STAGING', createdBy: request.userId! }, Buffer.from(JSON.stringify({ policy: snapshot.policy, files: snapshot.files.map(({ path, content }) => ({ path, content })) })), 'SOURCE_BUNDLE', 'workspace-v1.json', 'application/json', env);
      await tx.careRevision.create({ data: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, version: 1, sourceId: artifact.id, sourceDigest: artifact.digest, state: 'DRAFT', budgetMicros: 0, plan: { policy: WORKSPACE_POLICY, parentJobId: parent.id, parentRevisionId: revision.id, parentSourceDigest: source.digest, allowedPaths: snapshot.files.map((file) => file.path), authorizedBy: request.userId!, boundary: 'Customer-authorized text copy and literal edits only. No source execution, live access, model calls or release approval.' } } });
      await tx.careJob.update({ where: { id: job.id }, data: { sourceRevision: artifact.digest } });
      await careEvent(tx, job, 'workspace.created', job.state, 'A private text workspace was saved. Existing source and history are retained.', { jobId: job.id });
      await tx.auditLog.create({ data: { tenantId: job.tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.workspace_created', resourceType: 'job', resourceId: job.id, metadata: { parentJobId: id, sourceDigest: artifact.digest, requestFingerprint } } });
      return { jobId: job.id, created: true };
    });
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.get('/workspaces/:id', async (request) => {
    requirePermission(request, 'chat.read');
    const { id } = parse(z.object({ id: uuid }).strict(), request.params);
    const job = await workspace(request, id); const revision = await currentRevision(database, job);
    const snapshot = await sourceFor(database, job, revision, env);
    const [history, checks] = await Promise.all([
      database.careRevision.findMany({ where: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: id }, orderBy: { version: 'desc' }, select: revisionMetadata, take: 50 }),
      database.careArtifact.findMany({ where: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, environment: 'STAGING', kind: 'CHECK_RESULT', status: 'ACCEPTED' }, select: artifactMetadata, orderBy: { createdAt: 'desc' }, take: 50 })
    ]);
    return { job: { id, state: job.state, summary: job.summary }, revision: revisionResponse(revision), files: snapshot.files, history, checks, policy: WORKSPACE_POLICY, execution: 'NEVER_EXECUTED', releaseEligible: false };
  });

  app.get('/workspaces/:id/versions/:version', async (request, reply) => {
    requirePermission(request, 'chat.read');
    const { id, version } = parse(z.object({ id: uuid, version: z.coerce.number().int().min(1).max(50) }).strict(), request.params);
    const job = await workspace(request, id);
    const revision = await database.careRevision.findFirst({ where: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, version } });
    if (!revision) throw new ApiError(404, 'REVISION_UNAVAILABLE', 'This saved version is unavailable.');
    const snapshot = await sourceFor(database, job, revision, env);
    reply.header('content-disposition', `attachment; filename="workspace-v${version}.json"`);
    return { revision: revisionResponse(revision), files: snapshot.files.map(({ path, content }) => ({ path, content })), releaseEligible: false };
  });

  app.post('/workspaces/:id/patches', { bodyLimit: 120000, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
    requirePermission(request, 'websites.manage');
    const { id } = parse(z.object({ id: uuid }).strict(), request.params);
    const args = parse(baseSchema.extend({ patches: workspacePatchSchema, authorizeTextPatch: z.literal(true) }).strict(), request.body);
    const requestFingerprint = fingerprint({ ...args, actor: request.userId });
    const result = await database.$transaction(async (tx) => {
      const job = await lockWorkspace(request, id, tx);
      const existing = await tx.careRevision.findFirst({ where: { jobId: id, tenantId: job.tenantId, plan: { path: ['requestKey'], equals: args.requestKey } } });
      if (existing) {
        if ((existing.plan as { requestFingerprint?: string }).requestFingerprint !== requestFingerprint) throw new ApiError(409, 'REQUEST_KEY_CONFLICT', 'This key belongs to a different patch.');
        return { revision: revisionResponse(existing), created: false };
      }
      assertEditable(job);
      const revision = await currentRevision(tx, job, args);
      if (revision.version >= 50) throw new ApiError(429, 'WORKSPACE_VERSION_LIMIT', 'This workspace reached its 50-version limit. Its history is retained.');
      const snapshot = applyWorkspacePatch(await sourceFor(tx, job, revision, env), args.patches);
      const version = revision.version + 1;
      const artifact = await writeArtifact(tx, { tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, environment: 'STAGING', createdBy: request.userId! }, Buffer.from(JSON.stringify({ policy: snapshot.policy, files: snapshot.files.map(({ path, content }) => ({ path, content })) })), 'SOURCE_BUNDLE', `workspace-v${version}.json`, 'application/json', env);
      const saved = await tx.careRevision.create({ data: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, version, sourceId: artifact.id, sourceDigest: artifact.digest, state: 'DRAFT', budgetMicros: 0, plan: { policy: WORKSPACE_POLICY, previousRevisionId: revision.id, previousSourceDigest: revision.sourceDigest, requestKey: args.requestKey, requestFingerprint, authorizedBy: request.userId!, changedPaths: [...new Set(args.patches.map((patch) => patch.path))] } } });
      await tx.careJob.update({ where: { id }, data: { planVersion: version, sourceRevision: artifact.digest } });
      await careEvent(tx, job, 'workspace.patched', job.state, `Text version ${version} saved. Earlier versions and check reports remain available.`, { jobId: id });
      await tx.auditLog.create({ data: { tenantId: job.tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.workspace_patched', resourceType: 'revision', resourceId: saved.id, metadata: { jobId: id, version, sourceDigest: artifact.digest, requestFingerprint } } });
      return { revision: revisionResponse(saved), created: true };
    });
    return reply.code(result.created ? 201 : 200).send(result);
  });

  app.post('/workspaces/:id/checks/:toolId', { bodyLimit: 4096, config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (request, reply) => {
    requirePermission(request, 'websites.manage');
    const { id, toolId } = parse(z.object({ id: uuid, toolId: z.enum(['T33','T34']) }).strict(), request.params);
    const args = parse(baseSchema.strict(), request.body);
    const requestFingerprint = fingerprint({ ...args, toolId, actor: request.userId });
    const filename = `${toolId}-${args.requestKey}.json`;
    const existingResult = async (tx: Db, job: CareJob) => {
      const saved = await tx.careArtifact.findFirst({ where: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, environment: 'STAGING', kind: 'CHECK_RESULT', filename } });
      if (!saved) return null;
      const result = JSON.parse(readArtifact(saved, env).toString('utf8'));
      if (result.requestFingerprint !== requestFingerprint) throw new ApiError(409, 'REQUEST_KEY_CONFLICT', 'This key belongs to a different check request.');
      return { artifactId: saved.id, ...result };
    };
    const job = await workspace(request, id);
    const existing = await existingResult(database, job); if (existing) return existing;
    assertEditable(job);
    const revision = await currentRevision(database, job, args);
    const output = await runSourceQuality(toolId, await sourceFor(database, job, revision, env));
    const result = await database.$transaction(async (tx) => {
      const current = await lockWorkspace(request, id, tx);
      const duplicate = await existingResult(tx, current); if (duplicate) return { value: duplicate, created: false };
      assertEditable(current); await currentRevision(tx, current, args);
      if (await tx.careArtifact.count({ where: { jobId: id, kind: 'CHECK_RESULT' } }) >= 50) throw new ApiError(429, 'WORKSPACE_CHECK_LIMIT', 'This workspace reached its retained check limit. Existing results are preserved.');
      const value = { toolId, version: revision.version, sourceDigest: revision.sourceDigest, observedAt: new Date().toISOString(), requestFingerprint, output, releaseEligible: false };
      const artifact = await writeArtifact(tx, { tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, environment: 'STAGING', createdBy: request.userId! }, Buffer.from(JSON.stringify(value)), 'CHECK_RESULT', filename, 'application/json', env);
      await careEvent(tx, job, 'workspace.checked', job.state, `${toolId} completed for text version ${revision.version}. Runtime tests were not run.`, { jobId: id });
      return { value: { artifactId: artifact.id, ...value }, created: true };
    });
    return reply.code(result.created ? 201 : 200).send(result.value);
  });

  app.get('/workspaces/:id/check-results/:artifactId', async (request) => {
    requirePermission(request, 'chat.read');
    const { id, artifactId } = parse(z.object({ id: uuid, artifactId: uuid }).strict(), request.params);
    const job = await workspace(request, id);
    const artifact = await database.careArtifact.findFirst({ where: { id: artifactId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: id, environment: 'STAGING', kind: 'CHECK_RESULT' } });
    if (!artifact) throw new ApiError(404, 'ARTIFACT_UNAVAILABLE', 'This saved check is unavailable in the workspace.');
    return JSON.parse(readArtifact(artifact, env).toString('utf8'));
  });
}
