import { createHash } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import Redis from 'ioredis';
import type { Logger } from 'pino';
import { database } from '@zerochack/database';
import { safeHttpRequest, TargetSecurityError, validatePublicHttpTarget, type SafeResponse } from '@zerochack/scanner';
import type { Prisma } from '@prisma/client';

export type MonitoringJob = { tenantId: string; websiteId: string };
export type MonitoringSnapshot = { available: boolean; status: number; tls: boolean; resolvedAddress: string; securityHeaders: Record<string, boolean>; contentHash: string };
export type DetectedChange = { type: 'AVAILABILITY' | 'TLS' | 'DNS' | 'HEADERS' | 'INTEGRITY' | 'SECURITY_INDICATOR'; severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; key: string; title: string; summary: string; metadata: Record<string, string | number | boolean | null> };
const monitoredHeaders = ['strict-transport-security', 'content-security-policy', 'x-content-type-options', 'referrer-policy'] as const;
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const snapshotHash = (value: MonitoringSnapshot) => sha(JSON.stringify(value));
const responseSnapshot = (response: SafeResponse): MonitoringSnapshot => ({ available: response.status >= 200 && response.status < 400, status: response.status, tls: response.url.startsWith('https:'), resolvedAddress: response.resolvedAddress, securityHeaders: Object.fromEntries(monitoredHeaders.map((header) => [header, Boolean(response.headers[header])])), contentHash: sha(response.body) });

export function detectMonitoringChanges(previous: MonitoringSnapshot | undefined, current: MonitoringSnapshot, rawIndicators: unknown): DetectedChange[] {
  const changes: DetectedChange[] = []; const indicators = typeof rawIndicators === 'object' && rawIndicators ? rawIndicators as { expectedStatus?: unknown; requiredHeaders?: unknown; integrityHash?: unknown } : {};
  if (!current.available) changes.push({ type: 'AVAILABILITY', severity: 'CRITICAL', key: 'unavailable', title: 'Website availability failure', summary: `The monitored website returned HTTP ${current.status}.`, metadata: { status: current.status } });
  if (!current.tls) changes.push({ type: 'TLS', severity: 'HIGH', key: 'tls-disabled', title: 'TLS is not active', summary: 'The final monitored URL is not protected by HTTPS.', metadata: { tls: false } });
  if (previous?.resolvedAddress && previous.resolvedAddress !== current.resolvedAddress) changes.push({ type: 'DNS', severity: 'LOW', key: 'resolved-address-changed', title: 'DNS destination changed', summary: 'The public address selected for the verified hostname changed.', metadata: { previousAddress: previous.resolvedAddress, currentAddress: current.resolvedAddress } });
  if (previous) for (const header of monitoredHeaders) if (previous.securityHeaders[header] && !current.securityHeaders[header]) changes.push({ type: 'HEADERS', severity: header === 'strict-transport-security' || header === 'content-security-policy' ? 'HIGH' : 'MEDIUM', key: `header-removed:${header}`, title: 'Security header removed', summary: `${header} was present in the previous check and is now absent.`, metadata: { header, present: false } });
  if (previous?.contentHash && previous.contentHash !== current.contentHash) changes.push({ type: 'INTEGRITY', severity: 'MEDIUM', key: 'content-changed', title: 'Website integrity changed', summary: 'The monitored response content hash changed.', metadata: { previousHash: previous.contentHash, currentHash: current.contentHash } });
  if (typeof indicators.expectedStatus === 'number' && current.status !== indicators.expectedStatus) changes.push({ type: 'SECURITY_INDICATOR', severity: 'HIGH', key: 'expected-status', title: 'Configured status indicator failed', summary: `Expected HTTP ${indicators.expectedStatus}, received ${current.status}.`, metadata: { expectedStatus: indicators.expectedStatus, currentStatus: current.status } });
  if (Array.isArray(indicators.requiredHeaders)) for (const value of indicators.requiredHeaders) if (typeof value === 'string' && monitoredHeaders.includes(value as typeof monitoredHeaders[number]) && !current.securityHeaders[value]) changes.push({ type: 'SECURITY_INDICATOR', severity: 'HIGH', key: `required-header:${value}`, title: 'Configured header indicator failed', summary: `Required security header ${value} is absent.`, metadata: { header: value, present: false } });
  if (typeof indicators.integrityHash === 'string' && /^[a-f0-9]{64}$/u.test(indicators.integrityHash) && current.contentHash !== indicators.integrityHash) changes.push({ type: 'SECURITY_INDICATOR', severity: 'HIGH', key: 'configured-integrity', title: 'Configured integrity indicator failed', summary: 'The response content does not match the configured integrity hash.', metadata: { expectedHash: indicators.integrityHash, currentHash: current.contentHash } });
  return changes;
}


