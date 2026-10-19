import type { Prisma, PrismaClient, SecurityRepairRun } from '@prisma/client';
import { scopeSchema, securityThread, SecurityWorkflowError, type SecurityCheckpointStorage, type SecurityScope } from '@zerochack/security-orchestration';

export type CheckpointFence = { ownerId: string; version: number };
export type CheckpointAuthority = (tx: Prisma.TransactionClient, run: SecurityRepairRun) => Promise<void>;

/** PostgreSQL/Prisma storage for the encrypted graph cursor. The journal remains
 * authoritative for effects. This service is internal, never a raw checkpoint API.
 */
export function securityCheckpointStorage(database: PrismaClient, input: SecurityScope, fence: CheckpointFence, authorize: CheckpointAuthority): SecurityCheckpointStorage {
  const scope = Object.freeze(scopeSchema.parse(input));
  const where = { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, runId: scope.runId, checkpointNs: '' };
  function same(actual: SecurityScope) {
    if (securityThread(actual) !== securityThread(scope)) throw new SecurityWorkflowError('SECURITY_CHECKPOINT_SCOPE_DENIED');
  }
  async function current<T>(action: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    return database.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '1000ms'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '4000ms'`;
      await tx.$queryRaw`SELECT id FROM websites WHERE id=${scope.websiteId}::uuid AND tenant_id=${scope.tenantId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM security_repair_runs WHERE id=${scope.runId}::uuid AND tenant_id=${scope.tenantId}::uuid AND website_id=${scope.websiteId}::uuid AND environment=${scope.environment} FOR UPDATE`;
      const run = await tx.securityRepairRun.findFirst({ where: { id: scope.runId, tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment } });
      // A terminal phase may persist its final synchronous checkpoint while the
      // controller still owns its lease. Cancellation/revocation fences version.
      if (!run) throw new SecurityWorkflowError('SECURITY_LEASE_LOST');
      await authorize(tx, run);
      const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
      if (!Number.isFinite(now.getTime())) throw new SecurityWorkflowError('SECURITY_CLOCK_INVALID');
      if (run.leaseOwnerId !== fence.ownerId || run.leaseVersion !== fence.version || !run.leaseExpiresAt || run.leaseExpiresAt <= now || run.expiresAt <= now) throw new SecurityWorkflowError('SECURITY_LEASE_LOST');
      return action(tx);
    }, { maxWait: 2000, timeout: 5000 });
  }
  return {
    async assertLease() { await current(async () => undefined); },
    async checkpoint(actual, id) {
      same(actual);
      return current(async tx => {
        const row = await tx.securityGraphCheckpoint.findFirst({ where: { ...where, ...(id ? { id } : {}) }, orderBy: { id: 'desc' } });
        return row ? { checkpointId: row.id, parentCheckpointId: row.parentId, encryptedEnvelope: row.encryptedEnvelope, digest: row.digest } : undefined;
      });
    },
    async checkpoints(actual, limit, before) {
      same(actual);
      return current(async tx => (await tx.securityGraphCheckpoint.findMany({ where: { ...where, ...(before ? { id: { lt: before } } : {}) }, orderBy: { id: 'desc' }, take: limit })).map(row => ({ checkpointId: row.id, parentCheckpointId: row.parentId, encryptedEnvelope: row.encryptedEnvelope, digest: row.digest })));
    },
    async putCheckpoint(actual, value) {
      same(actual);
      await current(async tx => {
        const prior = await tx.securityGraphCheckpoint.findFirst({ where: { ...where, id: value.checkpointId } });
        if (prior) {
          if (prior.digest !== value.digest || prior.parentId !== value.parentCheckpointId) throw new SecurityWorkflowError('SECURITY_CHECKPOINT_CONFLICT');
          return;
        }
        if (await tx.securityGraphCheckpoint.count({ where }) >= 2000) throw new SecurityWorkflowError('SECURITY_CHECKPOINT_QUOTA');
        await tx.securityGraphCheckpoint.create({ data: { ...where, id: value.checkpointId, parentId: value.parentCheckpointId, encryptedEnvelope: value.encryptedEnvelope, digest: value.digest } });
      });
    },
    async writes(actual, checkpointId) {
      same(actual);
      return current(async tx => {
        const rows = await tx.securityGraphWrite.findMany({ where: { ...where, checkpointId }, take: 1001 });
        if (rows.length > 1000) throw new SecurityWorkflowError('SECURITY_CHECKPOINT_QUOTA');
        return rows.map(row => ({ taskId: row.taskId, index: row.idx, taskPath: row.taskPath, encryptedEnvelope: row.encryptedEnvelope, digest: row.digest }));
      });
    },
    async putWrite(actual, checkpointId, value) {
      same(actual);
      await current(async tx => {
        const binding = { ...where, checkpointId, taskId: value.taskId, idx: value.index };
        const prior = await tx.securityGraphWrite.findFirst({ where: binding });
        if (prior && value.index >= 0) {
          if (prior.digest !== value.digest || prior.taskPath !== value.taskPath) throw new SecurityWorkflowError('SECURITY_CHECKPOINT_CONFLICT');
          return;
        }
        if (prior) await tx.securityGraphWrite.update({ where: { id: prior.id }, data: { encryptedEnvelope: value.encryptedEnvelope, digest: value.digest, taskPath: value.taskPath } });
        else {
          if (await tx.securityGraphWrite.count({ where }) >= 4000) throw new SecurityWorkflowError('SECURITY_CHECKPOINT_QUOTA');
          await tx.securityGraphWrite.create({ data: { ...binding, taskPath: value.taskPath, encryptedEnvelope: value.encryptedEnvelope, digest: value.digest } });
        }
      });
    }
  };
}
