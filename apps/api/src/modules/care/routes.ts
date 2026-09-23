import type { FastifyInstance } from 'fastify';
import { recoveryReadiness } from './recovery-readiness.js';
import { database } from '@zerochack/database';
import { z } from 'zod';
import type { Environment } from '@zerochack/config';
import { agentCatalogue, toolCatalogue, environments, assertDisclosure, CareError, openSecret, visibleAgentState, looksSensitive } from '@zerochack/care';
import { authenticate, requirePermission, requireOwnerMfa } from '../auth/security.js';
import { ApiError } from '../../errors.js';
import type { AiService } from '../ai/service.js';
import { reviewRoutes } from './review-routes.js';
import { stopReview } from './review-service.js';
import { repairRoutes } from './repair-routes.js';
import { invalidateRepair } from './repair-service.js';
import { careEvent, careWebsite, credentialMetadata, vaultKey } from './service.js';

const uuid = z.string().uuid();
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Check the required fields.');
  return result.data;
}
const websiteParams = z.object({ websiteId: uuid });
const activeTicket = { notIn: ['RESOLVED', 'CLOSED', 'CANCELLED', 'QUEUED'] as ['RESOLVED', 'CLOSED', 'CANCELLED', 'QUEUED'] };
const safeGrant = { id: true, tenantId: true, websiteId: true, credentialId: true, credentialVersion: true, specialistId: true, ticketId: true, reason: true, status: true, expiresAt: true, createdAt: true, credential: { select: credentialMetadata } } as const;

