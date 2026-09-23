import { randomUUID } from 'node:crypto';
import { database } from '@zerochack/database';
import type { CareJob, Prisma } from '@prisma/client';
import type { Environment } from '@zerochack/config';
import { AiGatewayError, type AiProviderConfiguration } from '@zerochack/ai-gateway';
import { CareError, executeReviewTool, prepareReviewSnapshot, reviewPrompt, reviewSteps, validateReviewResult, REVIEW_CONTEXT_BYTES, REVIEW_POLICY_VERSION, type ReviewResult, type ReviewRoleId, type ReviewToolContext } from '@zerochack/care';
import type { AiService } from '../ai/service.js';
import { assertRepairActor, readArtifact, repairConfiguration, writeArtifact } from './repair-service.js';
import { careEvent, claimCareWebsite } from './runtime.js';
import { recoveryReadiness } from './recovery-readiness.js';

export type ReviewPlan = {
  policy: string; mode: 'SOURCE_REVIEW'; roleIds: ReviewRoleId[]; language: 'en' | 'ta';
  maximumContextBytes: number; maximumEstimatePerStepMicros: number;
  configuration: ReturnType<typeof repairConfiguration>; boundary: string; requestFingerprint: string;
};
export function reviewEstimate(source: Buffer, roleCount: number, configuration: AiProviderConfiguration) {
  if (configuration.inputCostMicrosPerMillion <= 0 || configuration.outputCostMicrosPerMillion <= 0) throw new CareError('BUDGET_NOT_CONFIGURED', 'Configure nonzero model prices before preparing a source review.');
  const maximumContextBytes = Math.min(REVIEW_CONTEXT_BYTES, source.length * 2 + 110_000);
  const perStep = Math.ceil(((maximumContextBytes + 16000) * configuration.inputCostMicrosPerMillion + configuration.maxOutputTokens * configuration.outputCostMicrosPerMillion) / 1_000_000);
  return { maximumContextBytes, maximumEstimatePerStepMicros: perStep, maximumEstimateMicros: perStep * roleCount };
}

