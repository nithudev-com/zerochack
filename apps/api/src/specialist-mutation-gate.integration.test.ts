import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { database } from '@zerochack/database';
import { hashOpaqueToken } from '@zerochack/auth';
import { loadEnvironment } from '@zerochack/config';
import { buildApp } from './app.js';

const environment = loadEnvironment({ NODE_ENV: 'test', DATABASE_URL: process.env.DATABASE_URL, REDIS_URL: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380', SESSION_SECRET: 'synthetic-mutation-gate-integration-32chars', CORS_ORIGINS: 'http://localhost:3000', LOG_LEVEL: 'silent' });
const remediationToken = crypto.randomUUID(); const otherRemediationToken = crypto.randomUUID();
const cookies: Record<string, string> = {}; const userIds: Record<string, string> = {};
let app: Awaited<ReturnType<typeof buildApp>>;
let tenantId: string; let websiteId: string; let otherWebsiteId: string; let findingId: string; let beforeScanId: string; let postScanId: string;
let ticketId: string; let authorizationId: string; let backupId: string; let sessionId: string; let playbookId: string; let runId: string;
let otherSessionId: string; let otherAuthorizationId: string;
const future = () => new Date(Date.now() + 3_600_000);

beforeAll(async () => {
  if (!new URL(environment.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Disposable *_test database required');
  tenantId = (await database.tenant.create({ data: { name: 'Mutation gate fixture', slug: `mutation-gate-${crypto.randomUUID()}` } })).id;
  for (const [label, roleName] of [['specialist', 'Cybersecurity Specialist'], ['other', 'Cybersecurity Specialist'], ['customer', 'Customer']] as const) {
    const user = await database.user.create({ data: { email: `${label}-${crypto.randomUUID()}@example.test`, passwordHash: 'not-a-login-hash', status: 'APPROVED', emailVerifiedAt: new Date() } }); userIds[label] = user.id;
    const role = await database.role.findFirstOrThrow({ where: { name: roleName, tenantId: null } });
    await database.tenantMembership.create({ data: { tenantId, userId: user.id, status: 'ACTIVE' } });
    await database.userRole.create({ data: { tenantId, userId: user.id, roleId: role.id } });
    const token = crypto.randomUUID(); await database.session.create({ data: { tenantId, userId: user.id, tokenHash: hashOpaqueToken(token, environment.SESSION_SECRET), expiresAt: future() } }); cookies[label] = `zerochack_session=${token}`;
  }
  websiteId = (await database.website.create({ data: { tenantId, name: 'Mutation fixture', url: 'https://example.test/', normalizedHost: 'example.test' } })).id;
  otherWebsiteId = (await database.website.create({ data: { tenantId, name: 'Other mutation fixture', url: 'https://other.example.test/', normalizedHost: 'other.example.test' } })).id;
  beforeScanId = (await database.scan.create({ data: { tenantId, websiteId, status: 'SUCCEEDED', completedAt: new Date() } })).id;
  postScanId = (await database.scan.create({ data: { tenantId, websiteId, status: 'SUCCEEDED', completedAt: new Date() } })).id;
  findingId = (await database.securityFinding.create({ data: { tenantId, websiteId, scanId: beforeScanId, fingerprint: 'a'.repeat(64), title: 'Synthetic finding only', severity: 'HIGH', confidence: 1, affectedResource: 'https://example.test/', recommendation: 'Review evidence before any change' } })).id;
  ticketId = (await database.ticket.create({ data: { tenantId, websiteId, findingId, title: 'Synthetic mutation gate ticket', assignedSpecialistId: userIds.specialist!, status: 'IN_PROGRESS' } })).id;
  authorizationId = (await database.remediationAuthorization.create({ data: { tenantId, websiteId, ticketId, authorizedByUserId: userIds.customer!, scope: ['finding.remediate'], expiresAt: future() } })).id;
  backupId = (await database.backup.create({ data: { tenantId, websiteId, ticketId, purpose: 'PRE_REMEDIATION', status: 'SUCCEEDED', verifiedAt: new Date(), completedAt: new Date() } })).id;
  sessionId = (await database.remediationSession.create({ data: { tenantId, websiteId, ticketId, specialistId: userIds.specialist!, authorizationId, tokenHash: hashOpaqueToken(remediationToken, environment.SESSION_SECRET), scope: ['finding.remediate'], expiresAt: future() } })).id;
  // Keep the alternate credential tuple valid in its own website/ticket. The
  // route must reject using that valid session for a different ticket rather
  // than relying on impossible rows rejected by PostgreSQL's composite FK.
  const otherTicketId = (await database.ticket.create({ data: { tenantId, websiteId: otherWebsiteId, title: 'Independent mutation gate ticket', assignedSpecialistId: userIds.specialist!, status: 'IN_PROGRESS' } })).id;
  otherAuthorizationId = (await database.remediationAuthorization.create({ data: { tenantId, websiteId: otherWebsiteId, ticketId: otherTicketId, authorizedByUserId: userIds.customer!, scope: ['finding.remediate'], expiresAt: future() } })).id;
  otherSessionId = (await database.remediationSession.create({ data: { tenantId, websiteId: otherWebsiteId, ticketId: otherTicketId, specialistId: userIds.specialist!, authorizationId: otherAuthorizationId, tokenHash: hashOpaqueToken(otherRemediationToken, environment.SESSION_SECRET), scope: ['finding.remediate'], expiresAt: future() } })).id;
  playbookId = (await database.remediationPlaybook.create({ data: { name: `Synthetic status-only ${crypto.randomUUID()}`, version: 1, enabled: true, actionKeys: ['FINDING_MARK_IN_REMEDIATION'], requiredScopes: ['finding.remediate'] } })).id;
  // This represents an existing status-only run. Tests must not rewrite it as
  // historical cleanup or regard its action labels as mutation evidence.
  runId = (await database.remediationRun.create({ data: { tenantId, websiteId, ticketId, specialistId: userIds.specialist!, authorizationId, sessionId, backupId, playbookId, status: 'AWAITING_POST_SCAN', executedActions: ['FINDING_MARK_IN_REMEDIATION'], beforeScanId, postScanId, startedAt: new Date() } })).id;
  app = await buildApp(environment);
});

beforeEach(async () => {
  await database.remediationSession.deleteMany({ where: { tenantId, id: { notIn: [sessionId, otherSessionId] } } });
  await database.remediationAuthorization.update({ where: { id: authorizationId }, data: { scope: ['finding.remediate'], expiresAt: future(), revokedAt: null } });
  await database.remediationSession.update({ where: { id: sessionId }, data: { websiteId, specialistId: userIds.specialist!, scope: ['finding.remediate'], status: 'ACTIVE', expiresAt: future(), revokedAt: null, revokedReason: null } });
  await database.remediationAuthorization.update({ where: { id: otherAuthorizationId }, data: { expiresAt: future() } });
  await database.remediationSession.update({ where: { id: otherSessionId }, data: { expiresAt: future() } });
  await database.backup.update({ where: { id: backupId }, data: { status: 'SUCCEEDED', verifiedAt: new Date() } });
  await database.remediationPlaybook.update({ where: { id: playbookId }, data: { enabled: true, actionKeys: ['FINDING_MARK_IN_REMEDIATION'] } });
  await database.ticket.update({ where: { id: ticketId }, data: { status: 'IN_PROGRESS', progressStage: 'AWAITING_APPROVAL', progressNote: 'No repair has run', progressUpdatedAt: null } });
  await database.scan.update({ where: { id: postScanId }, data: { status: 'SUCCEEDED' } });
  await database.remediationRun.update({ where: { id: runId }, data: { status: 'AWAITING_POST_SCAN', postScanId, executedActions: ['FINDING_MARK_IN_REMEDIATION'] } });
  await database.auditLog.deleteMany({ where: { tenantId } });
});

afterAll(async () => {
  if (app) await app.close();
  if (tenantId) {
    await database.remediationRun.deleteMany({ where: { tenantId } }); await database.remediationSession.deleteMany({ where: { tenantId } }); await database.remediationAuthorization.deleteMany({ where: { tenantId } });
    await database.backup.deleteMany({ where: { tenantId } }); await database.ticket.deleteMany({ where: { tenantId } }); await database.securityFinding.deleteMany({ where: { tenantId } }); await database.scan.deleteMany({ where: { tenantId } });
    if (playbookId) await database.remediationPlaybook.deleteMany({ where: { id: playbookId } });
    await database.website.deleteMany({ where: { tenantId } }); await database.auditLog.deleteMany({ where: { tenantId } });
    await database.session.deleteMany({ where: { tenantId } }); await database.userRole.deleteMany({ where: { tenantId } }); await database.tenantMembership.deleteMany({ where: { tenantId } }); await database.user.deleteMany({ where: { id: { in: Object.values(userIds) } } }); await database.tenant.delete({ where: { id: tenantId } });
  }
  await database.$disconnect();
});

const remediate = (cookie = cookies.specialist!, token: string | undefined = remediationToken) => app.inject({ method: 'POST', url: `/v1/specialist/tickets/${ticketId}/remediate`, headers: { cookie, ...(token ? { 'x-remediation-token': token } : {}) }, payload: { playbookId } });
const complete = (cookie = cookies.specialist!) => app.inject({ method: 'POST', url: `/v1/specialist/remediation/${runId}/complete-post-scan`, headers: { cookie } });
async function snapshot() {
  const [ticket, finding, session, authorization, backup, scans, runs, reports, messages, events, audits, allTickets, allSessions, allAuthorizations] = await Promise.all([
    database.ticket.findUnique({ where: { id: ticketId } }), database.securityFinding.findUnique({ where: { id: findingId } }), database.remediationSession.findUnique({ where: { id: sessionId } }), database.remediationAuthorization.findUnique({ where: { id: authorizationId } }), database.backup.findUnique({ where: { id: backupId } }),
    database.scan.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }), database.remediationRun.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }), database.report.findMany({ where: { tenantId } }), database.chatMessage.findMany({ where: { tenantId } }), database.communicationEvent.findMany({ where: { tenantId } }), database.auditLog.findMany({ where: { tenantId } }),
    database.ticket.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }), database.remediationSession.findMany({ where: { tenantId }, orderBy: { id: 'asc' } }), database.remediationAuthorization.findMany({ where: { tenantId }, orderBy: { id: 'asc' } })
  ]);
  return { ticket, finding, session, authorization, backup, scans, runs, reports, messages, events, audits, allTickets, allSessions, allAuthorizations };
}

