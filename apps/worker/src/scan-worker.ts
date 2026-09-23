import { createHash } from 'node:crypto';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import type { Logger } from 'pino';
import { database } from '@zerochack/database';
import { implementedEngines, runSecurityScan, TargetSecurityError, type EngineFinding } from '@zerochack/scanner';
import { emitTenantEvent } from './communication-events.js';

type ScanJob = { scanId: string; websiteId: string; tenantId: string };
const secretKey = /password|token|secret|cookie|authorization|api.?key|private.?key/iu;

export function sanitizeEvidence(value: Record<string, string | number | boolean | null>): Record<string, string | number | boolean | null> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, secretKey.test(key) ? '[REDACTED]' : typeof item === 'string' ? item.slice(0, 2048) : item]));
}
export function integrityHash(input: { engine: string; version: string; observedAt: Date; summary: string; metadata: Record<string, unknown> }): string {
  return createHash('sha256').update(JSON.stringify({ engine: input.engine, version: input.version, observedAt: input.observedAt.toISOString(), summary: input.summary, metadata: Object.fromEntries(Object.entries(input.metadata).sort(([a], [b]) => a.localeCompare(b))) })).digest('hex');
}
const postureFrom = (findings: EngineFinding[]) => findings.some((item) => item.severity === 'CRITICAL') ? 'CRITICAL' as const : findings.some((item) => ['HIGH', 'MEDIUM'].includes(item.severity)) ? 'ATTENTION' as const : 'HEALTHY' as const;
function assessmentSummary(findings: EngineFinding[]): string {
  if (!findings.length) return 'Security assessment complete. No supported security issues were identified. You can ask the AI Assistant a question here at any time.';
  const issues = findings.slice(0, 12).map((finding, index) => `${index + 1}. [${finding.severity}] ${finding.title}\n${finding.recommendation}`);
  const remaining = findings.length > issues.length ? `\n\n${findings.length - issues.length} more issue(s) are available in the assessment view.` : '';
  return `Security assessment complete. I identified ${findings.length} issue(s):\n\n${issues.join('\n\n')}${remaining}\n\nReview the price before choosing Fix with a live specialist.`.slice(0, 4000);
}

