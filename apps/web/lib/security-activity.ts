import type { SecurityAgentActivityProps } from '../components/security-agent-activity';

export type AssessmentActivity = { scan: null | { id: string; status: string; stage: string; updatedAt: string; errorCode: string | null; repairApplied: false; coverageState?: string; coverageLimitations?: string[]; scopeWarning?: string } };
function coverageReasons(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((reason): reason is string => typeof reason === 'string').map(reason => reason.trim()).filter(Boolean))] : [];
}

export function securityActivity(data: AssessmentActivity | undefined, failed: boolean, waiting: boolean, inspecting: boolean, previousScan: string | null): SecurityAgentActivityProps | null {
  if (waiting && !inspecting && (failed || data?.scan?.status !== 'RUNNING')) return { state: 'response_pending' };
  const scan = failed ? null : data?.scan;
  if (inspecting && (!scan || (scan.id === previousScan && scan.status !== 'RUNNING'))) return { state: 'response_pending', message: 'Inspection requested. Waiting for the server to confirm it started; no tool result is available yet.' };
  if (!scan) return null;
  const scopeWarning = typeof scan.scopeWarning === 'string' ? scan.scopeWarning.trim() : '';
  const scopeNotice = scopeWarning ? { scopeWarning } : {};
  if (scan.stage === 'INTERRUPTED') return { state: 'blocked', message: 'Saved inspection progress is overdue. Review its outcome before retrying; completion is not confirmed.' };
  if (scan.stage === 'CANCELLED') return { state: 'cancelled', message: 'Further inspection steps were cancelled. An in-flight read-only request may finish; no repair was authorized.' };
  if (scan.status === 'FAILED') return { state: 'failed', message: `Inspection stopped${scan.errorCode ? ` (${scan.errorCode.replaceAll('_', ' ').toLowerCase()})` : ''}. Review saved progress before retrying. No repair was applied.` };
  if (scan.status === 'SUCCEEDED') return scan.coverageState === 'INCOMPLETE'
    ? { state: 'completed_limited', coverageLimitations: coverageReasons(scan.coverageLimitations), ...scopeNotice }
    : { state: 'completed', message: 'The bounded inspection results are saved. Review findings and coverage; no repair was applied.', ...scopeNotice };
  if (scan.status !== 'RUNNING') return null;
  switch (scan.stage) {
    case 'CONNECTING': return { state: 'connecting' };
    case 'INSPECTING_SSH': return { state: 'inspecting_ssh' };
    case 'CHECKING_PUBLIC_SITE': return { state: 'checking_public_site' };
    case 'SAVING_EVIDENCE': return { state: 'saving_evidence' };
    default: return { state: 'running' };
  }
}
