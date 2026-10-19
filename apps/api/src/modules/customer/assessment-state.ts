import type { Prisma } from '@prisma/client';
import { database } from '@zerochack/database';

export const assessmentAudit = {
  started: 'website.ai_assessment_started', progress: 'website.ai_assessment_progress',
  completed: 'website.ai_assessment_completed', failed: 'website.ai_assessment_failed', cancelled: 'website.ai_assessment_cancelled'
} as const;

export async function lockAssessmentWebsite(tx: Prisma.TransactionClient, tenantId: string, websiteId: string) {
  await tx.$queryRaw`SELECT id FROM websites WHERE id = ${websiteId}::uuid AND tenant_id = ${tenantId}::uuid FOR UPDATE`;
}

/** A projection of durable evidence, not a fabricated sequence or live-worker lease. */
export async function assessmentView(tenantId: string, websiteId: string, hostname: string) {
  const start = await database.auditLog.findFirst({ where: { tenantId, resourceType: 'scan', action: assessmentAudit.started, metadata: { path: ['websiteId'], equals: websiteId } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] });
  if (!start?.resourceId) return { scan: null };
  const [scan, event] = await Promise.all([
    database.scan.findFirst({ where: { id: start.resourceId, tenantId, websiteId } }),
    database.auditLog.findFirst({ where: { tenantId, resourceType: 'scan', resourceId: start.resourceId, action: { in: Object.values(assessmentAudit) } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
  ]);
  if (!scan || !event) return { scan: null };
  const metadata = event.metadata && typeof event.metadata === 'object' && !Array.isArray(event.metadata) ? event.metadata : {};
  const scope = metadata.scope && typeof metadata.scope === 'object' && !Array.isArray(metadata.scope) ? metadata.scope : {};
  const legacyScope = scan.status === 'SUCCEEDED' && (scope.mode !== 'WEBSITE' || scope.hostname !== hostname);
  const stale = scan.status === 'RUNNING' && Date.now() - event.createdAt.getTime() > 180_000;
  const stage = scan.errorCode === 'ASSESSMENT_CANCELLED' ? 'CANCELLED' : stale ? 'INTERRUPTED' : scan.status === 'FAILED' ? 'FAILED' : scan.status === 'SUCCEEDED' ? 'COMPLETED' : typeof metadata.stage === 'string' ? metadata.stage : 'CONNECTING';
  return { scan: {
    id: scan.id, status: scan.status, stage, updatedAt: event.createdAt, errorCode: scan.errorCode,
    repairApplied: false as const,
    ...(legacyScope ? { scopeWarning: 'This historical inspection was not limited to the selected website. It may include other websites on the account. It is preserved for history, not accepted as a current website-only assessment.' } : {}),
    ...(typeof metadata.coverageState === 'string' ? { coverageState: metadata.coverageState } : {}),
    ...(Array.isArray(metadata.coverageLimitations) ? { coverageLimitations: metadata.coverageLimitations.filter((value): value is string => typeof value === 'string') } : {})
  } };
}