it('requires authenticated specialist access and an assigned ticket before considering execution', async () => {
  const before = await snapshot();
  expect((await app.inject({ method: 'POST', url: `/v1/specialist/tickets/${ticketId}/remediate`, payload: { playbookId } })).statusCode).toBe(401);
  expect((await remediate(cookies.customer!)).statusCode).toBe(403);
  expect((await remediate(cookies.other!)).statusCode).toBe(404);
  const noToken = await remediate(cookies.specialist!, ''); expect(noToken.statusCode).toBe(401); expect(noToken.json().error.code).toBe('REMEDIATION_TOKEN_REQUIRED');
  const unknownToken = await remediate(cookies.specialist!, crypto.randomUUID()); expect(unknownToken.statusCode).toBe(409); expect(unknownToken.json().error.code).toBe('REMEDIATION_PREREQUISITE_MISSING');
  expect(await snapshot()).toEqual(before);
});

for (const [condition, code] of [['expired_authorization', 'AUTHORIZATION_EXPIRED'], ['unverified_backup', 'BACKUP_NOT_VERIFIED'], ['expired_session', 'REMEDIATION_SESSION_INVALID'], ['authorization_scope', 'AUTHORIZATION_SCOPE_DENIED'], ['session_scope', 'SESSION_SCOPE_DENIED'], ['wrong_website', 'REMEDIATION_BINDING_MISMATCH'], ['disabled_playbook', 'REMEDIATION_PREREQUISITE_MISSING']] as const) it(`preserves ${condition} gate without mutating work records`, async () => {
  if (condition === 'expired_authorization') await database.remediationAuthorization.update({ where: { id: authorizationId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  if (condition === 'unverified_backup') await database.backup.update({ where: { id: backupId }, data: { verifiedAt: null } });
  if (condition === 'expired_session') await database.remediationSession.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() - 60_000) } });
  if (condition === 'authorization_scope') await database.remediationAuthorization.update({ where: { id: authorizationId }, data: { scope: [] } });
  if (condition === 'session_scope') await database.remediationSession.update({ where: { id: sessionId }, data: { scope: [] } });
  if (condition === 'disabled_playbook') await database.remediationPlaybook.update({ where: { id: playbookId }, data: { enabled: false } });
  const before = await snapshot(); const response = await remediate(cookies.specialist!, condition === 'wrong_website' ? otherRemediationToken : remediationToken); expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe(code); expect(await snapshot()).toEqual(before);
});

