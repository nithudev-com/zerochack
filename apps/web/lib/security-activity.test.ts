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
    expect(securityActivity(incomplete, false, false, false, null)?.state).toBe('blocked');
    expect(securityActivity(data('RUNNING', 'INTERRUPTED'), false, false, false, null)?.state).toBe('blocked');
    expect(securityActivity(data('FAILED', 'CANCELLED'), false, false, false, null)?.state).toBe('cancelled');
    expect(securityActivity(data('FAILED', 'FAILED'), false, false, false, null)?.state).toBe('failed');
  });
});
