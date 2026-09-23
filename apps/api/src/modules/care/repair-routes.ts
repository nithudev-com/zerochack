import type { FastifyInstance, FastifyRequest } from 'fastify';
import { database } from '@zerochack/database';
import type { Environment } from '@zerochack/config';
import { z } from 'zod';
import { assertStaticTarget, CareError, inspectStaticHtml, looksSensitive, sanitizeScreenshot, staticPreview, STATIC_POLICY_VERSION } from '@zerochack/care';
import type { AiService } from '../ai/service.js';
import { requirePermission } from '../auth/security.js';
import { ApiError } from '../../errors.js';
import { careEvent, careWebsite } from './service.js';
import { reconcileRelease } from './release-service.js';
import { artifactMetadata, readArtifact, repairConfiguration, reserveEstimate, reserveRepairBudget, writeArtifact } from './repair-service.js';

const uuid = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
function input<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Check the required fields.'); return result.data; }
async function jobFor(request: FastifyRequest) {
  const { id } = input(z.object({ id: uuid }), request.params);
  const job = await database.careJob.findFirst({ where: { id, tenantId: request.tenantId!, kind: 'REPAIR' } });
  if (!job) throw new ApiError(404, 'NOT_FOUND', 'Repair request was not found.');
  await careWebsite(request, job.websiteId); return job;
}
export async function repairRoutes(app: FastifyInstance, options: { environment: Environment; ai: AiService }) {
  const env = options.environment;
  app.addHook('preHandler', async () => { if (!env.CARE_REPAIR_ENABLED) throw new ApiError(503, 'REPAIR_DISABLED', 'Static HTML repair is not enabled.'); });
  app.setErrorHandler((error, _request, reply) => { if (error instanceof CareError) return reply.code(400).send({ error: { code: error.code, message: error.message } }); throw error; });
  app.post('/websites/:websiteId/artifacts', { bodyLimit: 3_000_000, config: { rateLimit: { max: 12, timeWindow: '1 minute' } } }, async (request, reply) => {
    requirePermission(request, 'websites.manage');
    const { websiteId } = input(z.object({ websiteId: uuid }), request.params); await careWebsite(request, websiteId);
    const body = input(z.object({ jobId: uuid, kind: z.enum(['SOURCE','SCREENSHOT','LOG']), base64: z.string().min(1).max(2_700_000).regex(/^[A-Za-z0-9+/]*={0,2}$/), privacyReviewed: z.literal(true) }).strict(), request.body);
    const job = await database.careJob.findFirst({ where: { id: body.jobId, tenantId: request.tenantId!, websiteId, kind: 'REPAIR' } });
    if (!job) throw new ApiError(404, 'NOT_FOUND', 'Repair request was not found.');
    let bytes: Buffer = Buffer.from(body.base64, 'base64'); let filename = 'index.html'; let contentType = 'text/html';
    if (bytes.length > 2_000_000 || bytes.toString('base64').replace(/=+$/, '') !== body.base64.replace(/=+$/, '')) throw new ApiError(400, 'ATTACHMENT_LIMIT', 'Attachment data is invalid or too large.');
    if (body.kind !== 'SCREENSHOT') { try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new ApiError(400, 'INVALID_ENCODING', 'Use UTF-8 source and logs.'); } }
    if (body.kind === 'SOURCE') inspectStaticHtml(bytes.toString('utf8'));
    else if (body.kind === 'SCREENSHOT') { bytes = await sanitizeScreenshot(bytes); filename = 'reviewed-screenshot.png'; contentType = 'image/png'; }
    else { if (bytes.length > 100000 || bytes.includes(0) || looksSensitive(bytes.toString('utf8'))) throw new ApiError(400, 'SENSITIVE_CONTENT_BLOCKED', 'Use a redacted plain-text log up to 100 KB.'); filename = 'reviewed-log.txt'; contentType = 'text/plain'; }
    const artifact = await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${job.tenantId}::uuid FOR UPDATE`;
      const usage = await tx.careArtifact.aggregate({ where: { tenantId: job.tenantId, status: 'ACCEPTED' }, _sum: { sizeBytes: true }, _count: true });
      if (usage._count >= 200 || (usage._sum.sizeBytes ?? 0) + bytes.length > 50_000_000) throw new ApiError(429, 'ARTIFACT_QUOTA', 'Remove expired or unnecessary attachments before uploading more.');
      const stored = await writeArtifact(tx, { tenantId: job.tenantId, websiteId, jobId: job.id, environment: job.environment, createdBy: request.userId! }, bytes, body.kind, filename, contentType, env);
      await careEvent(tx, job, 'artifact.accepted', 'ACCEPTED', `${body.kind.toLowerCase()} attachment accepted after validation.`, { jobId: job.id });
      await tx.auditLog.create({ data: { tenantId: job.tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.artifact_accepted', resourceType: 'artifact', resourceId: stored.id, metadata: { kind: body.kind, bytes: stored.sizeBytes, privacyReviewed: true } } });
      return tx.careArtifact.findUniqueOrThrow({ where: { id: stored.id }, select: artifactMetadata });
    });
    return reply.code(201).send(artifact);
  });
  app.get('/artifacts/:id/:view', async (request) => {
    requirePermission(request, 'chat.read');
    const { id, view } = input(z.object({ id: uuid, view: z.enum(['content','preview']) }), request.params);
    const artifact = await database.careArtifact.findFirst({ where: { id, tenantId: request.tenantId! } });
    if (!artifact) throw new ApiError(404, 'NOT_FOUND', 'Artifact was not found.'); await careWebsite(request, artifact.websiteId);
    const bytes = readArtifact(artifact, env);
    if (view === 'preview') {
      if (!['SOURCE','CANDIDATE'].includes(artifact.kind)) throw new ApiError(400, 'PREVIEW_UNAVAILABLE', 'Only validated HTML has a page preview.');
      return { html: staticPreview(bytes.toString('utf8')), digest: artifact.digest, restrictions: 'Scripts, navigation, forms, and network access disabled' };
    }
    return { filename: artifact.filename, contentType: artifact.contentType, base64: bytes.toString('base64'), digest: artifact.digest };
  });
  app.delete('/artifacts/:id', async (request, reply) => {
    requirePermission(request, 'websites.manage'); const { id } = input(z.object({ id: uuid }), request.params);
    const artifact = await database.careArtifact.findFirst({ where: { id, tenantId: request.tenantId! } });
    if (!artifact) throw new ApiError(404, 'NOT_FOUND', 'Artifact was not found.'); await careWebsite(request, artifact.websiteId);
    await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${artifact.websiteId}::uuid FOR UPDATE`;
      if (await tx.careRelease.count({ where: { websiteId: artifact.websiteId, state: { in: ['QUEUED','RUNNING','VERIFYING','OUTCOME_UNKNOWN'] } } })) throw new ApiError(409, 'RELEASE_ACTIVE', 'Keep recovery artifacts until the release outcome is reconciled.');
      await tx.careArtifact.update({ where: { id }, data: { status: 'DELETED', encryptedBody: '' } });
      await careEvent(tx, artifact, 'artifact.deleted', 'DELETED', 'Attachment content removed. Dependent approvals must be reviewed.', artifact.jobId ? { jobId: artifact.jobId } : undefined);
    }); return reply.code(204).send();
  });
  app.get('/jobs/:id/workflow', async (request) => {
    requirePermission(request, 'chat.read'); const job = await jobFor(request);
    const [revisions, artifacts, releases] = await Promise.all([
      database.careRevision.findMany({ where: { jobId: job.id, tenantId: job.tenantId }, orderBy: { version: 'desc' } }),
      database.careArtifact.findMany({ where: { jobId: job.id, tenantId: job.tenantId, status: 'ACCEPTED', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, select: artifactMetadata, orderBy: { createdAt: 'desc' } }),
      database.careRelease.findMany({ where: { jobId: job.id, tenantId: job.tenantId }, orderBy: { createdAt: 'desc' } })
    ]); return { job, revisions, artifacts, releases, capabilities: { stack: 'STATIC_HTML', release: env.CARE_RELEASE_ENABLED, maximumBudgetMicros: env.CARE_JOB_BUDGET_MICROS } };
  });
  app.post('/jobs/:id/change-plan', async (request, reply) => {
    requirePermission(request, 'websites.manage'); requirePermission(request, 'ai.use'); const job = await jobFor(request);
    const body = input(z.object({ sourceId: uuid, budgetMicros: z.number().int().min(1000).max(env.CARE_JOB_BUDGET_MICROS) }).strict(), request.body);
    const source = await database.careArtifact.findFirst({ where: { id: body.sourceId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, kind: { in: ['SOURCE','CANDIDATE'] } } });
    if (!source) throw new ApiError(404, 'NOT_FOUND', 'Validated source was not found.');
    const bytes = readArtifact(source, env); const baseline = inspectStaticHtml(bytes.toString('utf8'));
    const configuration = await options.ai.configuration(job.tenantId); const maximumEstimate = reserveEstimate(bytes, configuration);
    if (maximumEstimate > body.budgetMicros) throw new ApiError(400, 'BUDGET_EXCEEDED', 'The conservative model allowance exceeds this budget. Configure a smaller model/token limit or approve a larger allowance.');
    const revision = await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${job.websiteId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
      const current = await tx.careJob.findUniqueOrThrow({ where: { id: job.id } });
      if (['RUNNING','VERIFYING','QUEUED'].includes(current.state) || await tx.careRevision.findUnique({ where: { jobId_version: { jobId: job.id, version: current.planVersion } } })) throw new ApiError(409, 'PLAN_EXISTS', 'Review the current plan or add feedback to create a new version.');
      const revision = await tx.careRevision.create({ data: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, version: current.planVersion, sourceId: source.id, sourceDigest: source.digest, budgetMicros: body.budgetMicros, plan: { policy: STATIC_POLICY_VERSION, allowedFiles: ['index.html'], issue: current.summary, expectedBehavior: current.expectedBehavior, baseline, maximumEstimateMicros: maximumEstimate, configuration: repairConfiguration(configuration), boundary: 'Prepare one static HTML candidate; no live writes, scripts, package installation, or source execution.', checks: ['static-content-policy','language','viewport','title','image-alternatives','unique-identifiers'], requiresCustomerPreview: true } } });
      await tx.careJob.update({ where: { id: job.id }, data: { state: 'AWAITING_APPROVAL', errorCode: null } });
      await careEvent(tx, job, 'approval.required', 'AWAITING_APPROVAL', 'Review the scoped static HTML plan and maximum model allowance.', { jobId: job.id });
      return revision;
    });
    return reply.code(201).send(revision);
  });
  app.post('/change-plans/:id/approve', async (request) => {
    requirePermission(request, 'websites.manage'); requirePermission(request, 'ai.use');
    const { id } = input(z.object({ id: uuid }), request.params);
    const body = input(z.object({ sourceDigest: digest, version: z.number().int(), budgetMicros: z.number().int(), authorizeRepair: z.literal(true) }).strict(), request.body);
    const revision = await database.careRevision.findFirst({ where: { id, tenantId: request.tenantId! } });
    if (!revision) throw new ApiError(404, 'NOT_FOUND', 'Plan was not found.'); await careWebsite(request, revision.websiteId);
    const policy = await options.ai.configuration(revision.tenantId);
    return database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${revision.websiteId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${revision.jobId}::uuid FOR UPDATE`;
      const job = await tx.careJob.findUniqueOrThrow({ where: { id: revision.jobId } });
      const current = await tx.careRevision.findUniqueOrThrow({ where: { id } });
      const source = await tx.careArtifact.findUniqueOrThrow({ where: { id: current.sourceId } }); readArtifact(source, env);
      if (job.state !== 'AWAITING_APPROVAL' || job.planVersion !== current.version || current.state !== 'AWAITING_APPROVAL' || body.version !== current.version || body.sourceDigest !== current.sourceDigest || body.budgetMicros !== current.budgetMicros || current.budgetMicros > env.CARE_JOB_BUDGET_MICROS) throw new ApiError(409, 'APPROVAL_STALE', 'The approval does not match the current source, plan, or budget.');
      await reserveRepairBudget(tx, current, policy.dailyCostLimitMicros > 0 ? policy.dailyCostLimitMicros : env.CARE_JOB_BUDGET_MICROS * 20);
      await tx.careRevision.update({ where: { id }, data: { state: 'APPROVED', approvedBy: request.userId!, approvalExpiresAt: new Date(Date.now() + 3600000), budgetState: 'RESERVED' } });
      await tx.careJob.update({ where: { id: job.id }, data: { state: 'QUEUED', userId: request.userId!, approvedVersion: current.version, approvedBy: request.userId!, approvalExpiresAt: new Date(Date.now() + 3600000), errorCode: null } });
      await careEvent(tx, job, 'job.queued', 'QUEUED', 'The approved candidate preparation is queued. No production release was authorized.', { jobId: job.id });
      await tx.auditLog.create({ data: { tenantId: job.tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.repair_approved', resourceType: 'revision', resourceId: id, metadata: { version: current.version, sourceDigest: current.sourceDigest, budgetMicros: current.budgetMicros } } });
      return { state: 'QUEUED' };
    });
  });
  app.post('/jobs/:id/releases', async (request, reply) => {
    requirePermission(request, 'websites.manage'); const job = await jobFor(request);
    if (!env.CARE_RELEASE_ENABLED) throw new ApiError(503, 'RELEASE_DISABLED', 'Single-file SFTP release is not enabled. Download and review the candidate instead.');
    const body = input(z.object({ requestKey: uuid, revisionId: uuid, credentialId: uuid, remotePath: z.string().max(1024) }).strict(), request.body); assertStaticTarget(body.remotePath);
    const result = await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${job.websiteId}::uuid FOR UPDATE`;
      const existing = await tx.careRelease.findUnique({ where: { tenantId_websiteId_requestKey: { tenantId: job.tenantId, websiteId: job.websiteId, requestKey: body.requestKey } } });
      if (existing) { if (existing.jobId !== job.id || existing.revisionId !== body.revisionId || existing.credentialId !== body.credentialId || existing.remotePath !== body.remotePath) throw new ApiError(409, 'REQUEST_KEY_CONFLICT', 'Use a new request key for a different release.'); return { release: existing, created: false }; }
      const revision = await tx.careRevision.findFirst({ where: { id: body.revisionId, jobId: job.id, version: job.planVersion, state: 'VERIFIED' } });
      const credential = await tx.careCredential.findFirst({ where: { id: body.credentialId, tenantId: job.tenantId, websiteId: job.websiteId, environment: 'PRODUCTION', kind: 'SSH', status: 'STORED', authorizationExpiresAt: { gt: new Date() } } });
      const bridge = await tx.websiteAccessCredential.findFirst({ where: { websiteId: job.websiteId, vaultCredentialId: body.credentialId, hostKeyFingerprint: { not: null } } });
      const website = await tx.website.findUniqueOrThrow({ where: { id: job.websiteId } });
      if (!revision?.candidateId || !revision.candidateDigest || !credential || !bridge || website.connectionStatus !== 'VERIFIED') throw new ApiError(409, 'RELEASE_NOT_READY', 'A verified candidate, verified website, and current fingerprint-pinned SSH account are required.');
      const release = await tx.careRelease.create({ data: { ...body, tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, credentialVersion: credential.version, sourceDigest: revision.sourceDigest, candidateDigest: revision.candidateDigest, evidence: { url: website.url, hostKeyFingerprint: bridge.hostKeyFingerprint } } });
      await careEvent(tx, job, 'release.approval_required', 'AWAITING_APPROVAL', 'Review the exact candidate, production path, and rollback authorization before approving release.', { jobId: job.id });
      return { release, created: true };
    });
    return reply.code(result.created ? 201 : 200).send(result.release);
  });
  app.post('/releases/:id/cancel', async (request) => {
    requirePermission(request, 'websites.manage');
    const { id } = input(z.object({ id: uuid }), request.params);
    return database.$transaction(async (tx) => {
      const release = await tx.careRelease.findFirst({ where: { id, tenantId: request.tenantId! } });
      if (!release) throw new ApiError(404, 'NOT_FOUND', 'Release was not found.');
      await careWebsite(request, release.websiteId, tx);
      const changed = await tx.careRelease.updateMany({ where: { id, state: { in: ['AWAITING_APPROVAL','QUEUED'] } }, data: { state: 'CANCELLED', approvalExpiresAt: null } });
      if (!changed.count) throw new ApiError(409, 'RELEASE_ALREADY_STARTED', 'The worker already started this release. Wait for the observed result or reconcile an unknown outcome.');
      await tx.auditLog.create({ data: { tenantId: release.tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.release_cancelled', resourceType: 'release', resourceId: id } });
      await careEvent(tx, { ...release, environment: 'PRODUCTION' }, 'release.cancelled', 'CANCELLED', 'The pending release approval was cancelled before execution.', { jobId: release.jobId });
      return { state: 'CANCELLED' };
    });
  });
  app.post('/releases/:id/reconcile', async (request) => {
    requirePermission(request, 'websites.manage');
    const { id } = input(z.object({ id: uuid }), request.params);
    const release = await database.careRelease.findFirst({ where: { id, tenantId: request.tenantId! } });
    if (!release) throw new ApiError(404, 'NOT_FOUND', 'Release was not found.');
    await careWebsite(request, release.websiteId);
    if (!request.mfaVerifiedAt || request.mfaVerifiedAt.getTime() < Date.now() - 300000) throw new ApiError(403, 'MFA_REQUIRED', 'Verify your authenticator before reconciling.');
    return reconcileRelease(release.id, env);
  });
  app.post('/releases/:id/approve', async (request) => {
    requirePermission(request, 'websites.manage');
    if (!env.CARE_RELEASE_ENABLED) throw new ApiError(503, 'RELEASE_DISABLED', 'Release is disabled.');
    const { id } = input(z.object({ id: uuid }), request.params);
    const body = input(z.object({ candidateDigest: digest, sourceDigest: digest, remotePath: z.string(), credentialId: uuid, authorizeProductionAndRollback: z.literal(true) }).strict(), request.body);
    if (!request.mfaVerifiedAt || request.mfaVerifiedAt.getTime() < Date.now() - 300000) throw new ApiError(403, 'MFA_REQUIRED', 'Verify your authenticator before approving production release.');
    return database.$transaction(async (tx) => {
      const release = await tx.careRelease.findFirst({ where: { id, tenantId: request.tenantId! } });
      if (!release) throw new ApiError(404, 'NOT_FOUND', 'Release was not found.'); await careWebsite(request, release.websiteId, tx);
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${release.websiteId}::uuid FOR UPDATE`;
      const current = await tx.careRelease.findUniqueOrThrow({ where: { id } });
      const job = await tx.careJob.findUniqueOrThrow({ where: { id: current.jobId } }); const revision = await tx.careRevision.findUniqueOrThrow({ where: { id: current.revisionId } });
      const user = await tx.user.findUniqueOrThrow({ where: { id: request.userId! } });
      const credential = await tx.careCredential.findUniqueOrThrow({ where: { id: current.credentialId } });
      if (credential.version !== current.credentialVersion || credential.status !== 'STORED' || credential.authorizationExpiresAt <= new Date() || job.state === 'CANCELLED' || !user.mfaEnabledAt || current.state !== 'AWAITING_APPROVAL' || revision.version !== job.planVersion || revision.state !== 'VERIFIED' || ['candidateDigest','sourceDigest','remotePath','credentialId'].some((key) => current[key as keyof typeof current] !== body[key as keyof typeof body])) throw new ApiError(409, 'APPROVAL_STALE', 'The release approval is stale or MFA is unavailable.');
      if (await tx.careRelease.count({ where: { tenantId: job.tenantId, websiteId: job.websiteId, state: { in: ['QUEUED','RUNNING','VERIFYING','OUTCOME_UNKNOWN'] } } })) throw new ApiError(409, 'RELEASE_CONFLICT', 'Another release requires completion or reconciliation.');
      for (const artifactId of [revision.sourceId, revision.candidateId!]) readArtifact(await tx.careArtifact.findUniqueOrThrow({ where: { id: artifactId } }), env);
      await tx.careRelease.update({ where: { id }, data: { state: 'QUEUED', approvedBy: request.userId!, approvalExpiresAt: new Date(Date.now() + 900000) } });
      await tx.auditLog.create({ data: { tenantId: job.tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.production_release_approved', resourceType: 'release', resourceId: id, metadata: { candidateDigest: current.candidateDigest, sourceDigest: current.sourceDigest, remotePath: current.remotePath, credentialId: current.credentialId, credentialVersion: current.credentialVersion, rollbackAuthorized: true } } });
      await careEvent(tx, job, 'release.queued', 'QUEUED', 'The exact single-file production release and conditional rollback were approved.', { jobId: job.id });
      return { state: 'QUEUED' };
    });
  });
}
