import { careEvent, vaultKey } from './runtime.js';
export { careEvent, vaultKey } from './runtime.js';
import { randomUUID } from 'node:crypto';
import { database } from '@zerochack/database';
import type { Prisma } from '@prisma/client';
import type { FastifyRequest } from 'fastify';
import type { Environment } from '@zerochack/config';
import { decryptSecret } from '@zerochack/auth';
import { CareError, parseSecureCapture, sealSecret, openSecret, looksSensitive } from '@zerochack/care';
import { ApiError } from '../../errors.js';
import { requirePermission } from '../auth/security.js';

export const credentialMetadata = { id: true, kind: true, environment: true, host: true, port: true, username: true, version: true, status: true, createdAt: true, authorizationExpiresAt: true } as const;
export async function careWebsite(request: FastifyRequest, websiteId: string, tx?: Prisma.TransactionClient) {
  const site = await (tx ?? database).website.findFirst({ where: { id: websiteId, tenantId: request.tenantId!, lifecycle: 'ACTIVE' } });
  if (!site) throw new ApiError(404, 'WEBSITE_NOT_FOUND', 'Website was not found');
  return site;
}
export async function captureAccess(request: FastifyRequest, websiteId: string, input: { content: string; environment: string; authorizationConfirmed: boolean; idempotencyKey: string }, environment: Environment) {
  requirePermission(request, 'websites.manage');
  if (!environment.CARE_ENABLED) throw new ApiError(503, 'CAPABILITY_DISABLED', 'Conversational access is disabled.');
  await careWebsite(request, websiteId);
  if (!input.authorizationConfirmed) throw new ApiError(403, 'AUTHORIZATION_REQUIRED', 'Confirm your authority to store these accounts and use them for scoped read-only inspection.');
  let credentials;
  try { credentials = parseSecureCapture(input.content); } catch (error) { if (error instanceof CareError) throw new ApiError(400, error.code, error.message); throw error; }
  const tenantId = request.tenantId!; const scope = { tenantId, websiteId, environment: input.environment };
  if (credentials.filter((item) => item.kind === 'SSH').length > 1) throw new ApiError(400, 'SECRET_CAPTURE_AMBIGUOUS', 'Submit one SSH account for this website at a time.');
  return database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM websites WHERE id = ${websiteId}::uuid FOR UPDATE`;
    const receipt = await tx.careJob.findUnique({ where: { tenantId_websiteId_requestKey: { tenantId, websiteId, requestKey: input.idempotencyKey } } });
    if (receipt) {
      if (receipt.userId !== request.userId || receipt.kind !== 'CAPTURE' || receipt.environment !== input.environment) throw new ApiError(409, 'IDEMPOTENCY_CONFLICT', 'This request key belongs to another action.');
      return { duplicate: true, connectionStatus: 'NOT_CHECKED', message: receipt.resultMessageId ? await tx.chatMessage.findFirst({ where: { id: receipt.resultMessageId, tenantId, websiteId } }) : null };
    }
    const records = [];
    for (const item of credentials) {
      const id = randomUUID();
      // Replacing an account creates a new identity and revokes every old grant.
      const old = await tx.careCredential.findMany({ where: { ...scope, kind: item.kind, host: item.host.toLowerCase(), username: item.username, status: 'STORED' }, select: { id: true } });
      const oldIds = old.map((row) => row.id);
      await tx.careAccessRequest.updateMany({ where: { credentialId: { in: oldIds } }, data: { status: 'REVOKED' } });
      await tx.careCredential.updateMany({ where: { id: { in: oldIds } }, data: { status: 'REVOKED', encryptedEnvelope: '' } });
      const record = await tx.careCredential.create({ data: { id, ...scope, kind: item.kind, host: item.host.toLowerCase(), port: item.port, username: item.username, authMethod: item.authMethod, encryptedEnvelope: sealSecret(item.secret, { ...scope, id, version: 1 }, vaultKey(environment)), authorizedBy: request.userId!, authorizationExpiresAt: new Date(Date.now() + 24 * 3600000) }, select: credentialMetadata });
      records.push(record);
      if (item.kind === 'SSH' && input.environment === 'PRODUCTION') {
        const oldBridge = await tx.websiteAccessCredential.findUnique({ where: { websiteId } });
        if (oldBridge?.vaultCredentialId && !oldIds.includes(oldBridge.vaultCredentialId)) {
          await tx.careCredential.updateMany({ where: { id: oldBridge.vaultCredentialId, tenantId, websiteId }, data: { status: 'REVOKED', encryptedEnvelope: '' } });
          await tx.careAccessRequest.updateMany({ where: { credentialId: oldBridge.vaultCredentialId }, data: { status: 'REVOKED' } });
        }
        const data = { host: record.host, port: record.port, username: item.username, authMethod: item.authMethod, encryptedSecret: '', vaultCredentialId: id, hostKeyFingerprint: item.hostKeyFingerprint ? (item.hostKeyFingerprint.endsWith('=') ? item.hostKeyFingerprint : item.hostKeyFingerprint + '=') : null, status: 'CONFIGURED', lastCheckedAt: null, lastErrorCode: null };
        await tx.websiteAccessCredential.upsert({ where: { websiteId }, create: { tenantId, websiteId, ...data }, update: data });
      }
    }
    const message = await tx.chatMessage.create({ data: { tenantId, websiteId, environment: input.environment, type: 'SYSTEM', content: `${records.length} account(s) stored securely for ${input.environment.toLowerCase()}. Connection has not been checked. Read-only permission expires in 24 hours. No credential values were added to this conversation.` } });
    await tx.careJob.create({ data: { ...scope, userId: request.userId!, requestKey: input.idempotencyKey, kind: 'CAPTURE', state: 'COMPLETED', summary: 'Secure access received', resultMessageId: message.id } });
    await careEvent(tx, scope, 'credential.stored', 'STORED', 'Access stored securely. Connection not yet checked.');
    await tx.auditLog.create({ data: { tenantId, actorUserId: request.userId!, requestId: request.id, action: 'care.credentials_stored', resourceType: 'website', resourceId: websiteId, metadata: { count: records.length, environment: input.environment } } });
    return { credentials: records, message, connectionStatus: 'NOT_CHECKED' };
  });
}
export async function brokerSecret(access: { tenantId: string; websiteId: string; vaultCredentialId?: string | null; encryptedSecret: string }, environment: Environment) {
  if (access.vaultCredentialId && !environment.CARE_ENABLED) throw new ApiError(503, 'CAPABILITY_DISABLED', 'Conversational credential use is disabled.');
  if (!access.vaultCredentialId) return decryptSecret(access.encryptedSecret, environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY);
  const record = await database.careCredential.findFirst({ where: { id: access.vaultCredentialId, tenantId: access.tenantId, websiteId: access.websiteId, environment: 'PRODUCTION', kind: 'SSH', status: 'STORED', authorizationExpiresAt: { gt: new Date() } } });
  if (!record) throw new ApiError(403, 'AUTHORIZATION_REQUIRED', 'Server access was revoked or its inspection permission expired.');
  return openSecret(record.encryptedEnvelope, record, { v1: vaultKey(environment) });
}
export async function trackedChat<T>(request: FastifyRequest, websiteId: string, requestKey: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const scope = { tenantId: request.tenantId!, websiteId, environment: 'PRODUCTION' };
  const job = await database.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM websites WHERE id = ${websiteId}::uuid FOR UPDATE`;
    const duplicate = await tx.careJob.findUnique({ where: { tenantId_websiteId_requestKey: { tenantId: scope.tenantId, websiteId, requestKey } } });
    if (duplicate) throw new ApiError(409, 'REQUEST_ALREADY_RECORDED', 'This request already exists. Refresh activity to see its outcome.');
    const count = await tx.careJob.count({ where: { tenantId: scope.tenantId, websiteId, state: 'RUNNING', heartbeatAt: { gt: new Date(Date.now() - 90000) } } });
    if (count >= 3) throw new ApiError(429, 'WORKER_LIMIT', 'Three tasks are already active for this website.');
    const created = await tx.careJob.create({ data: { ...scope, userId: request.userId!, requestKey, kind: 'CHAT', summary: 'Answer the customer using approved website evidence', state: 'RUNNING', agents: { create: { roleId: 'A02', task: 'Prepare an evidence-based reply', state: 'RUNNING' } } }, include: { agents: true } });
    await careEvent(tx, scope, 'agent.started', 'RUNNING', 'Customer Liaison is preparing your reply.', { jobId: created.id, agentRunId: created.agents[0]!.id });
    return created;
  });
  const controller = new AbortController(); let ticking = false;
  const timer = setInterval(() => { if (ticking) return; ticking = true; void (async () => {
    const current = await database.careJob.findUnique({ where: { id: job.id } });
    if (!current || current.state !== 'RUNNING') { controller.abort(); return; }
    await database.$transaction([database.careJob.updateMany({ where: { id: job.id, state: 'RUNNING' }, data: { heartbeatAt: new Date() } }), database.careAgentRun.updateMany({ where: { jobId: job.id, state: 'RUNNING' }, data: { heartbeatAt: new Date() } })]);
  })().catch(() => controller.abort()).finally(() => { ticking = false; }); }, 10000);
  try {
    const result = await task(controller.signal);
    const resultObject = result as { text?: string };
    if (resultObject.text && looksSensitive(resultObject.text)) throw new ApiError(502, 'SENSITIVE_OUTPUT_BLOCKED', 'The response was withheld because it may contain access details.');
    if (controller.signal.aborted) throw new ApiError(409, 'JOB_CANCELLED', 'The response was stopped. Already-started observations may need reconciliation.');
    // Completion is committed by finishChat only after the response message is persisted.
    return result;
  } catch (error) {
    await database.$transaction(async (tx) => {
      const changed = await tx.careJob.updateMany({ where: { id: job.id, state: 'RUNNING' }, data: { state: 'FAILED', errorCode: 'CHAT_FAILED' } });
      if (changed.count) {
        await tx.careAgentRun.updateMany({ where: { jobId: job.id, state: 'RUNNING' }, data: { state: 'FAILED', completedAt: new Date() } });
        await careEvent(tx, scope, 'job.failed', 'FAILED', 'The reply could not be completed. Please review the displayed error.', { jobId: job.id });
      }
    });
    throw error;
  } finally { clearInterval(timer); }
}
export async function finishChat(tenantId: string, websiteId: string, requestKey: string, messageId: string) {
  await database.$transaction(async (tx) => {
    const job = await tx.careJob.findUnique({ where: { tenantId_websiteId_requestKey: { tenantId, websiteId, requestKey } } });
    if (!job) return;
    const changed = await tx.careJob.updateMany({ where: { id: job.id, state: 'RUNNING' }, data: { state: 'COMPLETED', resultMessageId: messageId } });
    if (!changed.count) return;
    await tx.careAgentRun.updateMany({ where: { jobId: job.id, state: 'RUNNING' }, data: { state: 'COMPLETED', resultMessageId: messageId, completedAt: new Date() } });
    await careEvent(tx, { tenantId, websiteId, environment: job.environment }, 'job.completed', 'COMPLETED', 'Reply ready in the conversation.', { jobId: job.id });
  });
}
