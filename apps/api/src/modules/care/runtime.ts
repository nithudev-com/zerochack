import type { Prisma } from '@prisma/client';
import type { Environment } from '@zerochack/config';

export const vaultKey = (environment: Environment) => environment.CARE_VAULT_KEY ?? environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY;
export async function claimCareWebsite(tx: Prisma.TransactionClient, kind: 'REVIEW' | 'REPAIR') {
  const sites = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM websites w WHERE EXISTS (SELECT 1 FROM care_jobs j WHERE j.website_id = w.id AND j.kind = ${kind} AND j.state = 'QUEUED') AND NOT EXISTS (SELECT 1 FROM care_jobs a WHERE a.website_id = w.id AND a.kind IN ('REVIEW','REPAIR') AND a.state IN ('RUNNING','VERIFYING')) ORDER BY (SELECT MIN(j.updated_at) FROM care_jobs j WHERE j.website_id = w.id AND j.kind = ${kind} AND j.state = 'QUEUED'), id LIMIT 1 FOR UPDATE SKIP LOCKED`;
  if (!sites[0]) return null;
  // Recheck after acquiring the common website lock: another claim may have committed
  // after this statement's MVCC snapshot was taken but before the lock was acquired.
  if (await tx.careJob.count({ where: { websiteId: sites[0].id, kind: { in: ['REVIEW','REPAIR'] }, state: { in: ['RUNNING','VERIFYING'] } } })) return null;
  return sites[0].id;
}
export async function careEvent(tx: Prisma.TransactionClient, scope: { tenantId: string; websiteId: string; environment: string }, eventType: string, state: string, summary: string, refs?: { jobId?: string; agentRunId?: string }) {
  return tx.careEvent.create({ data: { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, ...refs, eventType, state, summary } });
}
