import type { FastifyInstance } from 'fastify';
import type { CareJob } from '@prisma/client';
import { z } from 'zod';
import { database } from '@zerochack/database';
import type { Environment } from '@zerochack/config';
import { digestBytes, executeReviewTool, implementedReviewTools, implementedRecordTools, prepareReviewSnapshot, reviewResultSchema, toolCatalogue, REVIEW_POLICY_VERSION } from '@zerochack/care';
import { ApiError } from '../../errors.js';
import { requirePermission } from '../auth/security.js';
import { careEvent, careWebsite } from './service.js';
import { readArtifact, assertRepairActor } from './repair-service.js';
import { recoveryReadiness } from './recovery-readiness.js';

const empty = z.object({}).strict();
const uuid = z.string().uuid();
const recordSchemas = {
  T03: empty, T05: empty,
  T12: z.object({ baselineArtifactId: uuid, candidateArtifactId: uuid }).strict(),
  T16: z.object({ revisionId: uuid, sourceDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  T51: empty, T56: empty, T57: empty, T58: empty, T62: empty
};
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError(400, 'TOOL_INPUT_INVALID', 'Check the arguments for this tool.');
  return result.data;
}
async function scopedArtifact(job: CareJob, id: string, env: Environment) {
  const artifact = await database.careArtifact.findFirst({ where: { id, tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, environment: job.environment, kind: { in: ['SOURCE_BUNDLE','SOURCE','CANDIDATE'] } } });
  if (!artifact) throw new ApiError(404, 'ARTIFACT_UNAVAILABLE', 'This source artifact is unavailable in the current job.');
  const bytes = readArtifact(artifact, env);
  const files = artifact.kind === 'SOURCE_BUNDLE' ? prepareReviewSnapshot(JSON.parse(bytes.toString('utf8')).files).files : [{ path: 'index.html', digest: artifact.digest }];
  return { artifact, files };
}
async function compareArtifacts(job: CareJob, beforeId: string, afterId: string, env: Environment) {
  if (beforeId === afterId) throw new ApiError(400, 'TOOL_INPUT_INVALID', 'Choose two distinct source artifacts.');
  const [before, after] = await Promise.all([scopedArtifact(job, beforeId, env), scopedArtifact(job, afterId, env)]);
  const old = new Map(before.files.map((f) => [f.path, f.digest]));
  const next = new Map(after.files.map((f) => [f.path, f.digest]));
  const changes = [...new Set([...old.keys(), ...next.keys()])].sort().filter((path) => old.get(path) !== next.get(path)).map((path) => ({ path, beforeDigest: old.get(path) ?? null, afterDigest: next.get(path) ?? null, change: !old.has(path) ? 'ADDED' : !next.has(path) ? 'REMOVED' : 'MODIFIED' }));
  return { baselineDigest: before.artifact.digest, candidateDigest: after.artifact.digest, changes, limitation: 'Exact stored content hashes and changed paths only. No live repository, semantic diff or file-ownership check.' };
}
async function savedReports(job: CareJob, env: Environment) {
  const agents = await database.careAgentRun.findMany({ where: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, state: 'COMPLETED', resultArtifactId: { not: null } }, orderBy: { stepIndex: 'asc' }, take: 24 });
  const reports = [];
  for (const agent of agents) {
    const artifact = await database.careArtifact.findFirst({ where: { id: agent.resultArtifactId!, tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, environment: job.environment, kind: 'REVIEW_RESULT', status: 'ACCEPTED', OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] } });
    if (artifact) reports.push({ artifactId: artifact.id, digest: artifact.digest, ...reviewResultSchema.parse(JSON.parse(readArtifact(artifact, env).toString('utf8'))) });
  }
  return reports;
}
async function recordOutput(id: typeof implementedRecordTools[number], args: unknown, job: CareJob, env: Environment) {
  const scope = { tenantId: job.tenantId, websiteId: job.websiteId };
  const jobScope = { ...scope, jobId: job.id };
  switch (id) {
    case 'T03': {
      const credentials = await database.careCredential.findMany({ where: { ...scope, environment: job.environment, status: 'STORED', authorizationExpiresAt: { gt: new Date() } }, select: { kind: true, authorizationExpiresAt: true }, take: 101 });
      return { credentialTypes: [...new Set(credentials.slice(0, 100).map((c) => c.kind))], recordedAccounts: Math.min(credentials.length, 100), truncated: credentials.length > 100, allowedActions: ['READ_CAPABILITY_METADATA'], secretDisclosure: false, connectionStatus: 'NOT_CHECKED', limitation: 'Stored credentials do not grant a model live access. Specialist disclosure and production release need separate scoped approvals.' };
    }
    case 'T05': {
      const reports = await savedReports(job, env);
      const findings = reports.flatMap((r) => r.findings.map((f) => ({ roleId: r.roleId, artifactId: r.artifactId, ...f })));
      return { state: reports.length ? 'RECORDED_EVIDENCE' : 'NOT_OBSERVED', findings: findings.slice(0, 8), totalFindings: findings.length, truncated: findings.length > 8, reportReferences: reports.map(({ artifactId, digest, roleId }) => ({ artifactId, digest, roleId })), limitation: 'Stored source-review observations and citations, not verified vulnerabilities or runtime test results. Full reports remain available in the review view.' };
    }
    case 'T12': { const value = recordSchemas.T12.parse(args); return compareArtifacts(job, value.baselineArtifactId, value.candidateArtifactId, env); }
    case 'T16': {
      const value = recordSchemas.T16.parse(args);
      const revision = await database.careRevision.findFirst({ where: { ...jobScope, id: value.revisionId } });
      if (!revision) throw new ApiError(404, 'REVISION_UNAVAILABLE', 'This revision is unavailable in the current job.');
      return { conflict: revision.version !== job.planVersion || revision.sourceDigest !== value.sourceDigest, planVersion: job.planVersion, revisionVersion: revision.version, sourceDigest: revision.sourceDigest, limitation: 'Persisted plan/source binding only. No live checkout, merge-conflict detection or file ownership evaluation.' };
    }
    case 'T51': {
      const revision = await database.careRevision.findFirst({ where: { ...jobScope, version: job.planVersion } });
      if (!revision?.candidateId) return { state: 'NOT_OBSERVED', limitation: 'No candidate is recorded for the current plan.' };
      return { state: revision.state, version: revision.version, diff: await compareArtifacts(job, revision.sourceId, revision.candidateId, env), verification: revision.verification, limitation: 'Recorded candidate comparison and actual attached checks only; this does not claim browser testing or deployment.' };
    }
    case 'T56': {
      const releases = await database.careRelease.findMany({ where: jobScope, orderBy: { createdAt: 'desc' }, take: 21, select: { id: true, state: true, sourceDigest: true, candidateDigest: true, heartbeatAt: true, createdAt: true, errorCode: true } });
      return { state: releases.length ? 'RECORDED_EVIDENCE' : 'NOT_OBSERVED', targetEnvironment: 'PRODUCTION', releases: releases.slice(0, 20), truncated: releases.length > 20, limitation: 'Recorded single-file release state only; no new live health observation.' };
    }
    case 'T57': {
      const [jobs, releases] = await Promise.all([
        database.careAgentRun.findMany({ where: { ...jobScope, errorCode: { not: null } }, select: { roleId: true, state: true, errorCode: true, completedAt: true }, take: 24 }),
        database.careRelease.findMany({ where: { ...jobScope, errorCode: { not: null } }, select: { id: true, state: true, errorCode: true, heartbeatAt: true }, orderBy: { createdAt: 'desc' }, take: 20 })
      ]);
      const code = (value: string | null) => value && /^[A-Z][A-Z0-9_]{0,99}$/.test(value) ? value : 'REDACTED_ERROR';
      return { observedAt: new Date().toISOString(), job: { state: job.state, errorCode: job.errorCode ? code(job.errorCode) : null }, agents: jobs.map((r) => ({ ...r, errorCode: code(r.errorCode) })), releases: releases.map((r) => ({ ...r, errorCode: code(r.errorCode) })), limitation: 'Bounded application error codes only; host logs, stack traces and customer telemetry are not read. At most 24 agent and 20 release records.' };
    }
    case 'T58': {
      if (job.environment !== 'PRODUCTION') return { state: 'NOT_OBSERVED', limitation: 'The current monitoring service records production only.' };
      const [policy, lastCheck] = await Promise.all([
        database.monitoringPolicy.findFirst({ where: scope, select: { enabled: true, intervalMinutes: true, nextCheckAt: true } }),
        database.monitoringCheck.findFirst({ where: scope, orderBy: { startedAt: 'desc' }, select: { status: true, startedAt: true, completedAt: true, responseTimeMs: true } })
      ]);
      return { state: lastCheck ? 'RECORDED_EVIDENCE' : 'NOT_OBSERVED', observedAt: new Date().toISOString(), policy, lastCheck, stale: !lastCheck?.completedAt || Date.now() - lastCheck.completedAt.getTime() > (policy?.intervalMinutes ?? 60) * 120000, limitation: 'Latest saved monitoring check, not a current uptime or security guarantee. No URL is fetched.' };
    }
    case 'T62': {
      const reports = await savedReports(job, env);
      return { jobId: job.id, state: job.state, reports: reports.map(({ roleId, status, summary, findings, artifactId, digest }) => ({ roleId, status, summary, findingCount: findings.length, artifactId, digest })), limitation: 'Summary of recorded source reports. Missing or deleted reports are omitted; a completed review does not mean a completed repair or passing runtime tests.' };
    }
  }
}