export async function careRoutes(app: FastifyInstance, options: { environment: Environment; ai: AiService }) {
  app.setErrorHandler((error, _request, reply) => { if (error instanceof CareError) return reply.code(400).send({ error: { code: error.code, message: error.message } }); throw error; });
  app.addHook('onSend', async (_request, reply, payload) => { reply.header('cache-control', 'private, no-store'); return payload; });
  app.addHook('preHandler', async (request) => {
    await authenticate(request, options.environment);
    if (!options.environment.CARE_ENABLED) throw new ApiError(503, 'CAPABILITY_DISABLED', 'The new care workspace is not enabled.');
  });
  app.get('/websites/:websiteId/care', async (request) => {
    requirePermission(request, 'chat.read');
    const { websiteId } = parse(websiteParams, request.params); await careWebsite(request, websiteId);
    const tenantId = request.tenantId!;
    const { environment, before } = parse(z.object({ environment: z.enum(environments).optional(), before: uuid.optional() }), request.query);
    const scope = { tenantId, websiteId, ...(environment ? { environment } : {}) };
    const anchor = before ? await database.careJob.findFirst({ where: { ...scope, id: before }, select: { id: true, createdAt: true } }) : null;
    if (before && !anchor) throw new ApiError(404, 'HISTORY_CURSOR_INVALID', 'The history cursor is outside this workspace.');
    const [credentials, accessRequests, jobs] = await Promise.all([
      database.careCredential.findMany({ where: { tenantId, websiteId, status: 'STORED' }, select: credentialMetadata }),
      database.careAccessRequest.findMany({ where: { tenantId, websiteId }, select: safeGrant, orderBy: { createdAt: 'desc' }, take: 30 }),
      database.careJob.findMany({ where: scope, ...(anchor ? { cursor: { id: anchor.id }, skip: 1 } : {}), include: { agents: true }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 31 })
    ]);
    const staff = await database.user.findMany({ where: { id: { in: accessRequests.map((grant) => grant.specialistId) } }, select: { id: true, displayName: true } });
    return { nextCursor: jobs.length > 30 ? jobs[29]!.id : null, historyPolicy: 'PRESERVED', credentials, accessRequests: accessRequests.map((grant) => ({ ...grant, specialistName: staff.find((person) => person.id === grant.specialistId)?.displayName ?? 'Assigned specialist', status: ['PENDING','APPROVED'].includes(grant.status) && grant.expiresAt <= new Date() ? 'EXPIRED' : grant.status })), jobs: jobs.slice(0, 30).map((job) => ({ ...job, state: visibleAgentState(job.state, job.heartbeatAt), agents: job.agents.map((agent) => ({ ...agent, state: visibleAgentState(agent.state, agent.heartbeatAt), name: agentCatalogue.find((role) => role.id === agent.roleId)?.name ?? 'AI assistant' })) })), capabilities: { secureCapture: true, specialistDisclosure: true, trackedChat: true, sourceReview: options.environment.CARE_REVIEW_ENABLED, maximumReviewBudgetMicros: options.environment.CARE_REVIEW_BUDGET_MICROS, isolatedRepair: options.environment.CARE_REPAIR_ENABLED, deployment: options.environment.CARE_RELEASE_ENABLED, attachments: options.environment.CARE_REPAIR_ENABLED }, roles: agentCatalogue.map(({ id, name, enabled, implementation }) => ({ id, name, enabled, implementation })) };
  });

  app.get('/websites/:websiteId/care/recovery', async (request) => {
    requirePermission(request, 'chat.read');
    const { websiteId } = parse(websiteParams, request.params); await careWebsite(request, websiteId);
    const { environment } = parse(z.object({ environment: z.enum(environments).default('PRODUCTION') }), request.query);
    return recoveryReadiness(request.tenantId!, websiteId, environment);
  });

  app.delete('/websites/:websiteId/credentials/:credentialId', async (request, reply) => {
    requirePermission(request, 'websites.manage');
    const { websiteId, credentialId } = parse(z.object({ websiteId: uuid, credentialId: uuid }), request.params);
    await careWebsite(request, websiteId); const tenantId = request.tenantId!;
    await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM care_credentials WHERE id = ${credentialId}::uuid FOR UPDATE`;
      const record = await tx.careCredential.findFirst({ where: { id: credentialId, tenantId, websiteId } });
      if (!record) throw new ApiError(404, 'NOT_FOUND', 'Credential was not found.');
      await tx.careCredential.update({ where: { id: record.id }, data: { status: 'REVOKED', encryptedEnvelope: '' } });
      await tx.careAccessRequest.updateMany({ where: { credentialId }, data: { status: 'REVOKED', decidedAt: new Date(), decidedBy: request.userId! } });
      await tx.websiteAccessCredential.deleteMany({ where: { tenantId, websiteId, vaultCredentialId: credentialId } });
      await careEvent(tx, { tenantId, websiteId, environment: record.environment }, 'credential.revoked', 'REVOKED', 'Future access is revoked. Rotate any copies already disclosed to a specialist.');
      await tx.auditLog.create({ data: { tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.credential_revoked', resourceType: 'credential', resourceId: credentialId } });
    });
    return reply.code(204).send();
  });

  app.get('/specialist/care/access', async (request) => {
    requirePermission(request, 'specialist.jobs.read');
    if (!request.roleNames?.includes('Cybersecurity Specialist')) throw new ApiError(403, 'SPECIALIST_REQUIRED', 'Specialist role required.');
    const tickets = await database.ticket.findMany({ where: { assignedSpecialistId: request.userId!, status: activeTicket }, select: { id: true, title: true, tenantId: true, websiteId: true, website: { select: { name: true } } }, take: 100 });
    const credentials = await database.careCredential.findMany({ where: { OR: tickets.map((ticket) => ({ tenantId: ticket.tenantId, websiteId: ticket.websiteId })), status: 'STORED', authorizationExpiresAt: { gt: new Date() } }, select: { ...credentialMetadata, tenantId: true, websiteId: true } });
    const grants = await database.careAccessRequest.findMany({ where: { specialistId: request.userId!, ticketId: { in: tickets.map((ticket) => ticket.id) } }, select: safeGrant, orderBy: { createdAt: 'desc' }, take: 100 });
    return { tickets, credentials, grants };
  });

  app.post('/specialist/access-requests', async (request, reply) => {
    requirePermission(request, 'specialist.jobs.read');
    if (!request.roleNames?.includes('Cybersecurity Specialist')) throw new ApiError(403, 'SPECIALIST_REQUIRED', 'Specialist role required.');
    const input = parse(z.object({ ticketId: uuid, credentialId: uuid, reason: z.string().trim().min(10).max(1000), durationMinutes: z.number().int().min(5).max(60) }).strict(), request.body);
    if (looksSensitive(input.reason)) throw new ApiError(400, 'SENSITIVE_CONTENT_BLOCKED', 'Do not put credentials in the reason.');
    const grant = await database.$transaction(async (tx) => {
      const ticket = await tx.ticket.findFirst({ where: { id: input.ticketId, assignedSpecialistId: request.userId!, status: activeTicket } });
      if (!ticket) throw new ApiError(404, 'NOT_FOUND', 'Assigned ticket was not found.');
      const credential = await tx.careCredential.findFirst({ where: { id: input.credentialId, tenantId: ticket.tenantId, websiteId: ticket.websiteId, status: 'STORED', authorizationExpiresAt: { gt: new Date() } } });
      if (!credential) throw new ApiError(404, 'NOT_FOUND', 'Credential was not found.');
      const grant = await tx.careAccessRequest.create({ data: { tenantId: ticket.tenantId, websiteId: ticket.websiteId, ticketId: ticket.id, credentialId: credential.id, credentialVersion: credential.version, specialistId: request.userId!, reason: input.reason, expiresAt: new Date(Math.min(credential.authorizationExpiresAt.getTime(), Date.now() + input.durationMinutes * 60000)) }, select: safeGrant });
      await careEvent(tx, credential, 'approval.required', 'PENDING', 'Your assigned human specialist requested access. Review the exact account, reason, and expiry.');
      await tx.auditLog.create({ data: { tenantId: ticket.tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.disclosure_requested', resourceType: 'credential_grant', resourceId: grant.id } });
      return grant;
    });
    return reply.code(201).send(grant);
  });

  app.post('/access-requests/:id/:decision', async (request) => {
    requirePermission(request, 'websites.manage');
    const { id, decision } = parse(z.object({ id: uuid, decision: z.enum(['approve','deny','revoke']) }), request.params);
    return database.$transaction(async (tx) => {
      const grant = await tx.careAccessRequest.findFirst({ where: { id, tenantId: request.tenantId! } });
      if (!grant) throw new ApiError(404, 'NOT_FOUND', 'Access request was not found.');
      await careWebsite(request, grant.websiteId, tx);
      await tx.$queryRaw`SELECT id FROM care_credentials WHERE id = ${grant.credentialId}::uuid FOR UPDATE`;
      const credential = await tx.careCredential.findUniqueOrThrow({ where: { id: grant.credentialId } });
      const ticket = await tx.ticket.findFirst({ where: { id: grant.ticketId, tenantId: grant.tenantId, websiteId: grant.websiteId, assignedSpecialistId: grant.specialistId, status: activeTicket } });
      if (decision === 'approve' && (!ticket || grant.expiresAt <= new Date() || credential.authorizationExpiresAt <= new Date() || credential.status !== 'STORED' || credential.version !== grant.credentialVersion)) throw new ApiError(409, 'APPROVAL_STALE', 'Assignment, credential, or expiry changed. Request new access.');
      const state = decision === 'approve' ? 'APPROVED' : decision === 'deny' ? 'DENIED' : 'REVOKED';
      const changed = await tx.careAccessRequest.updateMany({ where: { id, tenantId: request.tenantId!, status: decision === 'revoke' ? { in: ['PENDING','APPROVED'] } : 'PENDING' }, data: { status: state, decidedAt: new Date(), decidedBy: request.userId! } });
      if (!changed.count) throw new ApiError(409, 'APPROVAL_STALE', 'This request has already been decided.');
      await careEvent(tx, credential, 'approval.resolved', state, `Specialist access ${state.toLowerCase()}.`);
      await tx.auditLog.create({ data: { tenantId: grant.tenantId, actorUserId: request.userId!, requestId: request.id, action: `care.disclosure_${state.toLowerCase()}`, resourceType: 'credential_grant', resourceId: id } });
      return { id, status: state };
    });
  });

  app.post('/specialist/credential-grants/:id/reveal', async (request, reply) => {
    requirePermission(request, 'specialist.jobs.read');
    if (!request.roleNames?.includes('Cybersecurity Specialist')) throw new ApiError(403, 'SPECIALIST_REQUIRED', 'Specialist role required.');
    const { id } = parse(z.object({ id: uuid }), request.params);
    const value = await database.$transaction(async (tx) => {
      const grant = await tx.careAccessRequest.findFirst({ where: { id, specialistId: request.userId! } });
      if (!grant) throw new ApiError(404, 'NOT_FOUND', 'Grant was not found.');
      await tx.$queryRaw`SELECT id FROM care_credentials WHERE id = ${grant.credentialId}::uuid FOR UPDATE`;
      const current = await tx.careAccessRequest.findUniqueOrThrow({ where: { id } });
      const credential = await tx.careCredential.findFirstOrThrow({ where: { id: current.credentialId, tenantId: current.tenantId, websiteId: current.websiteId } });
      const ticket = await tx.ticket.findFirst({ where: { id: current.ticketId, tenantId: current.tenantId, websiteId: current.websiteId, status: activeTicket } });
      const site = await tx.website.findFirst({ where: { id: current.websiteId, tenantId: current.tenantId, lifecycle: 'ACTIVE' } });
      try { assertDisclosure({ specialistId: current.specialistId, actorId: request.userId!, assignedSpecialistId: ticket?.assignedSpecialistId ?? null, assignmentActive: Boolean(ticket && site), status: current.status, expiresAt: current.expiresAt, ...(request.mfaVerifiedAt ? { mfaVerifiedAt: request.mfaVerifiedAt } : {}), credentialVersion: credential.version, approvedVersion: current.credentialVersion, credentialActive: credential.status === 'STORED' && credential.authorizationExpiresAt > new Date() }); }
      catch (error) { if (error instanceof CareError) throw new ApiError(403, error.code, error.message); throw error; }
      const user = await tx.user.findUnique({ where: { id: request.userId! }, select: { mfaEnabledAt: true } });
      if (!user?.mfaEnabledAt) throw new ApiError(403, 'MFA_REQUIRED', 'Enable authenticator MFA and verify it before revealing access.');
      const secret = openSecret(credential.encryptedEnvelope, credential, { v1: vaultKey(options.environment) });
      await tx.auditLog.create({ data: { tenantId: current.tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.credential_disclosed', resourceType: 'credential_grant', resourceId: id, metadata: { credentialId: credential.id, version: credential.version, delivery: 'server_response' } } });
      return secret;
    });
    return reply.header('cache-control', 'private, no-store, max-age=0').header('pragma', 'no-cache').header('x-content-type-options', 'nosniff').send({ secret: value, clearAfterSeconds: 30 });
  });

  app.post('/websites/:websiteId/jobs', async (request, reply) => {
    requirePermission(request, 'tickets.create');
    const { websiteId } = parse(websiteParams, request.params); await careWebsite(request, websiteId);
    const input = parse(z.object({ requestKey: uuid, summary: z.string().trim().min(10).max(1000), expectedBehavior: z.string().trim().min(10).max(4000), environment: z.enum(environments).default('STAGING') }).strict(), request.body);
    if (looksSensitive(input.summary + '\n' + input.expectedBehavior)) throw new ApiError(400, 'SENSITIVE_CONTENT_BLOCKED', 'Use secure capture for access details.');
    const tenantId = request.tenantId!;
    const result = await database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${websiteId}::uuid FOR UPDATE`;
      const existing = await tx.careJob.findUnique({ where: { tenantId_websiteId_requestKey: { tenantId, websiteId, requestKey: input.requestKey } } });
      if (existing) return { job: existing, created: false };
      const job = await tx.careJob.create({ data: { tenantId, websiteId, userId: request.userId!, ...input, kind: 'REPAIR', state: 'WAITING_FOR_INPUT', errorCode: options.environment.CARE_REPAIR_ENABLED ? 'SOURCE_REQUIRED' : 'ISOLATED_WORKER_NOT_CONFIGURED' } });
      await careEvent(tx, job, 'job.created', job.state, 'Issue recorded. A configured isolated repair worker and scoped plan are required before work can begin.', { jobId: job.id });
      return { job, created: true };
    });
    return reply.code(result.created ? 201 : 200).send(result.job);
  });
  app.post('/jobs/:id/:action', async (request) => {
    requirePermission(request, 'chat.write');
    const { id, action } = parse(z.object({ id: uuid, action: z.enum(['pause','cancel','feedback']) }), request.params);
    const job = await database.careJob.findFirst({ where: { id, tenantId: request.tenantId! } });
    if (!job) throw new ApiError(404, 'NOT_FOUND', 'Job was not found.'); await careWebsite(request, job.websiteId);
    if (job.userId !== request.userId && !request.permissions?.includes('websites.manage')) throw new ApiError(403, 'FORBIDDEN', 'This task belongs to another user.');
    if (action === 'feedback') {
      if (job.kind !== 'REPAIR') throw new ApiError(409, 'INVALID_JOB_KIND', 'Add a new message to continue this conversation.');
      const input = parse(z.object({ content: z.string().trim().min(1).max(4000) }), request.body);
      if (looksSensitive(input.content)) throw new ApiError(400, 'SENSITIVE_CONTENT_BLOCKED', 'Use secure capture for access details.');
      await database.$transaction(async (tx) => {
        await invalidateRepair(tx, job);
        const current = await tx.careJob.findUniqueOrThrow({ where: { id } });
        const expectedBehavior = [current.expectedBehavior, `Customer correction: ${input.content}`].filter(Boolean).join('\n');
        if (expectedBehavior.length > 4000) throw new ApiError(400, 'SCOPE_LIMIT', 'The combined requirements exceed 4000 characters. Create a new issue with a consolidated scope.');
        await tx.chatMessage.create({ data: { tenantId: job.tenantId, websiteId: job.websiteId, environment: job.environment, authorUserId: request.userId!, type: 'CUSTOMER', content: input.content } });
        await tx.careJob.update({ where: { id }, data: { state: 'WAITING_FOR_INPUT', expectedBehavior, planVersion: { increment: 1 }, leaseVersion: { increment: 1 }, approvedVersion: null, approvedBy: null, approvalExpiresAt: null } });
        await careEvent(tx, job, 'feedback.received', 'WAITING_FOR_INPUT', 'Customer feedback recorded. The scope needs review before further work.', { jobId: id });
      }); return { recorded: true };
    }
    const state = action === 'cancel' ? 'CANCELLED' : 'WAITING_FOR_INPUT';
    await database.$transaction(async (tx) => {
      await invalidateRepair(tx, job);
      await stopReview(tx, job);
      const changed = await tx.careJob.updateMany({ where: { id, state: { notIn: ['COMPLETED','FAILED','CANCELLED'] } }, data: { state, leaseVersion: { increment: 1 }, ...(job.kind === 'REPAIR' ? { planVersion: { increment: 1 }, approvedVersion: null, approvedBy: null, approvalExpiresAt: null } : {}) } });
      if (!changed.count) throw new ApiError(409, 'JOB_TERMINAL', 'This task has already finished.');
      await tx.careAgentRun.updateMany({ where: { jobId: id, state: { in: ['RUNNING','QUEUED','VERIFYING','WAITING_FOR_DEPENDENCY'] } }, data: { state, completedAt: action === 'cancel' ? new Date() : null } });
      await careEvent(tx, job, `job.${action === 'cancel' ? 'cancelled' : 'paused'}`, state, 'Future steps stopped. Any observation already in progress may finish; this does not undo changes.', { jobId: id });
    }); return { state };
  });

  app.get('/websites/:websiteId/activity/stream', async (request, reply) => {
    requirePermission(request, 'chat.read');
    const { websiteId } = parse(websiteParams, request.params); await careWebsite(request, websiteId);
    const { environment } = parse(z.object({ environment: z.enum(environments).default('PRODUCTION') }), request.query);
    const rawCursor = request.headers['last-event-id'] ?? '0';
    let cursor = parse(z.coerce.number().int().min(0).max(2147483647), rawCursor);
    const tenantId = request.tenantId!;
    reply.hijack(); reply.raw.writeHead(200, { ...(reply.getHeaders() as Record<string, string | number | string[]>), 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    let closed = false; let busy = false;
    const poll = async () => {
      if (closed || busy) return; busy = true;
      try {
        await authenticate(request, options.environment); requirePermission(request, 'chat.read');
        if (request.tenantId !== tenantId) throw new Error('context'); await careWebsite(request, websiteId);
        const records = await database.careEvent.findMany({ where: { tenantId, websiteId, environment, sequence: { gt: cursor } }, orderBy: { sequence: 'asc' }, take: 100 });
        for (const event of records) { if (closed) break; cursor = event.sequence; reply.raw.write(`id: ${cursor}\nevent: activity\ndata: ${JSON.stringify(event)}\n\n`); }
        if (!records.length) reply.raw.write(': heartbeat\n\n');
      } catch { closed = true; clearInterval(timer); reply.raw.end(); } finally { busy = false; }
    };
    const timer = setInterval(() => void poll(), 2500); void poll();
    request.raw.on('close', () => { closed = true; clearInterval(timer); });
  });
  await app.register(repairRoutes, options);
  await app.register(reviewRoutes, options);
  app.get('/owner/care/capabilities', async (request) => {
    requireOwnerMfa(request);
    return { roles: agentCatalogue, tools: toolCatalogue, vault: 'CONFIGURED', sourceReview: options.environment.CARE_REVIEW_ENABLED ? 'APPROVED_TEXT_SOURCE' : 'DISABLED', isolatedRepair: options.environment.CARE_REPAIR_ENABLED ? 'STATIC_HTML' : 'DISABLED', deployment: options.environment.CARE_RELEASE_ENABLED ? 'SINGLE_FILE_SFTP' : 'DISABLED', limitations: ['All 24 roles support source review; this does not implement the wider autonomous repair roadmap.', 'Thirteen offline source checks and one scoped recovery-metadata tool are implemented; 52 wider contracts stay disabled.', 'Live provider smoke testing is required.', 'No model tool can disclose credentials or approve a release.'] };
  });
}