const cooldownFor = (severity: DetectedChange['severity'], configured: number) => severity === 'CRITICAL' ? Math.min(configured, 15) : severity === 'HIGH' ? Math.min(configured, 30) : severity === 'LOW' ? configured * 2 : configured;
async function preserveAndAlert(tx: Prisma.TransactionClient, input: { tenantId: string; websiteId: string; checkId: string; change: DetectedChange; cooldownMinutes: number; observedAt: Date }): Promise<boolean> {
  const fingerprint = sha(`${input.websiteId}\0${input.change.type}\0${input.change.key}`);
  let event = await tx.securityEvent.findFirst({ where: { tenantId: input.tenantId, websiteId: input.websiteId, fingerprint, status: { in: ['OPEN', 'ACKNOWLEDGED', 'ESCALATED'] } }, orderBy: { lastSeenAt: 'desc' } });
  event = event ? await tx.securityEvent.update({ where: { id: event.id }, data: { checkId: input.checkId, severity: input.change.severity, occurrenceCount: { increment: 1 }, lastSeenAt: input.observedAt, summary: input.change.summary } })
    : await tx.securityEvent.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, checkId: input.checkId, type: input.change.type, severity: input.change.severity, fingerprint, title: input.change.title, summary: input.change.summary, firstSeenAt: input.observedAt, lastSeenAt: input.observedAt } });
  const metadata = input.change.metadata;
  await tx.securityEventEvidence.create({ data: { eventId: event.id, observedAt: input.observedAt, engine: 'continuous-monitor', engineVersion: '1.1.0', summary: input.change.summary, metadata, integrityHash: sha(JSON.stringify({ summary: input.change.summary, metadata, at: input.observedAt.toISOString() })) } });
  const recent = await tx.securityAlert.findFirst({ where: { eventId: event.id, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, orderBy: { createdAt: 'desc' } });
  if (recent && recent.cooldownUntil > input.observedAt) { await tx.securityAlert.update({ where: { id: recent.id }, data: { suppressedCount: { increment: 1 } } }); return false; }
  const notification = await tx.notification.create({ data: { tenantId: input.tenantId, title: `${input.change.severity}: ${input.change.title}`, body: input.change.summary } });
  const ticket = ['HIGH', 'CRITICAL'].includes(input.change.severity) ? await tx.ticket.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, title: `Monitoring escalation: ${input.change.title}`, description: `Automatically escalated from preserved security event ${event.id}.`, status: 'QUEUED', escalatedAt: input.observedAt } }) : null;
  await tx.securityAlert.create({ data: { tenantId: input.tenantId, websiteId: input.websiteId, eventId: event.id, deduplicationKey: sha(`${input.tenantId}\0${fingerprint}`), severity: input.change.severity, cooldownUntil: new Date(input.observedAt.getTime() + cooldownFor(input.change.severity, input.cooldownMinutes) * 60000), notificationId: notification.id, ...(ticket ? { specialistTicketId: ticket.id } : {}) } });
  await tx.securityEvent.update({ where: { id: event.id }, data: { status: ticket ? 'ESCALATED' : 'OPEN' } });
  await tx.auditLog.create({ data: { tenantId: input.tenantId, requestId: `monitor:${input.checkId}`, action: 'monitoring.alert_created', resourceType: 'security_event', resourceId: event.id, metadata: { severity: input.change.severity, type: input.change.type, specialistEscalated: Boolean(ticket) } } });
  return true;
}

async function recordOutbox(tx: Prisma.TransactionClient, input: { tenantId: string; websiteId: string; checkId: string; policyVersion: Date; websiteName: string; websiteUrl: string; state: 'DOWN' | 'RECOVERED' | 'UNKNOWN'; at: Date; httpStatus: number | null; startedAt: Date | null; recent: Array<'UP' | 'DOWN' | 'UNKNOWN'> }) {
  // Never accept recipient addresses or raw HTML from a customer/remote response.
  const recipients = await tx.tenantMembership.findMany({ where: { tenantId: input.tenantId, status: 'ACTIVE', user: { status: 'APPROVED', emailVerifiedAt: { not: null } } }, include: { user: { select: { displayName: true } } } });
  const title = input.state === 'DOWN' ? 'Website downtime detected' : input.state === 'RECOVERED' ? 'Website recovery detected' : 'Website monitoring needs attention';
  const message = `${input.websiteName}: ${title.toLowerCase()} at ${input.at.toISOString()}. This is a sampled check, not continuous uptime certification. Open Overview to review history.`;
  for (const member of recipients) await tx.communicationEvent.upsert({ where: { deduplicationKey: `uptime:${input.checkId}:${input.state}:${member.userId}` }, update: {}, create: {
    tenantId: input.tenantId, recipientUserId: member.userId, eventType: 'MONITORING_ALERT', deduplicationKey: `uptime:${input.checkId}:${input.state}:${member.userId}`,
    payload: { title, message, recipientName: member.user.displayName ?? 'there', websiteId: input.websiteId, monitoringPolicyVersion: input.policyVersion.toISOString(), websiteName: input.websiteName, websiteHost: new URL(input.websiteUrl).hostname, eventCount: input.state === 'RECOVERED' ? 0 : 1, checkedAt: input.at.toISOString(), status: input.state, actionUrl: `/customer/overview?website=${input.websiteId}`, monitoring: { state: input.state, websiteId: input.websiteId, websiteName: input.websiteName, websiteHost: new URL(input.websiteUrl).hostname, checkedAt: input.at.toISOString(), outageStartedAt: input.startedAt?.toISOString() ?? null, httpStatus: input.httpStatus, recent: input.recent }, existingMonitoringNotification: input.state !== 'RECOVERED' }
  } });
}

