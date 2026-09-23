import type { Queue } from 'bullmq';
import { database } from '@zerochack/database';

export async function reconcileSchedulers(queues: ReadonlyMap<string, Queue>): Promise<{ monitoring: number; backups: number }> {
  const monitoringQueue = queues.get('monitoring'); const backupQueue = queues.get('backups'); if (!monitoringQueue || !backupQueue) throw new Error('SCHEDULER_QUEUES_MISSING');
  const [monitoringPolicies, backupPolicies] = await Promise.all([database.monitoringPolicy.findMany({ where: { enabled: true }, select: { tenantId: true, websiteId: true, intervalMinutes: true } }), database.backupPolicy.findMany({ where: { enabled: true }, select: { tenantId: true, websiteId: true, frequencyHours: true } })]);
  for (const policy of monitoringPolicies) await monitoringQueue.upsertJobScheduler(`monitor-${policy.websiteId}`, { every: policy.intervalMinutes * 60_000 }, { name: 'monitoring.scheduled', data: { tenantId: policy.tenantId, websiteId: policy.websiteId }, opts: { removeOnComplete: 1000, removeOnFail: 5000 } });
  for (const policy of backupPolicies) { await backupQueue.upsertJobScheduler(`backup-${policy.websiteId}`, { every: policy.frequencyHours * 3_600_000 }, { name: 'backup.scheduled', data: { action: 'CREATE', tenantId: policy.tenantId, websiteId: policy.websiteId }, opts: { removeOnComplete: 1000, removeOnFail: 5000 } }); await backupQueue.upsertJobScheduler(`retention-${policy.websiteId}`, { every: 86_400_000 }, { name: 'backup.retention', data: { action: 'RETENTION', tenantId: policy.tenantId, websiteId: policy.websiteId }, opts: { removeOnComplete: 1000, removeOnFail: 5000 } }); }
  return { monitoring: monitoringPolicies.length, backups: backupPolicies.length };
}