for (const actions of [['FINDING_MARK_IN_REMEDIATION'], ['UNREVIEWED_SHELL_ACTION'], []]) it(`rejects action list ${JSON.stringify(actions)} without manufacturing a repair or post-scan`, async () => {
  await database.remediationPlaybook.update({ where: { id: playbookId }, data: { actionKeys: actions } });
  const before = await snapshot(); const response = await remediate();
  expect(response.statusCode).toBe(503); expect(response.json().error.code).toBe('REMEDIATION_EXECUTOR_UNAVAILABLE'); expect(response.headers['cache-control']).toBe('private, no-store');
  expect(await snapshot()).toEqual(before);
});

it('does not call a temporary access token an executed repair', async () => {
  await database.ticket.update({ where: { id: ticketId }, data: { status: 'READY' } });
  const response = await app.inject({ method: 'POST', url: `/v1/specialist/tickets/${ticketId}/sessions`, headers: { cookie: cookies.specialist! }, payload: { durationMinutes: 5 } });
  expect(response.statusCode).toBe(201);
  expect(await database.ticket.findUniqueOrThrow({ where: { id: ticketId } })).toMatchObject({ status: 'IN_PROGRESS', progressStage: 'AWAITING_APPROVAL', progressNote: 'A time-limited authorized access session is ready. No repair has run; a supported executor and reviewed repair approval are required.' });
  expect(await database.remediationRun.count({ where: { tenantId } })).toBe(1); expect(await database.scan.count({ where: { tenantId } })).toBe(2);
});