let outboxCursor: { createdAt: Date; id: string } | null = null;
export async function enqueueMonitoringOutbox(queue: { add: (name: string, data: { eventId: string }, options: { jobId: string; attempts: number; backoff: { type: string; delay: number }; removeOnComplete: number; removeOnFail: number }) => Promise<unknown> }): Promise<number> {
  // Advance fairly past old dead letters rather than starving newer incidents.
  // A restart resets the cursor and replays persisted pending records safely.
  const events = await database.communicationEvent.findMany({ where: { eventType: 'MONITORING_ALERT', processedAt: null, deduplicationKey: { startsWith: 'uptime:' }, ...(outboxCursor ? { OR: [{ createdAt: { gt: outboxCursor.createdAt } }, { createdAt: outboxCursor.createdAt, id: { gt: outboxCursor.id } }] } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 100, select: { id: true, createdAt: true } });
  for (const event of events) await queue.add('communication.process', { eventId: event.id }, { jobId: event.id, attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 1000, removeOnFail: 5000 });
  outboxCursor = events.length === 100 ? events[99]! : null;
  return events.length;
}

export async function processMonitoringCheck(job: Job<MonitoringJob>, runner: typeof safeHttpRequest = safeHttpRequest): Promise<{ events: number }> {
  const { tenantId, websiteId } = job.data; const jobId = String(job.id ?? `${websiteId}:${job.timestamp}`);
  const duplicate = await database.monitoringCheck.findUnique({ where: { jobId } });
  if (duplicate && (duplicate.tenantId !== tenantId || duplicate.websiteId !== websiteId)) throw new Error('MONITORING_JOB_BINDING_INVALID');
  if (duplicate?.completedAt) return { events: await database.securityEvent.count({ where: { checkId: duplicate.id } }) };
  const policy = await database.monitoringPolicy.findFirst({ where: { tenantId, websiteId, enabled: true }, include: { website: true } });
  if (!policy || policy.website.lifecycle !== 'ACTIVE') throw new Error('MONITORING_JOB_BINDING_INVALID');
  validatePublicHttpTarget(policy.website.url, policy.website.normalizedHost);
  const check = duplicate ?? await database.monitoringCheck.upsert({ where: { jobId }, update: {}, create: { tenantId, websiteId, jobId } });
  if (check.tenantId !== tenantId || check.websiteId !== websiteId) throw new Error('MONITORING_JOB_BINDING_INVALID');
  const started = performance.now(); let current: MonitoringSnapshot | undefined; let errorCode: string | null = null;
  // Only probe errors are classified as reachability failures. Storage/outbox
  // errors propagate to BullMQ; they must never be reported as website downtime.
  try { current = responseSnapshot(await runner(policy.website.url, { allowedHostname: policy.website.normalizedHost, method: 'GET', timeoutMs: 10000, maxRedirects: 2, maxBytes: 1_048_576 })); }
  catch (error) { errorCode = error instanceof TargetSecurityError ? error.code : 'MONITORING_CHECK_FAILED'; }
  const at = new Date(); const responseTimeMs = Math.round(performance.now() - started);
  return database.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM websites WHERE id = ${websiteId}::uuid FOR UPDATE`;
    const latestCheck = await tx.monitoringCheck.findUniqueOrThrow({ where: { id: check.id } });
    if (latestCheck.completedAt) return { events: await tx.securityEvent.count({ where: { checkId: check.id } }) };
    const active = await tx.monitoringPolicy.findFirst({ where: { websiteId, tenantId, enabled: true }, include: { website: true } });
    if (!active || active.website.lifecycle !== 'ACTIVE' || active.website.url !== policy.website.url || active.website.normalizedHost !== policy.website.normalizedHost || active.updatedAt.getTime() !== policy.updatedAt.getTime()) throw new Error('MONITORING_BINDING_CHANGED');
    const prior = await tx.monitoringCheck.findFirst({ where: { tenantId, websiteId, status: 'SUCCEEDED', id: { not: check.id } }, orderBy: { completedAt: 'desc' } });
    const reachabilityFailure = ['CONNECTION_FAILED', 'CONNECTION_TIMEOUT', 'DNS_UNRESOLVED'].includes(errorCode ?? '');
    const changes: DetectedChange[] = current ? detectMonitoringChanges(prior?.snapshot as MonitoringSnapshot | undefined, current, active.indicators)
      : [{ type: reachabilityFailure ? 'AVAILABILITY' : 'SECURITY_INDICATOR', severity: reachabilityFailure ? 'CRITICAL' : 'MEDIUM', key: reachabilityFailure ? 'unavailable' : 'monitor-blocked', title: reachabilityFailure ? 'Website availability failure' : 'Monitoring probe unavailable', summary: reachabilityFailure ? 'The verified website could not be reached by this probe.' : 'The safe probe could not verify availability. This is not evidence that the website is down.', metadata: { errorCode } }];
    const outages = await tx.securityEvent.findMany({ where: { tenantId, websiteId, type: 'AVAILABILITY', status: { in: ['OPEN', 'ACKNOWLEDGED', 'ESCALATED'] } }, orderBy: { firstSeenAt: 'asc' } });
    await tx.monitoringCheck.update({ where: { id: check.id }, data: { status: current ? 'SUCCEEDED' : 'FAILED', ...(current ? { snapshot: current, snapshotHash: snapshotHash(current), resolvedAddress: current.resolvedAddress } : {}), errorCode, responseTimeMs, completedAt: at } });
    let newAlerts = 0;
    for (const change of changes) if (await preserveAndAlert(tx, { tenantId, websiteId, checkId: check.id, change, cooldownMinutes: active.alertCooldownMinutes, observedAt: at })) newAlerts++;
    // Only an actual completed HTTP response may resolve a reachability incident.
    if (current) {
      const fingerprints = changes.map(change => sha(`${websiteId}\0${change.type}\0${change.key}`));
      const resolved = await tx.securityEvent.findMany({ where: { tenantId, websiteId, status: { in: ['OPEN', 'ACKNOWLEDGED', 'ESCALATED'] }, ...(!current.available ? { type: { not: 'AVAILABILITY' as const } } : {}), ...(fingerprints.length ? { fingerprint: { notIn: fingerprints } } : {}) }, select: { id: true } });
      if (resolved.length) {
        await tx.securityEvent.updateMany({ where: { id: { in: resolved.map(event => event.id) } }, data: { status: 'RESOLVED', resolvedAt: at } });
        await tx.securityAlert.updateMany({ where: { eventId: { in: resolved.map(event => event.id) }, status: { in: ['OPEN', 'ACKNOWLEDGED'] } }, data: { status: 'RESOLVED' } });
      }
    }
    const recovered = Boolean(current?.available && outages.length);
    if (newAlerts || recovered) {
      const recent = await tx.monitoringCheck.findMany({ where: { tenantId, websiteId, completedAt: { not: null } }, orderBy: { completedAt: 'desc' }, take: 12 });
      const states = recent.reverse().map(row => { const snapshot = row.snapshot as { status?: number } | null; return row.status === 'SUCCEEDED' && typeof snapshot?.status === 'number' ? snapshot.status >= 200 && snapshot.status < 400 ? 'UP' as const : 'DOWN' as const : ['CONNECTION_FAILED', 'CONNECTION_TIMEOUT', 'DNS_UNRESOLVED'].includes(row.errorCode ?? '') ? 'DOWN' as const : 'UNKNOWN' as const; });
      await recordOutbox(tx, { tenantId, websiteId, checkId: check.id, policyVersion: active.updatedAt, websiteName: active.website.name, websiteUrl: active.website.url, state: recovered ? 'RECOVERED' : current && !current.available || reachabilityFailure ? 'DOWN' : 'UNKNOWN', at, httpStatus: current?.status ?? null, startedAt: outages[0]?.firstSeenAt ?? (!current?.available && reachabilityFailure || current && !current.available ? at : null), recent: states });
    }
    // Do not mutate policy.updatedAt here: it is a configuration version used to
    // reject results when pause/target/policy changes race with a probe.
    await tx.website.update({ where: { id: websiteId }, data: { monitoringStatus: current ? 'ACTIVE' : 'ERROR' } });
    return { events: changes.length };
  }, { timeout: 15000 });
}

export function createMonitoringWorker(redisUrl: string, logger: Logger): Worker<MonitoringJob> {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const worker = new Worker<MonitoringJob>('monitoring', job => processMonitoringCheck(job), { connection, concurrency: 2, limiter: { max: 30, duration: 60000 } });
  worker.on('failed', job => logger.error({ jobId: job?.id, errorCode: 'MONITORING_JOB_FAILED' }, 'monitoring.job.failed'));
  return worker;
}
