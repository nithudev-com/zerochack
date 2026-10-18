import { database } from '@zerochack/database';
import type { RecoveryReadiness } from '@zerochack/care';

/** Server-bound, read-only metadata. Never opens a backup, credential or host. */
export async function recoveryReadiness(tenantId: string, websiteId: string, environment: string, now = new Date()): Promise<RecoveryReadiness> {
  if (environment !== 'PRODUCTION') return { state: 'NOT_OBSERVED', observedAt: now.toISOString(), checks: [], limitation: 'Existing backup and monitoring records cover production only. Staging recovery needs separate evidence. This does not authorize a restore.' };
  const scope = { tenantId, websiteId };
  const [backup, backupPolicy, monitoringPolicy, monitoringCheck, unresolved] = await Promise.all([
    database.backup.findFirst({ where: { ...scope, status: 'SUCCEEDED', deletedAt: null, deleteRequestedAt: null, verifiedAt: { not: null }, integrityHash: { not: null }, restoreReference: { not: null }, OR: [{ retentionUntil: null }, { retentionUntil: { gt: now } }] }, orderBy: { verifiedAt: 'desc' }, select: { id: true, verifiedAt: true } }),
    database.backupPolicy.findFirst({ where: scope, select: { enabled: true } }),
    database.monitoringPolicy.findFirst({ where: scope, select: { enabled: true } }),
    database.monitoringCheck.findFirst({ where: { ...scope, status: 'SUCCEEDED' }, orderBy: { completedAt: 'desc' }, select: { completedAt: true } }),
    database.careRelease.count({ where: { ...scope, state: 'OUTCOME_UNKNOWN' } })
  ]);
  return {
    state: 'RECORDED_EVIDENCE', observedAt: now.toISOString(),
    checks: [
      { name: 'Verified backup record', state: backup ? 'RECORDED' : 'MISSING', detail: backup ? `Backup ${backup.id}; verification recorded ${backup.verifiedAt!.toISOString()}. Current bytes and clean-state suitability were not rechecked.` : 'No retained, verified production backup record was found.' },
      { name: 'Scheduled backups', state: backupPolicy?.enabled ? 'CONFIGURED' : 'MISSING', detail: 'Configuration alone does not prove the scheduler or storage provider works.' },
      { name: 'Monitoring', state: monitoringPolicy?.enabled ? 'CONFIGURED' : 'MISSING', detail: monitoringCheck?.completedAt ? `Last successful recorded check: ${monitoringCheck.completedAt.toISOString()}. This is not a live health check.` : 'No successful monitoring check was found.' },
      { name: 'Unresolved release', state: unresolved ? 'BLOCKED' : 'NONE_RECORDED', detail: unresolved ? 'Reconcile the recorded uncertain release before another release.' : 'No uncertain Care release is recorded.' },
      { name: 'Clean restore drill', state: 'NOT_VERIFIED', detail: 'A verified backup record does not prove malware absence or a successful end-to-end restore. Record a separate isolated recovery drill before release.' }
    ],
    limitation: 'Recorded metadata is not a recovery certification. No infrastructure contact, restore or production change occurred.'
  };
}