export async function processScan(job: Job<ScanJob>, logger?: Logger, runner: typeof runSecurityScan = runSecurityScan, scannerOptions: { timeoutMs?: number; maxRedirects?: number; maxBytes?: number } = {}): Promise<{ findings: number }> {
  const { scanId, websiteId, tenantId } = job.data;
  if (![scanId, websiteId, tenantId].every((value) => typeof value === 'string' && /^[0-9a-f-]{36}$/iu.test(value))) throw new Error('Invalid scan job identity');
  const scan = await database.scan.findFirst({ where: { id: scanId, websiteId, tenantId }, include: { website: true } });
  if (!scan) throw new Error('Scan job is outside its persisted tenant scope');
  if (scan.status === 'SUCCEEDED' || scan.status === 'CANCELLED') return { findings: await database.securityFinding.count({ where: { scanId, tenantId, websiteId } }) };
  if (scan.website.connectionStatus !== 'VERIFIED' || !scan.website.connectedAt) {
    await database.scan.update({ where: { id: scanId }, data: { status: 'CANCELLED', errorCode: 'WEBSITE_NOT_VERIFIED', completedAt: new Date() } });
    await database.auditLog.create({ data: { tenantId, requestId: `worker:${job.id ?? scanId}`.slice(0, 100), action: 'scan.cancelled', resourceType: 'scan', resourceId: scanId, metadata: { errorCode: 'WEBSITE_NOT_VERIFIED' } } });
    throw new Error('Website is not verified and connected');
  }
  await database.scan.update({ where: { id: scanId }, data: { status: 'RUNNING', startedAt: scan.startedAt ?? new Date(), attemptCount: { increment: 1 }, progress: 5, engineCount: implementedEngines.length, errorCode: null } });
  try {
    const result = await runner(scan.website.url, { ...scannerOptions, onEngineComplete: async (completed, total) => { await database.scan.update({ where: { id: scanId }, data: { completedEngines: completed, progress: 10 + Math.round((completed / Math.max(total, 1)) * 80) } }); } });
    await database.$transaction(async (transaction) => {
      await transaction.findingEvidence.deleteMany({ where: { scanId, tenantId, websiteId } }); await transaction.securityFinding.deleteMany({ where: { scanId, tenantId, websiteId } });
      for (const resultFinding of result.findings) {
        const { evidence, engine, engineVersion, observedAt, ...finding } = resultFinding;
        const created = await transaction.securityFinding.create({ data: { tenantId, websiteId, scanId, ...finding } });
        const metadata = sanitizeEvidence(evidence.metadata); const summary = evidence.summary.slice(0, 8000);
        await transaction.findingEvidence.create({ data: { tenantId, websiteId, scanId, findingId: created.id, engine, engineVersion, observedAt, summary, metadata, integrityHash: integrityHash({ engine, version: engineVersion, observedAt, summary, metadata }) } });
      }
      const completedAt = new Date(); await transaction.scan.update({ where: { id: scanId }, data: { status: 'SUCCEEDED', progress: 100, completedAt, finalUrl: result.response.url, completedEngines: result.engineCount } });
      await transaction.website.update({ where: { id: websiteId }, data: { lastScanAt: completedAt, securityStatus: postureFrom(result.findings) } });
      await transaction.chatMessage.create({ data: { tenantId, websiteId, type: 'SYSTEM', content: assessmentSummary(result.findings) } });
      await transaction.auditLog.create({ data: { tenantId, requestId: `worker:${job.id ?? scanId}`.slice(0, 100), action: 'scan.completed', resourceType: 'scan', resourceId: scanId, metadata: { engineCount: result.engineCount, findingCount: result.findings.length } } });
    });
    logger?.info({ tenantId, websiteId, scanId, findingCount: result.findings.length }, 'scan.completed'); return { findings: result.findings.length };
  } catch (error) {
    const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1); const errorCode = error instanceof TargetSecurityError ? error.code : 'SCAN_ENGINE_FAILED';
    await database.scan.update({ where: { id: scanId }, data: { status: finalAttempt ? 'FAILED' : 'QUEUED', errorCode, ...(finalAttempt ? { completedAt: new Date() } : {}) } });
    await database.auditLog.create({ data: { tenantId, requestId: `worker:${job.id ?? scanId}`.slice(0, 100), action: finalAttempt ? 'scan.failed' : 'scan.retry_scheduled', resourceType: 'scan', resourceId: scanId, metadata: { errorCode, attempt: job.attemptsMade + 1 } } });
    logger?.error({ tenantId, websiteId, scanId, errorCode }, 'scan.failed'); throw error;
  }
}

export function createScanWorker(redisUrl: string, logger: Logger, scannerOptions: { timeoutMs?: number; maxRedirects?: number; maxBytes?: number } = {}): Worker<ScanJob> {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  return new Worker<ScanJob>('scans', async(job) => {const result=await processScan(job, logger, runSecurityScan, scannerOptions);const website=await database.website.findUnique({where:{id:job.data.websiteId},select:{name:true}});await emitTenantEvent({tenantId:job.data.tenantId,eventType:'SCAN_COMPLETED',deduplicationKey:`scan-completed:${job.data.scanId}`,title:'Security assessment completed',message:`The security assessment for ${website?.name??'your website'} completed with ${result.findings} finding(s).`,actionUrl:`/customer/websites/${job.data.websiteId}/findings`,data:{scanId:job.data.scanId,websiteId:job.data.websiteId,findingCount:result.findings}},redisUrl);const critical=await database.securityFinding.count({where:{scanId:job.data.scanId,tenantId:job.data.tenantId,severity:'CRITICAL'}});if(critical)await emitTenantEvent({tenantId:job.data.tenantId,eventType:'CRITICAL_FINDING',deduplicationKey:`critical-findings:${job.data.scanId}`,title:'Critical security finding',message:`${critical} critical finding(s) require attention.`,actionUrl:`/customer/websites/${job.data.websiteId}/findings`,data:{scanId:job.data.scanId,websiteId:job.data.websiteId,criticalCount:critical}},redisUrl);return result;}, { connection, concurrency: 2, limiter: { max: 10, duration: 60_000 }, lockDuration: 60_000 });
}
