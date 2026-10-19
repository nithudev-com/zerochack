import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { database } from '@zerochack/database';
import { SecurityWorkflowError, type ArtifactReceipt, type SecurityScope } from '@zerochack/security-orchestration';
import { createSecurityRepairJournal, type SecurityJournalOptions } from './journal.js';
import { assertSecurityWorkplaceTestDatabase } from './fixture-guard.test-helper.js';

const owned: Array<{ tenantId: string; actorId: string }> = [];
beforeAll(assertSecurityWorkplaceTestDatabase);
afterAll(async () => {
  for (const item of owned) {
    const where = { tenantId: item.tenantId };
    await database.securityRepairDecision.deleteMany({ where }); await database.securityGraphWrite.deleteMany({ where }); await database.securityGraphCheckpoint.deleteMany({ where });
    await database.securityRepairOutbox.deleteMany({ where }); await database.securityRepairCostEntry.deleteMany({ where }); await database.securityRepairAttempt.deleteMany({ where });
    await database.securityRepairRun.deleteMany({ where }); await database.careArtifact.deleteMany({ where }); await database.tenant.delete({ where: { id: item.tenantId } }); await database.user.delete({ where: { id: item.actorId } });
  }
  await database.$disconnect();
});
/** Synthetic completed receipts isolate business-journal admission. These are
 * explicitly not encrypted managed recovery, SSH execution or repair evidence. */
