import { database } from '@zerochack/database';

/** References only: no secret payloads enter BullMQ, logging, or workflow history. */
export async function maintainCareRecords(now = new Date()) {
  return database.$transaction(async (tx) => {
    const expired = await tx.careCredential.findMany({ where: { status: 'STORED', authorizationExpiresAt: { lte: now } }, select: { id: true, tenantId: true, websiteId: true, environment: true }, take: 100 });
    for (const credential of expired) {
      await tx.$queryRaw`SELECT id FROM care_credentials WHERE id = ${credential.id}::uuid FOR UPDATE`;
      await tx.careCredential.update({ where: { id: credential.id }, data: { status: 'EXPIRED', encryptedEnvelope: '' } });
      await tx.careAccessRequest.updateMany({ where: { credentialId: credential.id, status: { in: ['PENDING','APPROVED'] } }, data: { status: 'EXPIRED' } });
      await tx.websiteAccessCredential.deleteMany({ where: { vaultCredentialId: credential.id } });
      await tx.careEvent.create({ data: { tenantId: credential.tenantId, websiteId: credential.websiteId, environment: credential.environment, eventType: 'credential.expired', state: 'EXPIRED', summary: 'Inspection permission expired. Stored credential material was removed.' } });
    }
    await tx.careAccessRequest.updateMany({ where: { expiresAt: { lte: now }, status: { in: ['PENDING','APPROVED'] } }, data: { status: 'EXPIRED' } });
    const stale = await tx.careJob.findMany({ where: { state: { in: ['RUNNING','VERIFYING'] }, heartbeatAt: { lt: new Date(now.getTime() - 90000) } }, take: 100 });
    for (const job of stale) {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${job.websiteId}::uuid FOR UPDATE`;
      const changed = await tx.careJob.updateMany({ where: { id: job.id, state: job.state, heartbeatAt: job.heartbeatAt }, data: { state: 'STALE', errorCode: 'WORKER_HEARTBEAT_LOST', leaseVersion: { increment: 1 } } });
      if (!changed.count) continue;
      await tx.careAgentRun.updateMany({ where: { jobId: job.id, state: { in: ['RUNNING','VERIFYING','QUEUED','WAITING_FOR_DEPENDENCY'] } }, data: { state: 'STALE' } });
      if (job.kind === 'REVIEW') await tx.careRevision.updateMany({ where: { jobId: job.id, budgetState: 'RESERVED' }, data: { state: 'STOPPED', budgetState: 'UNKNOWN' } });
      await tx.careEvent.create({ data: { tenantId: job.tenantId, websiteId: job.websiteId, environment: job.environment, jobId: job.id, eventType: 'job.stale', state: 'STALE', summary: 'Worker heartbeat was lost. Outcomes need review; the task has not been replayed.' } });
    }
    const artifacts = await tx.careArtifact.findMany({ where: { status: 'ACCEPTED', expiresAt: { lte: now } }, take: 100 });
    for (const artifact of artifacts) {
      await tx.$queryRaw`SELECT id FROM websites WHERE id = ${artifact.websiteId}::uuid FOR UPDATE`;
      const activeRelease = await tx.careRelease.count({ where: { websiteId: artifact.websiteId, state: { in: ['QUEUED','RUNNING','VERIFYING','OUTCOME_UNKNOWN'] } } });
      if (!activeRelease) await tx.careArtifact.update({ where: { id: artifact.id }, data: { status: 'EXPIRED', encryptedBody: '' } });
    }
    await tx.careRelease.updateMany({ where: { state: { in: ['RUNNING','VERIFYING'] }, heartbeatAt: { lt: new Date(now.getTime() - 90000) } }, data: { state: 'OUTCOME_UNKNOWN', errorCode: 'WORKER_HEARTBEAT_LOST' } });
    return { expiredCredentials: expired.length, staleJobs: stale.length };
  }, { timeout: 15000 });
}
