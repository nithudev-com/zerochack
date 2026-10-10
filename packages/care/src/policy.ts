import { CareError } from './vault.js';
export const agentStates = ['QUEUED','RUNNING','WAITING_FOR_DEPENDENCY','WAITING_FOR_INPUT','AWAITING_APPROVAL','VERIFYING','COMPLETED','FAILED','CANCELLED','STALE'] as const;
export type AgentState = typeof agentStates[number];
export function visibleAgentState(state: string, heartbeatAt: Date, now = new Date()): string {
  return ['RUNNING', 'VERIFYING'].includes(state) && now.getTime() - heartbeatAt.getTime() > 90000 ? 'STALE' : state;
}
export const grantStates = ['PENDING','APPROVED','DENIED','REVOKED'] as const;
export function assertDisclosure(input: {
  specialistId: string; actorId: string; assignedSpecialistId: string | null; assignmentActive: boolean;
  status: string; expiresAt: Date; mfaVerifiedAt?: Date; credentialVersion: number; approvedVersion: number;
  credentialActive: boolean;
}, now = new Date()): void {
  if (input.specialistId !== input.actorId || input.assignedSpecialistId !== input.actorId || !input.assignmentActive) throw new CareError('DISCLOSURE_DENIED', 'An active assignment to this specialist is required.');
  if (input.status !== 'APPROVED' || input.expiresAt <= now || !input.credentialActive || input.credentialVersion !== input.approvedVersion) throw new CareError('GRANT_INVALID', 'Access was revoked, expired, or no longer matches this credential.');
  if (!input.mfaVerifiedAt || input.mfaVerifiedAt.getTime() < now.getTime() - 5 * 60000 || input.mfaVerifiedAt > now) throw new CareError('MFA_REQUIRED', 'Verify multi-factor authentication again before revealing access.');
}
export type ReleaseBinding = { digest: string; sourceRevision: string; environment: string; planVersion: number };
export function assertReleaseBinding(approved: ReleaseBinding, actual: ReleaseBinding, expiresAt: Date, now = new Date()): void {
  if (expiresAt <= now || !/^[a-f0-9]{64}$/.test(actual.digest) || (Object.keys(actual) as Array<keyof ReleaseBinding>).some((key) => actual[key] !== approved[key])) throw new CareError('APPROVAL_STALE', 'This approval does not match the current candidate and environment.');
}
export function assertToolScope(input: { enabled: boolean; environments: readonly string[]; permittedRoles: readonly string[] }, context: { environment: string; role: string; authorized: boolean }): void {
  if (!input.enabled || !context.authorized || !input.environments.includes(context.environment) || !input.permittedRoles.includes(context.role)) throw new CareError('TOOL_DENIED', 'This tool is unavailable for the current role, environment, or authorization.');
}
