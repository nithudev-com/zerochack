import type { Prisma } from '@prisma/client';
import { ApiError } from '../../errors.js';

type WebsiteScope = { tenantId: string; websiteId: string };
/** Caller must hold this website row FOR UPDATE in the same short transaction.
 * No environment filter: unresolved production/staging work shares one website.
 * STALE and OUTCOME_UNKNOWN deliberately retain the slot until reconciled. */
export async function hasSecurityRepairConflict(tx: Prisma.TransactionClient, scope: WebsiteScope): Promise<boolean> {
  return await tx.securityRepairRun.count({ where: { ...scope, phase: { notIn: ['COMPLETED', 'FAILED', 'CANCELLED'] } } }) > 0;
}
export async function assertNoSecurityRepairConflict(tx: Prisma.TransactionClient, scope: WebsiteScope): Promise<void> {
  if (await hasSecurityRepairConflict(tx, scope)) throw new ApiError(409, 'SECURITY_WEBSITE_WORK_CONFLICT', 'Finish or reconcile the existing security workflow before starting other work on this website.');
}