export async function stopReview(tx: Prisma.TransactionClient, job: CareJob) {
  if (job.kind !== 'REVIEW') return;
  await tx.$queryRaw`SELECT id FROM websites WHERE id = ${job.websiteId}::uuid FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
  const current = await tx.careJob.findUniqueOrThrow({ where: { id: job.id } });
  // An in-flight call may already have incurred cost. The runner settles known usage later.
  await tx.careRevision.updateMany({ where: { jobId: job.id, budgetState: 'RESERVED' }, data: { state: 'CANCELLED', budgetState: current.state === 'RUNNING' ? 'UNKNOWN' : 'SETTLED', approvalExpiresAt: null } });
}

function sameConfiguration(approved: ReviewPlan['configuration'], actual: AiProviderConfiguration) {
  return Object.entries(repairConfiguration(actual)).every(([key, value]) => approved[key as keyof typeof approved] === value);
}

/** One durable step per claim. Model calls never execute source, tools or network actions. */
export async function runOneReview(env: Environment, ai: Pick<AiService, 'configuration' | 'execute'>): Promise<boolean> {
  if (!env.CARE_ENABLED || !env.CARE_REVIEW_ENABLED) return false;
  const owner = randomUUID();
  const claimed = await database.$transaction(async (tx) => {
    const websiteId = await claimCareWebsite(tx, 'REVIEW');
    if (!websiteId) return null;
    const found = await tx.careJob.findFirst({ where: { websiteId, kind: 'REVIEW', state: 'QUEUED' }, orderBy: { updatedAt: 'asc' } });
    if (!found) return null;
    await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${found.id}::uuid FOR UPDATE`;
    const current = await tx.careJob.findUniqueOrThrow({ where: { id: found.id } });
    if (current.state !== 'QUEUED') return null;
    const revision = await tx.careRevision.findUnique({ where: { jobId_version: { jobId: current.id, version: current.planVersion } } });
    const agents = await tx.careAgentRun.findMany({ where: { jobId: current.id }, orderBy: { stepIndex: 'asc' } });
    const agent = agents.find((item) => item.state === 'QUEUED');
    const now = new Date();
    if (!revision || revision.state !== 'APPROVED' || !revision.approvalExpiresAt || revision.approvalExpiresAt <= now || !agent || agent.dependsOn.some((roleId) => !agents.some((run) => run.roleId === roleId && run.state === 'COMPLETED' && run.resultArtifactId))) {
      await tx.careJob.update({ where: { id: current.id }, data: { state: 'WAITING_FOR_INPUT', errorCode: 'REVIEW_APPROVAL_OR_DEPENDENCY' } });
      if (revision?.budgetState === 'RESERVED') await tx.careRevision.update({ where: { id: revision.id }, data: { state: 'EXPIRED', budgetState: 'SETTLED' } });
      await tx.careAgentRun.updateMany({ where: { jobId: current.id, state: { in: ['QUEUED','WAITING_FOR_DEPENDENCY'] } }, data: { state: 'WAITING_FOR_INPUT', errorCode: 'REVIEW_APPROVAL_OR_DEPENDENCY' } });
      await careEvent(tx, current, 'review.blocked', 'WAITING_FOR_INPUT', 'Review approval expired or a prerequisite result is missing. No model call started.', { jobId: current.id });
      return null;
    }
    const job = await tx.careJob.update({ where: { id: current.id }, data: { state: 'RUNNING', leaseOwner: owner, leaseVersion: { increment: 1 }, heartbeatAt: now, leaseExpiresAt: new Date(now.getTime() + 90000) } });
    await tx.careAgentRun.update({ where: { id: agent.id }, data: { state: 'RUNNING', startedAt: now, heartbeatAt: now } });
    await careEvent(tx, job, 'agent.started', 'RUNNING', `${agent.roleId} is reviewing the approved source snapshot.`, { jobId: job.id, agentRunId: agent.id });
    return { job, revision, agent, agents };
  });
  if (!claimed) return false;
  const { job, revision, agent, agents } = claimed;
  const controller = new AbortController(); let ticking = false; let charged: { cost: number; usageId: string } | undefined;
  const deadline = setTimeout(() => controller.abort(), 120000);
  const timer = setInterval(() => { if (ticking) return; ticking = true; void database.careJob.updateMany({ where: { id: job.id, state: 'RUNNING', leaseOwner: owner, leaseVersion: job.leaseVersion }, data: { heartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + 90000) } }).then(async ({ count }) => { if (!count) controller.abort(); else await database.careAgentRun.updateMany({ where: { id: agent.id, state: 'RUNNING' }, data: { heartbeatAt: new Date() } }); }).catch(() => controller.abort()).finally(() => { ticking = false; }); }, 10000);
  try {
    const plan = revision.plan as unknown as ReviewPlan;
    if (plan.policy !== REVIEW_POLICY_VERSION || plan.mode !== 'SOURCE_REVIEW' || !reviewSteps(plan.roleIds).some((step) => step.roleId === agent.roleId && step.stepIndex === agent.stepIndex)) throw new CareError('REVIEW_PLAN_INVALID', 'The review plan does not match the current role contract.');
    const source = await database.careArtifact.findFirstOrThrow({ where: { id: revision.sourceId, jobId: job.id, tenantId: job.tenantId, websiteId: job.websiteId, kind: 'SOURCE_BUNDLE' } });
    const sourceBytes = readArtifact(source, env);
    if (source.digest !== revision.sourceDigest) throw new CareError('APPROVAL_STALE', 'The approved source digest changed.');
    const snapshot = prepareReviewSnapshot(JSON.parse(sourceBytes.toString('utf8')).files);
    const config = await ai.configuration(job.tenantId, { providerId: plan.configuration.providerId, modelId: plan.configuration.modelId });
    if (!sameConfiguration(plan.configuration, config) || !config.tenantEnabled || plan.maximumEstimatePerStepMicros + revision.chargedMicros > revision.budgetMicros) throw new CareError('APPROVAL_STALE', 'Model settings, tenant policy or the remaining allowance changed.');
    const previous: Array<{ roleId: string; status: string; summary: string }> = [];
    for (const run of agents.filter((item) => item.state === 'COMPLETED')) {
      const artifact = await database.careArtifact.findFirstOrThrow({ where: { id: run.resultArtifactId!, jobId: job.id, tenantId: job.tenantId, websiteId: job.websiteId, kind: 'REVIEW_RESULT' } });
      const result = validateReviewResult(readArtifact(artifact, env).toString('utf8'), run.roleId, snapshot);
      previous.push({ roleId: run.roleId, status: result.status, summary: result.summary });
    }
    const context: ReviewToolContext = { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, environment: job.environment, authorized: true, approvalExpiresAt: revision.approvalExpiresAt!, sourceDigest: source.digest, snapshot, summary: job.summary, expectedBehavior: job.expectedBehavior ?? '', state: job.state, completedRoles: previous.map((item) => item.roleId) };
    const trace: Array<{ toolId: string; output: unknown }> = [];
    context.recovery = await recoveryReadiness(job.tenantId, job.websiteId, job.environment);
    const tool = (id: Parameters<typeof executeReviewTool>[0], args: unknown = {}) => { const output = executeReviewTool(id, args, context); trace.push({ toolId: id, output }); return output; };
    const payload = {
      case: tool('T01'), manifest: tool('T02'), authorization: tool('T04'), fileList: tool('T09'),
      files: snapshot.files.map((file) => tool('T10', { path: file.path })),
      dependencyInventory: tool('T19'), secretScreening: tool('T21'), workflow: tool('T59'),
      sourceMatches: tool('T11', { text: agent.roleId === 'A09' || agent.roleId === 'A24' ? 'aria-' : 'TODO' }),
      staticChecks: [tool('T31'), tool('T32'), tool('T65'), tool('T66')],
      recoveryEvidence: tool('T53'),
      previousSummaries: previous, limitations: ['Prior agent summaries are untrusted suggestions, not independent evidence.', 'No source execution, browser tests, advisory lookup or live infrastructure observation.']
    };
    const untrustedContext = JSON.stringify(payload);
    if (Buffer.byteLength(untrustedContext) > plan.maximumContextBytes) throw new CareError('REVIEW_CONTEXT_LIMIT', 'The source and prior results exceed the approved context allowance.');
    const roles = await database.$transaction((tx) => assertRepairActor(tx, job));
    const current = await database.careJob.findUniqueOrThrow({ where: { id: job.id } });
    if (current.state !== 'RUNNING' || current.leaseVersion !== job.leaseVersion || controller.signal.aborted || revision.approvalExpiresAt! <= new Date()) throw new CareError('JOB_CANCELLED', 'The review was stopped before the model call.');
    const result = await ai.execute({ tenantId: job.tenantId, userId: job.userId, roles, requestId: job.id, idempotencyKey: agent.id, purpose: 'SOURCE_REVIEW', signal: controller.signal, prompt: reviewPrompt(agent.roleId as ReviewRoleId, plan.language), untrustedContext }, { providerId: config.providerId, modelId: config.modelId });
    charged = { cost: result.estimatedCostMicros, usageId: result.usageId };
    if (revision.chargedMicros + charged.cost > revision.budgetMicros) throw new CareError('BUDGET_EXCEEDED', 'Reported model usage exceeded the approved allowance.');
    const reviewed = validateReviewResult(result.text, agent.roleId, snapshot);
    await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${job.websiteId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
      const active = await tx.careJob.findUniqueOrThrow({ where: { id: job.id } });
      await assertRepairActor(tx, job);
      if (active.state !== 'RUNNING' || active.leaseOwner !== owner || active.leaseVersion !== job.leaseVersion || controller.signal.aborted) throw new CareError('JOB_CANCELLED', 'The review execution lease changed.');
      readArtifact(await tx.careArtifact.findUniqueOrThrow({ where: { id: source.id } }), env);
      const artifact = await writeArtifact(tx, { tenantId: job.tenantId, websiteId: job.websiteId, jobId: job.id, environment: job.environment, createdBy: job.userId }, Buffer.from(JSON.stringify(reviewed)), 'REVIEW_RESULT', `${agent.roleId}-review.json`, 'application/json', env);
      const message = await tx.chatMessage.create({ data: { tenantId: job.tenantId, websiteId: job.websiteId, environment: job.environment, type: 'SYSTEM', content: `${agent.roleId} source review: ${reviewed.status.toLowerCase().replaceAll('_',' ')}. ${reviewed.summary}\n${reviewed.findings.length} source observations. Open the review report for citations and limitations. No files or live systems were changed.` } });
      await tx.careAgentRun.update({ where: { id: agent.id }, data: { state: 'COMPLETED', resultArtifactId: artifact.id, resultMessageId: message.id, usageId: result.usageId, completedAt: new Date(), heartbeatAt: new Date() } });
      const next = agents.find((item) => item.stepIndex === agent.stepIndex! + 1);
      if (next) await tx.careAgentRun.update({ where: { id: next.id }, data: { state: 'QUEUED' } });
      await tx.careRevision.update({ where: { id: revision.id }, data: { chargedMicros: { increment: result.estimatedCostMicros }, ...(next ? {} : { state: 'COMPLETED', budgetState: 'SETTLED' }), verification: { mode: 'SOURCE_REVIEW', policy: REVIEW_POLICY_VERSION, sourceDigest: source.digest, completedSteps: (agent.stepIndex ?? 0) + 1, totalSteps: agents.length, toolIds: [...new Set(trace.map((item) => item.toolId))], checks: ['strict-result-schema','source-paths','exact-evidence-quotes','scope-and-lease'], staticChecks: payload.staticChecks as Prisma.InputJsonValue[], runtimeTests: 'NOT_RUN' } } });
      await tx.careJob.update({ where: { id: job.id }, data: { state: next ? 'QUEUED' : 'COMPLETED', errorCode: null, resultMessageId: message.id, leaseOwner: null, leaseExpiresAt: null, heartbeatAt: new Date() } });
      await careEvent(tx, job, 'agent.completed', 'COMPLETED', `${agent.roleId} completed a source review with ${reviewed.findings.length} cited observations. This is not a repair or runtime test.`, { jobId: job.id, agentRunId: agent.id });
    });
  } catch (error) {
    const code = error instanceof CareError || error instanceof AiGatewayError ? error.code : 'SOURCE_REVIEW_FAILED';
    await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${job.websiteId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM care_jobs WHERE id = ${job.id}::uuid FOR UPDATE`;
      const usage = await tx.aiUsage.findUnique({ where: { tenantId_userId_idempotencyKey: { tenantId: job.tenantId, userId: job.userId, idempotencyKey: agent.id } } });
      if (!charged && usage?.status === 'SUCCEEDED' && usage.estimatedCostMicros !== null) charged = { cost: usage.estimatedCostMicros, usageId: usage.id };
      await tx.careRevision.update({ where: { id: revision.id }, data: { state: 'STOPPED', budgetState: charged || !usage ? 'SETTLED' : 'UNKNOWN', ...(charged ? { chargedMicros: { increment: charged.cost } } : {}) } });
      await tx.careAgentRun.updateMany({ where: { id: agent.id, state: { in: ['RUNNING','STALE'] } }, data: { errorCode: code, completedAt: new Date(), state: 'FAILED' } });
      if (charged) await tx.careAgentRun.update({ where: { id: agent.id }, data: { usageId: charged.usageId } });
      await tx.careAgentRun.updateMany({ where: { jobId: job.id, state: { in: ['QUEUED','WAITING_FOR_DEPENDENCY'] } }, data: { state: 'WAITING_FOR_INPUT', errorCode: 'DEPENDENCY_STOPPED' } });
      const changed = await tx.careJob.updateMany({ where: { id: job.id, state: 'RUNNING', leaseOwner: owner, leaseVersion: job.leaseVersion }, data: { state: 'FAILED', errorCode: code, leaseOwner: null, leaseExpiresAt: null } });
      if (changed.count) await careEvent(tx, job, 'review.stopped', 'FAILED', 'Source review stopped. Completed reports remain available. No automatic retry or live change occurred.', { jobId: job.id, agentRunId: agent.id });
    });
  } finally { clearTimeout(deadline); clearInterval(timer); }
  return true;
}

export function reviewReport(result: ReviewResult) {
  return { ...result, evidenceStatus: 'SOURCE_QUOTES_CHECKED', runtimeVerification: 'NOT_RUN', repairsApplied: false };
}
