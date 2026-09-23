export type RemediationGate = { tenantId: string; websiteId: string; ticketId: string; specialistId: string; authorization: { tenantId: string; websiteId: string; ticketId: string; scope: string[]; expiresAt: Date; revokedAt: Date | null }; backup: { tenantId: string; websiteId: string; ticketId: string | null; status: string; verifiedAt: Date | null }; session?: { tenantId: string; websiteId: string; ticketId: string; specialistId: string; scope: string[]; expiresAt: Date; revokedAt: Date | null; status: string }; requiredScopes: string[] };
export class RemediationGateError extends Error { constructor(public readonly code: string, message: string) { super(message); this.name = 'RemediationGateError'; } }
export function assertRemediationGate(gate: RemediationGate, now = new Date()): void {
  const same = [gate.authorization, gate.backup, ...(gate.session ? [gate.session] : [])].every((record) => record.tenantId === gate.tenantId && record.websiteId === gate.websiteId && record.ticketId === gate.ticketId);
  if (!same) throw new RemediationGateError('REMEDIATION_BINDING_MISMATCH', 'Authorization, backup, session, and ticket bindings must match');
  if (gate.authorization.revokedAt || gate.authorization.expiresAt <= now) throw new RemediationGateError('AUTHORIZATION_EXPIRED', 'Remediation authorization is expired or revoked');
  if (gate.backup.status !== 'SUCCEEDED' || !gate.backup.verifiedAt) throw new RemediationGateError('BACKUP_NOT_VERIFIED', 'A verified restore point is required');
  if (!gate.requiredScopes.every((scope) => gate.authorization.scope.includes(scope))) throw new RemediationGateError('AUTHORIZATION_SCOPE_DENIED', 'Authorization scope is insufficient');
  if (gate.session) {
    if (gate.session.specialistId !== gate.specialistId || gate.session.status !== 'ACTIVE' || gate.session.revokedAt || gate.session.expiresAt <= now) throw new RemediationGateError('REMEDIATION_SESSION_INVALID', 'Remediation session is expired, revoked, or belongs to another specialist');
    if (!gate.requiredScopes.every((scope) => gate.session!.scope.includes(scope))) throw new RemediationGateError('SESSION_SCOPE_DENIED', 'Session scope is insufficient');
  }
}