it('keeps post-scan completion authenticated and assigned, with an actual successful scan prerequisite', async () => {
  const before = await snapshot();
  expect((await app.inject({ method: 'POST', url: `/v1/specialist/remediation/${runId}/complete-post-scan` })).statusCode).toBe(401);
  expect((await complete(cookies.customer!)).statusCode).toBe(403); expect((await complete(cookies.other!)).statusCode).toBe(404); expect(await snapshot()).toEqual(before);
  await database.scan.update({ where: { id: postScanId }, data: { status: 'RUNNING' } }); const pending = await snapshot();
  const response = await complete(); expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('POST_SCAN_INCOMPLETE'); expect(await snapshot()).toEqual(pending);
});

for (const actions of [['FINDING_MARK_IN_REMEDIATION'], ['UNREVIEWED_SHELL_ACTION'], []]) it(`never resolves an existing run with unverified actions ${JSON.stringify(actions)} just because its scan succeeded`, async () => {
  await database.ticket.update({ where: { id: ticketId }, data: { status: 'POST_SCAN', progressStage: 'VERIFYING' } });
  await database.remediationRun.update({ where: { id: runId }, data: { executedActions: actions } });
  const before = await snapshot(); const response = await complete(); expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('NO_VERIFIED_MUTATION');
  expect(await snapshot()).toEqual(before); expect(await database.report.count({ where: { tenantId } })).toBe(0);
});
