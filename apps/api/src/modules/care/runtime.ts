import type { Prisma } from '@prisma/client';
import type { Environment } from '@zerochack/config';

export const vaultKey = (environment: Environment) => environment.CARE_VAULT_KEY ?? environment.INTEGRATION_CREDENTIAL_ENCRYPTION_KEY;
export async function careEvent(tx: Prisma.TransactionClient, scope: { tenantId: string; websiteId: string; environment: string }, eventType: string, state: string, summary: string, refs?: { jobId?: string; agentRunId?: string }) {
  return tx.careEvent.create({ data: { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, ...refs, eventType, state, summary } });
}