/** Fixed, authenticated dispatch. The AI provider is never given this endpoint or a tool loop. */
export async function careToolRoutes(app: FastifyInstance, options: { environment: Environment }) {
  const env = options.environment;
  app.post('/jobs/:id/monitoring-plan', { bodyLimit: 4096, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    requirePermission(request, 'websites.manage');
    const { id } = input(z.object({ id: uuid }).strict(), request.params);
    const args = input(z.object({ requestKey: uuid, intervalMinutes: z.number().int().min(5).max(10080), alertCooldownMinutes: z.number().int().min(5).max(10080), expectedStatus: z.number().int().min(100).max(599).default(200) }).strict(), request.body);
    const job = await database.careJob.findFirst({ where: { id, tenantId: request.tenantId! } });
    if (!job) throw new ApiError(404, 'NOT_FOUND', 'Job was not found.');
    await careWebsite(request, job.websiteId);
    if (job.environment !== 'PRODUCTION') throw new ApiError(409, 'ENVIRONMENT_UNSUPPORTED', 'The current monitoring service supports production only.');
    const proposal = { toolId: 'T64', parentJobId: job.id, websiteId: job.websiteId, environment: job.environment, intervalMinutes: args.intervalMinutes, alertCooldownMinutes: args.alertCooldownMinutes, indicators: { expectedStatus: args.expectedStatus }, requiresCustomerApproval: true, activation: 'NOT_SCHEDULED', limitation: 'Saved proposal only. After customer review, an authorized operator must configure the monitoring policy and verify scheduler execution separately.' };
    const fingerprint = digestBytes(Buffer.from(JSON.stringify(proposal)));
    const result = await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${job.websiteId}::uuid FOR UPDATE`;
      await careWebsite(request, job.websiteId, tx);
      const existing = await tx.careJob.findUnique({ where: { tenantId_websiteId_requestKey: { tenantId: job.tenantId, websiteId: job.websiteId, requestKey: args.requestKey } } });
      if (existing) {
        if (existing.kind !== 'MONITOR_PLAN' || existing.sourceRevision !== fingerprint || existing.userId !== request.userId) throw new ApiError(409, 'REQUEST_KEY_CONFLICT', 'This key already belongs to a different proposal.');
        return { proposalJobId: existing.id, created: false };
      }
      if (await tx.careJob.count({ where: { tenantId: job.tenantId, websiteId: job.websiteId, kind: 'MONITOR_PLAN', state: { notIn: ['COMPLETED','CANCELLED','FAILED'] } } }) >= 10) throw new ApiError(429, 'PROPOSAL_LIMIT', 'Review or cancel existing monitoring proposals before adding more. History is retained.');
      const saved = await tx.careJob.create({ data: { tenantId: job.tenantId, websiteId: job.websiteId, userId: request.userId!, environment: job.environment, requestKey: args.requestKey, kind: 'MONITOR_PLAN', state: 'WAITING_FOR_INPUT', summary: 'Monitoring schedule proposal requires customer review', expectedBehavior: JSON.stringify(proposal), sourceRevision: fingerprint } });
      await careEvent(tx, saved, 'monitoring.proposed', 'WAITING_FOR_INPUT', 'A monitoring proposal was saved. No check was scheduled or host contacted.', { jobId: saved.id });
      await tx.auditLog.create({ data: { tenantId: job.tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.monitoring_proposed', resourceType: 'job', resourceId: saved.id, metadata: { parentJobId: job.id, fingerprint } } });
      return { proposalJobId: saved.id, created: true };
    });
    return reply.code(result.created ? 201 : 200).send({ proposalJobId: result.proposalJobId, proposal, fingerprint });
  });
  app.post('/jobs/:id/tools/:toolId', { bodyLimit: 4096, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (request) => {
    requirePermission(request, 'chat.read');
    const { id, toolId } = input(z.object({ id: uuid, toolId: z.string().regex(/^T\d{2}$/) }).strict(), request.params);
    const job = await database.careJob.findFirst({ where: { id, tenantId: request.tenantId! } });
    if (!job) throw new ApiError(404, 'NOT_FOUND', 'Job was not found.');
    await careWebsite(request, job.websiteId);
    let output: unknown;
    if ((implementedRecordTools as readonly string[]).includes(toolId)) {
      const recordId = toolId as typeof implementedRecordTools[number];
      input<unknown>(recordSchemas[recordId], request.body);
      output = await recordOutput(recordId, request.body, job, env);
    } else if ((implementedReviewTools as readonly string[]).includes(toolId)) {
      requirePermission(request, 'websites.manage'); requirePermission(request, 'ai.use');
      if (!env.CARE_REVIEW_ENABLED) throw new ApiError(503, 'REVIEW_DISABLED', 'Source review is disabled.');
      const revision = await database.careRevision.findFirst({ where: { jobId: job.id, tenantId: job.tenantId, version: job.planVersion } });
      const plan = revision?.plan as { policy?: string } | undefined;
      if (job.kind !== 'REVIEW' || !revision?.approvedBy || !revision.approvalExpiresAt || revision.approvalExpiresAt <= new Date() || !['APPROVED','COMPLETED'].includes(revision.state) || ['CANCELLED','FAILED','WAITING_FOR_INPUT'].includes(job.state) || plan?.policy !== REVIEW_POLICY_VERSION) throw new ApiError(403, 'TOOL_DENIED', 'A current approved source-review plan is required.');
      await database.$transaction((tx) => assertRepairActor(tx, { ...job, userId: request.userId! }));
      const source = await database.careArtifact.findFirstOrThrow({ where: { id: revision.sourceId, tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, environment: job.environment, kind: 'SOURCE_BUNDLE' } });
      if (source.digest !== revision.sourceDigest) throw new ApiError(409, 'APPROVAL_STALE', 'The source digest changed.');
      const snapshot = prepareReviewSnapshot(JSON.parse(readArtifact(source, env).toString('utf8')).files);
      const completed = await database.careAgentRun.findMany({ where: { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, state: 'COMPLETED' }, select: { roleId: true }, take: 24 });
      output = executeReviewTool(toolId as typeof implementedReviewTools[number], request.body, { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, environment: job.environment, authorized: true, approvalExpiresAt: revision.approvalExpiresAt, sourceDigest: source.digest, snapshot, summary: job.summary, expectedBehavior: job.expectedBehavior ?? '', state: job.state, completedRoles: completed.map((r) => r.roleId), ...(toolId === 'T53' ? { recovery: await recoveryReadiness(job.tenantId, job.websiteId, job.environment) } : {}) });
    } else {
      const definition = toolCatalogue.find((tool) => tool.id === toolId);
      throw new ApiError(409, 'TOOL_UNAVAILABLE', definition?.unavailableReason ?? 'This tool uses its dedicated approval workflow; it cannot be called through the read-only dispatcher.');
    }
    if (Buffer.byteLength(JSON.stringify(output)) > (toolId === 'T10' ? 250000 : 65536)) throw new ApiError(413, 'TOOL_OUTPUT_LIMIT', 'The result exceeds this tool output limit. Open individual saved reports.');
    return { toolId, jobId: job.id, observedAt: new Date().toISOString(), output };
  });
}