async function fixture(registered = true, admitted = true) {
  const tenant = await database.tenant.create({ data: { name: 'Staging journal policy fixture', slug: `staging-journal-${randomUUID()}` } });
  const actor = await database.user.create({ data: { email: `${randomUUID()}@example.test`, status: 'APPROVED', emailVerifiedAt: new Date() } }); owned.push({ tenantId: tenant.id, actorId: actor.id });
  const session = await database.session.create({ data: { tenantId: tenant.id, userId: actor.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 3600000) } });
  const website = await database.website.create({ data: { tenantId: tenant.id, name: 'Disposable staging journal fixture', url: 'https://journal-product.example.test/', normalizedHost: 'journal-product.example.test' } });
  const scope: SecurityScope = { tenantId: tenant.id, websiteId: website.id, environment: 'STAGING', runId: randomUUID() };
  async function artifact(name: string): Promise<ArtifactReceipt> {
    const digest = createHash('sha256').update(`${scope.runId}:${name}`).digest('hex');
    const row = await database.careArtifact.create({ data: { tenantId: tenant.id, websiteId: website.id, environment: 'STAGING', kind: name === 'admission' ? 'SEC_ADMISSION' : 'REPORT', filename: `${name}.json`, contentType: 'application/json', status: 'ACCEPTED', digest, sizeBytes: 2, encryptedBody: 'synthetic-journal-metadata-only-not-recovery', createdBy: actor.id } });
    return { artifactId: row.id, digest };
  }
  const admission = await artifact('admission'); const checked: string[] = []; let settleAllowed = true;
  const policy: SecurityJournalOptions['stagingMutation'] = { profile: 'MANAGED_STATIC_PERMISSION_V1', async assertReady(_tx, actual, run, action) {
    if (actual.runId !== scope.runId || run.actorId !== actor.id || run.sessionId !== session.id || run.admissionArtifactId !== admission.artifactId || run.admissionDigest !== admission.digest) throw new SecurityWorkflowError('SECURITY_TEST_ADMISSION_DENIED');
    checked.push(action); if (action === 'SETTLE' && !settleAllowed) throw new SecurityWorkflowError('SECURITY_TEST_RECEIPT_DENIED');
  } };
  const journal = createSecurityRepairJournal({ database, async assertAuthority(_tx, actual) { if (actual.runId !== scope.runId || actual.tenantId !== tenant.id || actual.websiteId !== website.id) throw new SecurityWorkflowError('SECURITY_TEST_SCOPE_DENIED'); }, ...(registered ? { stagingMutation: policy } : {}) });
  await journal.createRun({ ...scope, actorId: actor.id, sessionId: session.id, requestKey: randomUUID(), inputDigest: 'a'.repeat(64), authorityDigest: 'b'.repeat(64), allowanceMicros: 0, expiresAt: new Date(Date.now() + 600000), ...(admitted ? { admissionArtifactId: admission.artifactId, admissionDigest: admission.digest, executionProfile: 'MANAGED_STATIC_PERMISSION_V1' as const } : {}) });
  let fence = await journal.claimRun(scope, randomUUID());
  async function step(name: string) {
    const begun = await journal.beginStep(scope, fence, { stepKey: name, kind: 'READ', inputDigest: createHash('sha256').update(name).digest('hex'), reserveMicros: 0 }); if (begun.outcome !== 'STARTED') throw new Error('Fixture receipt must be new');
    const receipt = await artifact(name); await journal.completeStep(scope, fence, begun.attemptId, { ...receipt, costMicros: 0 }); return receipt;
  }
  const plan = await step('plan'); await journal.transition(scope, fence, 'AWAITING_APPROVAL'); await journal.releaseLease(scope, fence);
  await journal.recordCandidateDecision(scope, { ...plan, actorId: actor.id, sessionId: session.id, requestKey: randomUUID(), status: 'APPROVED' });
  fence = await journal.claimRun(scope, randomUUID());
  for (const [phase, name] of [['SNAPSHOTTING', 'snapshot'], ['CANDIDATE_WORK', 'candidate'], ['VERIFYING', 'verify']] as const) { await journal.transition(scope, fence, phase); await step(name); }
  await journal.transition(scope, fence, 'READY_FOR_RELEASE'); const proposal = await step('proposal');
  await journal.transition(scope, fence, 'AWAITING_APPROVAL'); await journal.releaseLease(scope, fence);
  const decisionInput = (status: 'APPROVED' | 'DENIED' = 'APPROVED') => ({ ...proposal, actorId: actor.id, sessionId: session.id, requestKey: randomUUID(), status });
  return { actor, session, scope, journal, artifact, checked, decisionInput, proposal, plan, setSettleAllowed(value: boolean) { settleAllowed = value; } };
}
describe.sequential('managed STAGING journal mutation boundary with synthetic receipts only', () => {
  it('keeps generic/default journals and unadmitted runs unable to record change authorization', async () => {
    const generic = await fixture(false); await expect(generic.journal.recordChangeDecision(generic.scope, generic.decisionInput())).rejects.toMatchObject({ code: 'UNREGISTERED_SECURITY_EXECUTOR' });
    const unadmitted = await fixture(true, false); await expect(unadmitted.journal.recordChangeDecision(unadmitted.scope, unadmitted.decisionInput())).rejects.toMatchObject({ code: 'UNREGISTERED_SECURITY_EXECUTOR' });
    expect(await database.securityRepairDecision.count({ where: { runId: unadmitted.scope.runId, kind: 'PRODUCTION' } })).toBe(0);
  });
  it('rejects changed actor/session or proposal digest before storing an exact change decision', async () => {
    const f = await fixture();
    await expect(f.journal.recordChangeDecision(f.scope, { ...f.decisionInput(), sessionId: randomUUID() })).rejects.toMatchObject({ code: 'SECURITY_ACTOR_BINDING_CHANGED' });
    await expect(f.journal.recordChangeDecision(f.scope, { ...f.decisionInput(), digest: 'f'.repeat(64) })).rejects.toMatchObject({ code: 'SECURITY_DECISION_RECEIPT_CHANGED' });
    const input = f.decisionInput(); const id = await f.journal.recordChangeDecision(f.scope, input); expect(await f.journal.recordChangeDecision(f.scope, input)).toBe(id);
    await expect(f.journal.recordChangeDecision(f.scope, { ...input, status: 'DENIED' })).rejects.toMatchObject({ code: 'SECURITY_DECISION_BINDING_CHANGED' });
  });
  it('does not admit an apply effect after an exact change denial or expiry', async () => {
    const denied = await fixture(); await denied.journal.recordChangeDecision(denied.scope, denied.decisionInput('DENIED')); const fence = await denied.journal.claimRun(denied.scope, randomUUID());
    await expect(denied.journal.transition(denied.scope, fence, 'APPLYING')).rejects.toMatchObject({ code: 'SECURITY_DECISION_BINDING_CHANGED' });
    expect(await database.securityRepairAttempt.count({ where: { runId: denied.scope.runId, stepKey: 'apply' } })).toBe(0);
    const expired = await fixture(); const id = await expired.journal.recordChangeDecision(expired.scope, expired.decisionInput()); const now = Date.now();
    await database.securityRepairDecision.update({ where: { id }, data: { createdAt: new Date(now - 2000), expiresAt: new Date(now - 1000) } });
    const fresh = await expired.journal.claimRun(expired.scope, randomUUID()); await expect(expired.journal.transition(expired.scope, fresh, 'APPLYING')).rejects.toMatchObject({ code: 'SECURITY_DECISION_EXPIRED' });
  });
  it('requires the registered staging policy for apply admission and result settlement while retaining production refusal', async () => {
    const f = await fixture(); await f.journal.recordChangeDecision(f.scope, f.decisionInput()); const fence = await f.journal.claimRun(f.scope, randomUUID());
    await f.journal.transition(f.scope, fence, 'APPLYING');
    await expect(f.journal.beginStep(f.scope, fence, { stepKey: 'apply', kind: 'PRODUCTION_WRITE', inputDigest: 'c'.repeat(64), reserveMicros: 0 })).rejects.toMatchObject({ code: 'UNREGISTERED_SECURITY_EXECUTOR' });
    const begun = await f.journal.beginStep(f.scope, fence, { stepKey: 'apply', kind: 'STAGING_WRITE', inputDigest: 'c'.repeat(64), reserveMicros: 0 }); if (begun.outcome !== 'STARTED') throw new Error('Fixture must start once');
    const result = await f.artifact('synthetic-apply-result'); f.setSettleAllowed(false);
    await expect(f.journal.completeStep(f.scope, fence, begun.attemptId, { ...result, costMicros: 0 })).rejects.toMatchObject({ code: 'SECURITY_TEST_RECEIPT_DENIED' });
    expect((await database.securityRepairAttempt.findUniqueOrThrow({ where: { id: begun.attemptId } })).state).toBe('STARTED');
    f.setSettleAllowed(true); await f.journal.completeStep(f.scope, fence, begun.attemptId, { ...result, costMicros: 0 });
    expect(f.checked).toContain('DECIDE'); expect(f.checked).toContain('APPLY'); expect(f.checked).toContain('SETTLE');
    expect((await database.securityRepairAttempt.findUniqueOrThrow({ where: { id: begun.attemptId } })).state).toBe('SUCCEEDED');
  });
});
