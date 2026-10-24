import { describe, expect, it } from 'vitest';
import { securityActivity, type AssessmentActivity } from './security-activity';
const data = (status = 'RUNNING', stage = 'INSPECTING_SSH'): AssessmentActivity => ({ scan: { id: 'real-scan', status, stage, updatedAt: new Date().toISOString(), errorCode: null, repairApplied: false } });
describe('truthful security activity', () => {
  it('never claims tools from a pending model response or unconfirmed request', () => {
    expect(securityActivity({ scan: null }, false, true, false, null)).toEqual({ state: 'response_pending' });
    expect(securityActivity(data(), false, true, false, null)?.state).toBe('inspecting_ssh');
    expect(securityActivity(data(), true, true, false, null)?.state).toBe('response_pending');
    expect(securityActivity(undefined, false, true, true, null)?.state).toBe('response_pending');
    expect(securityActivity(data('SUCCEEDED', 'COMPLETED'), false, true, true, 'real-scan')?.state).toBe('response_pending');
  });
  it('maps only server-confirmed stages and never invents a repair', () => {
    for (const [stage, state] of [['CONNECTING', 'connecting'], ['INSPECTING_SSH', 'inspecting_ssh'], ['CHECKING_PUBLIC_SITE', 'checking_public_site'], ['SAVING_EVIDENCE', 'saving_evidence'], ['unknown', 'running']]) expect(securityActivity(data('RUNNING', stage), false, false, false, null)?.state).toBe(state);
    expect(securityActivity(data('SUCCEEDED', 'COMPLETED'), false, false, false, null)?.message).toContain('no repair');
  });
  it('clears stale data on errors and distinguishes incomplete, interrupted, cancelled and failed', () => {
    expect(securityActivity(data(), true, false, false, null)).toBeNull();
    const incomplete = data('SUCCEEDED', 'COMPLETED'); incomplete.scan!.coverageState = 'INCOMPLETE';
    expect(securityActivity(incomplete, false, false, false, null)?.state).toBe('completed_limited');
    expect(securityActivity(data('RUNNING', 'INTERRUPTED'), false, false, false, null)?.state).toBe('blocked');
    expect(securityActivity(data('FAILED', 'CANCELLED'), false, false, false, null)?.state).toBe('cancelled');
    expect(securityActivity(data('FAILED', 'FAILED'), false, false, false, null)?.state).toBe('failed');
  });
  it('preserves real limited-coverage reasons as normalized text without creating a blocked or repaired result', () => {
    const incomplete = data('SUCCEEDED', 'COMPLETED'); incomplete.scan!.coverageState = 'INCOMPLETE';
    incomplete.scan!.coverageLimitations = ['  Antivirus did not complete.  ', '', 'Antivirus did not complete.', '  ', '<script>literal recorded text</script>', null] as unknown as string[];
    expect(securityActivity(incomplete, false, false, false, null)).toEqual({ state: 'completed_limited', coverageLimitations: ['Antivirus did not complete.', '<script>literal recorded text</script>'] });
  });
  it('does not invent reasons when a limited-coverage record has no detailed explanation', () => {
    const incomplete = data('SUCCEEDED', 'COMPLETED'); incomplete.scan!.coverageState = 'INCOMPLETE';
    expect(securityActivity(incomplete, false, false, false, null)).toEqual({ state: 'completed_limited', coverageLimitations: [] });
    incomplete.scan!.coverageLimitations = 'not a reason array' as unknown as string[];
    expect(securityActivity(incomplete, false, false, false, null)).toEqual({ state: 'completed_limited', coverageLimitations: [] });
  });
  it('forwards a recorded historical scope warning without inventing one for fresh results', () => {
    const completed = data('SUCCEEDED', 'COMPLETED'); const warning = 'This historical inspection was not limited to the selected website.';
    expect(securityActivity(completed, false, false, false, null)).not.toHaveProperty('scopeWarning');
    completed.scan!.scopeWarning = `  ${warning}  `;
    expect(securityActivity(completed, false, false, false, null)).toMatchObject({ state: 'completed', scopeWarning: warning });
    completed.scan!.coverageState = 'INCOMPLETE';
    expect(securityActivity(completed, false, false, false, null)).toMatchObject({ state: 'completed_limited', scopeWarning: warning });
    expect(securityActivity(completed, true, false, false, null)).toBeNull();
  });
});
