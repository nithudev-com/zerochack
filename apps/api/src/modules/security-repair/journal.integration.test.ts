import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { database } from '@zerochack/database';
import { type SecurityScope, SecurityWorkflowError } from '@zerochack/security-orchestration';
import { createSecurityRepairJournal } from './journal.js';
import { assertSecurityWorkplaceTestDatabase } from './fixture-guard.test-helper.js';

const fixtures: Array<{ tenantId: string; actorId: string }> = [];
const digest = 'a'.repeat(64);
beforeAll(assertSecurityWorkplaceTestDatabase);
afterAll(async () => {
  // Explicit child-first deletion is limited to this file's unique fixtures.
  // The run->website NoAction relation deliberately prevents accidental history loss.
  for (const { tenantId, actorId } of fixtures) {
    const where = { tenantId };
    await database.securityGraphWrite.deleteMany({ where });
    await database.securityGraphCheckpoint.deleteMany({ where });
    await database.securityRepairOutbox.deleteMany({ where });
    await database.securityRepairDecision.deleteMany({ where });
    await database.securityRepairCostEntry.deleteMany({ where });
    await database.securityRepairAttempt.deleteMany({ where });
    await database.securityRepairRun.deleteMany({ where });
    await database.tenant.delete({ where: { id: tenantId } });
    await database.user.delete({ where: { id: actorId } });
  }
  await database.$disconnect();
});
async function fixture() {
  let now = new Date();
  const tenant = await database.tenant.create({ data: { name: 'Security journal fixture', slug: `security-journal-${randomUUID()}` } });
  const actor = await database.user.create({ data: { email: `${randomUUID()}@example.test`, status: 'APPROVED', emailVerifiedAt: now, mfaEnabledAt: now } });
  fixtures.push({ tenantId: tenant.id, actorId: actor.id });
  await database.tenantMembership.create({ data: { tenantId: tenant.id, userId: actor.id, status: 'ACTIVE' } });
  const session = await database.session.create({ data: { tenantId: tenant.id, userId: actor.id, tokenHash: randomUUID(), expiresAt: new Date(now.getTime() + 3_600_000), mfaVerifiedAt: now } });
  const site = await database.website.create({ data: { tenantId: tenant.id, name: 'Selected fixture only', url: 'https://example.test/', normalizedHost: 'example.test' } });
  const scope: SecurityScope = { tenantId: tenant.id, websiteId: site.id, environment: 'STAGING', runId: randomUUID() };
  const authorityCalls: string[] = [];
  const journal = createSecurityRepairJournal({
    database, leaseMs: 1000, now: () => now,
    async assertAuthority(tx, requested, operation) {
      authorityCalls.push(operation);
      if (requested.tenantId !== tenant.id || requested.websiteId !== site.id) throw new SecurityWorkflowError('TEST_AUTHORITY_DENIED');
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${actor.id}::uuid FOR SHARE`;
      await tx.$queryRaw`SELECT id FROM sessions WHERE id = ${session.id}::uuid FOR SHARE`;
      const user = await tx.user.findUniqueOrThrow({ where: { id: actor.id } });
      const current = await tx.session.findUniqueOrThrow({ where: { id: session.id } });
      const membership = await tx.tenantMembership.findUniqueOrThrow({ where: { tenantId_userId: { tenantId: tenant.id, userId: actor.id } } });
      if (user.status !== 'APPROVED' || !user.mfaEnabledAt || membership.status !== 'ACTIVE' || current.revokedAt || current.expiresAt <= now || !current.mfaVerifiedAt) throw new SecurityWorkflowError('TEST_AUTHORITY_DENIED');
    }
  });
  const input = { ...scope, actorId: actor.id, sessionId: session.id, requestKey: randomUUID(), inputDigest: digest, authorityDigest: 'b'.repeat(64), allowanceMicros: 100, expiresAt: new Date(now.getTime() + 60_000) };
  return { scope, input, journal, actorId: actor.id, sessionId: session.id, authorityCalls, advance(ms: number) { now = new Date(now.getTime() + ms); } };
}
async function started() {
  const value = await fixture();
  await value.journal.createRun(value.input);
  return { ...value, fence: await value.journal.claimRun(value.scope, randomUUID()) };
}
async function acceptedArtifact(scope: SecurityScope, actorId: string, overrides: { environment?: string; digest?: string; expiresAt?: Date; status?: string } = {}) {
  return database.careArtifact.create({ data: { tenantId: scope.tenantId, websiteId: scope.websiteId, environment: scope.environment, kind: 'REPORT', filename: 'synthetic-report.json', contentType: 'application/json', status: 'ACCEPTED', digest, sizeBytes: 2, encryptedBody: 'synthetic-not-recovery-proof', createdBy: actorId, ...overrides } });
}
const step = { stepKey: 'plan', kind: 'MODEL' as const, inputDigest: digest, reserveMicros: 60 };
async function waiting(expiresInMs = 60_000) {
  const f = await fixture();
  f.input.expiresAt = new Date(f.input.expiresAt.getTime() - 60_000 + expiresInMs);
  await f.journal.createRun(f.input);
  const fence = await f.journal.claimRun(f.scope, randomUUID());
  const attempt = await f.journal.beginStep(f.scope, fence, { ...step, kind: 'READ', reserveMicros: 0 });
  if (attempt.outcome !== 'STARTED') throw new Error('New plan attempt required');
  const artifact = await acceptedArtifact(f.scope, f.actorId);
  const receipt = { artifactId: artifact.id, digest };
  await f.journal.completeStep(f.scope, fence, attempt.attemptId, { ...receipt, costMicros: 0 });
  await f.journal.transition(f.scope, fence, 'AWAITING_APPROVAL');
  await f.journal.releaseLease(f.scope, fence);
  return { ...f, fence, artifact, receipt, decision: { ...receipt, actorId: f.actorId, sessionId: f.sessionId, requestKey: randomUUID(), status: 'APPROVED' as const } };
}

describe.sequential('dormant security repair journal with real disposable PostgreSQL transactions', () => {
  it('does not retry a transaction or claim success when the database rolls back after journal writes', async () => {
    const f = await fixture();
    const original = database.$transaction.bind(database);
    let calls = 0;
    const replacement = vi.spyOn(database, '$transaction').mockImplementationOnce(callback => original(async tx => {
      if (typeof callback !== 'function') throw new Error('Interactive transaction required');
      calls++;
      await callback(tx);
      throw new Error('Synthetic transaction failure after writes');
    }));
    try { await expect(f.journal.createRun(f.input)).rejects.toThrow('Synthetic transaction failure'); }
    finally { replacement.mockRestore(); }
    expect(calls).toBe(1);
    expect(await database.securityRepairRun.count({ where: { id: f.scope.runId } })).toBe(0);
    expect(await database.securityRepairOutbox.count({ where: { runId: f.scope.runId } })).toBe(0);
    await f.journal.createRun(f.input);
  });
  it('creates once, returns the exact idempotent request and rejects changed bindings without another outbox event', async () => {
    const f = await fixture();
    expect(await f.journal.createRun(f.input)).toMatchObject({ id: f.scope.runId, phase: 'PLANNING' });
    expect((await f.journal.createRun(f.input)).id).toBe(f.scope.runId);
    await expect(f.journal.createRun({ ...f.input, inputDigest: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'SECURITY_REQUEST_BINDING_CHANGED' });
    await expect(f.journal.createRun({ ...f.input, runId: randomUUID() })).rejects.toMatchObject({ code: 'SECURITY_REQUEST_BINDING_CHANGED' });
    expect(await database.securityRepairRun.count({ where: { tenantId: f.scope.tenantId } })).toBe(1);
    expect(await database.securityRepairOutbox.count({ where: { runId: f.scope.runId } })).toBe(1);
    expect(f.authorityCalls).toEqual(['CREATE', 'CREATE', 'CREATE', 'CREATE']);
  });
  it('serializes competing site admissions across environments and preserves the first run', async () => {
    const f = await fixture();
    const results = await Promise.allSettled([
      f.journal.createRun(f.input),
      f.journal.createRun({ ...f.input, environment: 'PRODUCTION', runId: randomUUID(), requestKey: randomUUID() })
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await database.securityRepairRun.count({ where: { tenantId: f.scope.tenantId } })).toBe(1);
  });
  it('fences claims and heartbeat with the persisted lease, not caller-supplied future timestamps', async () => {
    const f = await started();
    await expect(f.journal.claimRun(f.scope, randomUUID())).rejects.toMatchObject({ code: 'SECURITY_LEASE_BUSY' });
    await expect(f.journal.heartbeat(f.scope, { ...f.fence, ownerId: randomUUID() })).rejects.toMatchObject({ code: 'SECURITY_LEASE_LOST' });
    f.advance(500);
    const heartbeat = await f.journal.heartbeat(f.scope, f.fence);
    expect(heartbeat.version).toBe(f.fence.version);
    expect(heartbeat.expiresAt.getTime()).toBeGreaterThan(f.fence.expiresAt.getTime());
    f.advance(1100);
    await expect(f.journal.heartbeat(f.scope, { ...heartbeat, expiresAt: new Date(Date.now() + 99_000) })).rejects.toMatchObject({ code: 'SECURITY_LEASE_LOST' });
    const next = await f.journal.claimRun(f.scope, randomUUID());
    expect(next.version).toBe(f.fence.version + 1);
    await expect(f.journal.beginStep(f.scope, f.fence, step)).rejects.toMatchObject({ code: 'SECURITY_LEASE_LOST' });
  });
  it('releases a quiescent checkpointed lease for immediate resume and rejects its old owner', async () => {
    const f = await started();
    await f.journal.transition(f.scope, f.fence, 'AWAITING_APPROVAL');
    expect(await f.journal.releaseLease(f.scope, f.fence)).toMatchObject({ leaseOwnerId: null, leaseExpiresAt: null, leaseVersion: f.fence.version + 1 });
    const resumed = await f.journal.claimRun(f.scope, randomUUID());
    expect(resumed.version).toBe(f.fence.version + 2);
    await expect(f.journal.beginStep(f.scope, f.fence, step)).rejects.toMatchObject({ code: 'SECURITY_LEASE_LOST' });
    await f.journal.beginStep(f.scope, resumed, step);
    await expect(f.journal.releaseLease(f.scope, resumed)).rejects.toMatchObject({ code: 'SECURITY_EFFECT_UNRESOLVED' });
    expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ leaseOwnerId: resumed.ownerId });
  });
  it('records the effect reservation before a caller can act and refuses pending replay or concurrent steps', async () => {
    const f = await started();
    const result = await f.journal.beginStep(f.scope, f.fence, step);
    expect(result.outcome).toBe('STARTED');
    await expect(f.journal.beginStep(f.scope, f.fence, step)).rejects.toMatchObject({ code: 'SECURITY_EFFECT_UNRESOLVED' });
    await expect(f.journal.beginStep(f.scope, f.fence, { ...step, stepKey: 'other' })).rejects.toMatchObject({ code: 'SECURITY_EFFECT_UNRESOLVED' });
    expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(1);
    expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'RESERVE' } })).toBe(1);
    expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ reservedMicros: 60, chargedMicros: 0 });
  });
  it('settles exactly once, returns a retained completed receipt and rejects step/receipt drift', async () => {
    const f = await started();
    const attempt = await f.journal.beginStep(f.scope, f.fence, step);
    if (attempt.outcome !== 'STARTED') throw new Error('New attempt required');
    const artifact = await acceptedArtifact(f.scope, f.actorId);
    const receipt = { artifactId: artifact.id, digest: artifact.digest, costMicros: 30 };
    await f.journal.completeStep(f.scope, f.fence, attempt.attemptId, receipt);
    await f.journal.completeStep(f.scope, f.fence, attempt.attemptId, receipt);
    expect(await f.journal.beginStep(f.scope, f.fence, step)).toEqual({ outcome: 'SUCCEEDED', artifact: { artifactId: artifact.id, digest }, costMicros: 30 });
    await expect(f.journal.beginStep(f.scope, f.fence, { ...step, inputDigest: 'd'.repeat(64) })).rejects.toMatchObject({ code: 'SECURITY_STEP_BINDING_CHANGED' });
    await expect(f.journal.completeStep(f.scope, f.fence, attempt.attemptId, { ...receipt, costMicros: 31 })).rejects.toMatchObject({ code: 'SECURITY_RECEIPT_BINDING_CHANGED' });
    expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ reservedMicros: 0, chargedMicros: 30 });
    const entries = await database.securityRepairCostEntry.findMany({ where: { runId: f.scope.runId } });
    expect(entries).toHaveLength(2);
    expect(entries.reduce((sum, entry) => sum + entry.reservedDeltaMicros, 0)).toBe(0);
    expect(entries.reduce((sum, entry) => sum + entry.chargedDeltaMicros, 0)).toBe(30);
    expect(await database.securityRepairOutbox.count({ where: { runId: f.scope.runId, eventType: 'step.completed' } })).toBe(1);
  });
  it('rejects foreign-environment, quarantined, expired and mismatched artifact metadata without settling costs', async () => {
    const f = await started();
    const attempt = await f.journal.beginStep(f.scope, f.fence, step);
    if (attempt.outcome !== 'STARTED') throw new Error('New attempt required');
    for (const overrides of [{ environment: 'PRODUCTION' }, { status: 'QUARANTINED' }, { expiresAt: new Date(0) }, { digest: 'c'.repeat(64) }]) {
      const artifact = await acceptedArtifact(f.scope, f.actorId, overrides);
      await expect(f.journal.completeStep(f.scope, f.fence, attempt.attemptId, { artifactId: artifact.id, digest, costMicros: 30 })).rejects.toMatchObject({ code: 'SECURITY_ARTIFACT_UNAVAILABLE' });
    }
    expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ reservedMicros: 60, chargedMicros: 0 });
    expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'SETTLE' } })).toBe(0);
  });
  it('re-reads authority before accepting results; revocation preserves the unfinished reservation and produces no completion', async () => {
    const f = await started();
    const attempt = await f.journal.beginStep(f.scope, f.fence, step);
    if (attempt.outcome !== 'STARTED') throw new Error('New attempt required');
    const artifact = await acceptedArtifact(f.scope, f.actorId);
    await database.session.update({ where: { id: f.sessionId }, data: { revokedAt: new Date() } });
    await expect(f.journal.completeStep(f.scope, f.fence, attempt.attemptId, { artifactId: artifact.id, digest, costMicros: 30 })).rejects.toMatchObject({ code: 'TEST_AUTHORITY_DENIED' });
    expect(await database.securityRepairAttempt.findUniqueOrThrow({ where: { id: attempt.attemptId } })).toMatchObject({ state: 'STARTED' });
    expect(await database.securityRepairOutbox.count({ where: { runId: f.scope.runId, eventType: 'step.completed' } })).toBe(0);
  });
  it('bounds cost reservations and rejects unregistered production/recovery writes before any attempt', async () => {
    const f = await started();
    await expect(f.journal.beginStep(f.scope, f.fence, { ...step, reserveMicros: 101 })).rejects.toMatchObject({ code: 'SECURITY_BUDGET_EXCEEDED' });
    await expect(f.journal.beginStep(f.scope, f.fence, { ...step, reserveMicros: 0 })).rejects.toMatchObject({ code: 'SECURITY_BUDGET_REQUIRED' });
    for (const kind of ['PRODUCTION_WRITE', 'RECOVERY_WRITE'] as const) await expect(f.journal.beginStep(f.scope, f.fence, { ...step, kind })).rejects.toMatchObject({ code: 'UNREGISTERED_SECURITY_EXECUTOR' });
    await expect(f.journal.transition(f.scope, f.fence, 'APPLYING')).rejects.toMatchObject({ code: 'UNREGISTERED_SECURITY_EXECUTOR' });
    expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(0);
    expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ reservedMicros: 0, chargedMicros: 0 });
  });
  it('settles known actual overrun once, truthfully exceeds the allowance and stops/fences all further work', async () => {
    const f = await started();
    const attempt = await f.journal.beginStep(f.scope, f.fence, step);
    if (attempt.outcome !== 'STARTED') throw new Error('New attempt required');
    const artifact = await acceptedArtifact(f.scope, f.actorId);
    const receipt = { artifactId: artifact.id, digest, costMicros: 120 };
    await expect(f.journal.completeStep(f.scope, f.fence, attempt.attemptId, receipt)).rejects.toMatchObject({ code: 'SECURITY_BUDGET_EXCEEDED' });
    expect(await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } })).toMatchObject({ phase: 'FAILED', errorCode: 'SECURITY_BUDGET_EXCEEDED', allowanceMicros: 100, reservedMicros: 0, chargedMicros: 120, leaseOwnerId: null });
    expect(await database.securityRepairAttempt.findUniqueOrThrow({ where: { id: attempt.attemptId } })).toMatchObject({ state: 'SUCCEEDED', costMicros: 120 });
    await expect(f.journal.completeStep(f.scope, f.fence, attempt.attemptId, receipt)).rejects.toMatchObject({ code: 'SECURITY_RUN_NOT_ACTIVE' });
    expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'SETTLE' } })).toBe(1);
    await expect(f.journal.beginStep(f.scope, f.fence, { ...step, stepKey: 'another' })).rejects.toMatchObject({ code: 'SECURITY_RUN_NOT_ACTIVE' });
  });
  it('bounds retained attempts even for zero-cost reads', async () => {
    const f = await started();
    const artifact = await acceptedArtifact(f.scope, f.actorId);
    // Synthetic retained receipts exercise the durable row-count boundary without 64 external effects.
    await database.securityRepairAttempt.createMany({ data: Array.from({ length: 64 }, (_, index) => ({
      tenantId: f.scope.tenantId, websiteId: f.scope.websiteId, environment: f.scope.environment, runId: f.scope.runId,
      stepKey: `retained.${index}`, kind: 'READ', inputDigest: digest, leaseVersion: f.fence.version,
      reserveMicros: 0, costMicros: 0, state: 'SUCCEEDED', artifactId: artifact.id, artifactDigest: digest, completedAt: new Date()
    })) });
    await expect(f.journal.beginStep(f.scope, f.fence, { stepKey: 'new.read', kind: 'READ', inputDigest: digest, reserveMicros: 0 })).rejects.toMatchObject({ code: 'SECURITY_JOURNAL_LIMIT' });
    expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(64);
  });
  it('observes an expired lease without mutation or replay and cannot claim unfinished work', async () => {
    const f = await started();
    await f.journal.beginStep(f.scope, f.fence, step); f.advance(1100);
    const before = await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } });
    expect(await f.journal.recoverExpired(f.scope)).toMatchObject({ phase: 'PLANNING', expiredLease: true, unfinishedAttempts: 1, reservedMicros: 60, replayAllowed: false });
    await expect(f.journal.claimRun(f.scope, randomUUID())).rejects.toMatchObject({ code: 'SECURITY_EFFECT_UNRESOLVED' });
    const after = await database.securityRepairRun.findUniqueOrThrow({ where: { id: f.scope.runId } });
    expect(after).toEqual(before);
  });
  it('cancels unfinished work as OUTCOME_UNKNOWN, retains costs/site slot and never treats cancellation as known no-effect', async () => {
    const f = await started();
    await f.journal.beginStep(f.scope, f.fence, step);
    const actor = { actorId: f.actorId, sessionId: f.sessionId };
    expect(await f.journal.stopRun(f.scope, actor)).toMatchObject({ phase: 'OUTCOME_UNKNOWN', reservedMicros: 60, chargedMicros: 0, leaseOwnerId: null });
    await f.journal.stopRun(f.scope, actor);
    expect(await database.securityRepairCostEntry.count({ where: { runId: f.scope.runId, kind: 'UNKNOWN' } })).toBe(1);
    expect(await database.securityRepairOutbox.count({ where: { runId: f.scope.runId, eventType: 'run.stopped' } })).toBe(1);
    await expect(f.journal.createRun({ ...f.input, environment: 'PRODUCTION', requestKey: randomUUID(), runId: randomUUID() })).rejects.toMatchObject({ code: 'SECURITY_WEBSITE_WORK_CONFLICT' });
    await expect(f.journal.claimRun(f.scope, randomUUID())).rejects.toMatchObject({ code: 'SECURITY_RUN_NOT_ACTIVE' });
  });
  it('cancels a no-effect run, fences the old owner and allows a separate explicit new run', async () => {
    const f = await started();
    await expect(f.journal.stopRun(f.scope, { actorId: randomUUID(), sessionId: f.sessionId })).rejects.toMatchObject({ code: 'SECURITY_ACTOR_BINDING_CHANGED' });
    expect(await f.journal.stopRun(f.scope, { actorId: f.actorId, sessionId: f.sessionId })).toMatchObject({ phase: 'CANCELLED', reservedMicros: 0 });
    await expect(f.journal.beginStep(f.scope, f.fence, step)).rejects.toMatchObject({ code: 'SECURITY_RUN_NOT_ACTIVE' });
    const next = { ...f.input, requestKey: randomUUID(), runId: randomUUID() };
    expect((await f.journal.createRun(next)).id).toBe(next.runId);
  });
  it('rejects skipped transitions and prevents terminal labels while an effect is unresolved', async () => {
    const f = await started();
    await expect(f.journal.transition(f.scope, f.fence, 'COMPLETED')).rejects.toMatchObject({ code: 'SECURITY_TRANSITION_INVALID' });
    await f.journal.transition(f.scope, f.fence, 'AWAITING_APPROVAL');
    const events = await database.securityRepairOutbox.count({ where: { runId: f.scope.runId } });
    await f.journal.transition(f.scope, f.fence, 'AWAITING_APPROVAL');
    expect(await database.securityRepairOutbox.count({ where: { runId: f.scope.runId } })).toBe(events);
    await f.journal.beginStep(f.scope, f.fence, step);
    await expect(f.journal.transition(f.scope, f.fence, 'FAILED')).rejects.toMatchObject({ code: 'SECURITY_EFFECT_UNRESOLVED' });
    expect(await f.journal.transition(f.scope, f.fence, 'OUTCOME_UNKNOWN', 'SECURITY_EFFECT_UNRESOLVED')).toMatchObject({ phase: 'OUTCOME_UNKNOWN', reservedMicros: 60 });
  });
  it.each(['REPAIR', 'REVIEW'])('refuses existing queued or unresolved %s work on admission and claim', async kind => {
    const f = await fixture();
    const job = await database.careJob.create({ data: { tenantId: f.scope.tenantId, websiteId: f.scope.websiteId, userId: f.actorId, requestKey: randomUUID(), environment: 'PRODUCTION', kind, state: 'QUEUED', summary: 'Synthetic existing scoped work' } });
    await expect(f.journal.createRun(f.input)).rejects.toMatchObject({ code: 'SECURITY_WEBSITE_WORK_CONFLICT' });
    await database.careJob.update({ where: { id: job.id }, data: { state: 'CANCELLED' } });
    await f.journal.createRun(f.input);
    await database.careJob.update({ where: { id: job.id }, data: { state: 'OUTCOME_UNKNOWN' } });
    await expect(f.journal.claimRun(f.scope, randomUUID())).rejects.toMatchObject({ code: 'SECURITY_WEBSITE_WORK_CONFLICT' });
  });
  it.each(['OUTCOME_UNKNOWN', 'BASELINE_CONFIRMED'] as const)('distinguishes %s static release history from its completed parent job', async state => {
    const f = await fixture();
    const job = await database.careJob.create({ data: { tenantId: f.scope.tenantId, websiteId: f.scope.websiteId, userId: f.actorId, requestKey: randomUUID(), environment: 'STAGING', kind: 'REPAIR', state: 'COMPLETED', summary: 'Synthetic existing scoped work' } });
    const source = await acceptedArtifact(f.scope, f.actorId);
    const revision = await database.careRevision.create({ data: { tenantId: f.scope.tenantId, websiteId: f.scope.websiteId, jobId: job.id, version: 1, sourceId: source.id, sourceDigest: digest, budgetMicros: 1000, plan: {} } });
    const credential = await database.careCredential.create({ data: { tenantId: f.scope.tenantId, websiteId: f.scope.websiteId, environment: 'PRODUCTION', kind: 'SSH', host: 'fixture.example.test', username: 'fixture', authMethod: 'PASSWORD', encryptedEnvelope: 'synthetic-unused', authorizedBy: f.actorId, authorizationExpiresAt: new Date(Date.now() + 60_000) } });
    const release = await database.careRelease.create({ data: { tenantId: f.scope.tenantId, websiteId: f.scope.websiteId, jobId: job.id, revisionId: revision.id, requestKey: randomUUID(), credentialId: credential.id, credentialVersion: 1, remotePath: '/synthetic/index.html', sourceDigest: digest, candidateDigest: digest, state } });
    if (state === 'OUTCOME_UNKNOWN') {
      await expect(f.journal.createRun(f.input)).rejects.toMatchObject({ code: 'SECURITY_WEBSITE_WORK_CONFLICT' });
      expect(await database.securityRepairRun.count({ where: { id: f.scope.runId } })).toBe(0);
      expect(await database.securityRepairOutbox.count({ where: { runId: f.scope.runId } })).toBe(0);
    } else {
      expect(await f.journal.createRun(f.input)).toMatchObject({ id: f.scope.runId, phase: 'PLANNING' });
      const fence = await f.journal.claimRun(f.scope, randomUUID());
      expect(fence.version).toBe(1);
      await f.journal.releaseLease(f.scope, fence);
      expect(await database.careRelease.findUniqueOrThrow({ where: { id: release.id } })).toEqual(release);
      // Fixture-only state change verifies a fresh unresolved release still
      // fences claim admission. No release execution or reconciliation runs.
      await database.careRelease.update({ where: { id: release.id }, data: { state: 'OUTCOME_UNKNOWN' } });
      await expect(f.journal.claimRun(f.scope, randomUUID())).rejects.toMatchObject({ code: 'SECURITY_WEBSITE_WORK_CONFLICT' });
      expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(0);
    }
    expect(await database.careJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ state: 'COMPLETED' });
    expect(await database.careRelease.findUniqueOrThrow({ where: { id: release.id } })).toMatchObject({ state: 'OUTCOME_UNKNOWN', sourceDigest: digest, candidateDigest: digest });
  });
  it('enforces exact tenant/site/environment graph FKs and prevents cascading website history deletion', async () => {
    const f = await started();
    const checkpoint = { id: '1f1cb11a-73d9-66f0-ffff-5332a0bdb9ae', tenantId: f.scope.tenantId, websiteId: f.scope.websiteId, environment: f.scope.environment, runId: f.scope.runId, checkpointNs: '', encryptedEnvelope: 'synthetic-envelope-only', digest };
    // LangGraph UUID-shaped checkpoint ids need not have an RFC variant; run/actor ids still do.
    await database.securityGraphCheckpoint.create({ data: checkpoint });
    await expect(database.securityGraphCheckpoint.create({ data: { ...checkpoint, id: randomUUID(), environment: 'PRODUCTION' } })).rejects.toThrow();
    await expect(database.securityGraphWrite.create({ data: { tenantId: f.scope.tenantId, websiteId: f.scope.websiteId, environment: 'PRODUCTION', runId: f.scope.runId, checkpointNs: '', checkpointId: checkpoint.id, taskId: randomUUID(), idx: 0, taskPath: '', encryptedEnvelope: 'synthetic-envelope-only', digest } })).rejects.toThrow();
    await expect(database.website.delete({ where: { id: f.scope.websiteId } })).rejects.toThrow();
    expect(await database.securityRepairRun.findUnique({ where: { id: f.scope.runId } })).not.toBeNull();
    await expect(f.journal.recoverExpired({ ...f.scope, environment: 'PRODUCTION' })).rejects.toMatchObject({ code: 'SECURITY_RUN_NOT_FOUND' });
  });
  it('rejects expired authority and another tenant without creating attempts or events', async () => {
    const f = await started();
    await expect(f.journal.createRun({ ...f.input, requestKey: randomUUID(), runId: randomUUID(), expiresAt: new Date(0) })).rejects.toMatchObject({ code: 'SECURITY_AUTHORITY_EXPIRED' });
    await expect(f.journal.recoverExpired({ ...f.scope, tenantId: randomUUID() })).rejects.toMatchObject({ code: 'SECURITY_WEBSITE_UNAVAILABLE' });
    f.advance(60_001);
    await expect(f.journal.beginStep(f.scope, f.fence, step)).rejects.toMatchObject({ code: 'SECURITY_AUTHORITY_EXPIRED' });
    expect(await database.securityRepairAttempt.count({ where: { runId: f.scope.runId } })).toBe(0);
  });
  it.each(['APPROVED', 'DENIED'] as const)('persists and resolves a real %s candidate decision against its exact plan receipt', async status => {
    const f = await waiting();
    const decisionId = await f.journal.recordCandidateDecision(f.scope, { ...f.decision, status });
    const stored = await database.securityRepairDecision.findUniqueOrThrow({ where: { id: decisionId } });
    expect(stored).toMatchObject({ ...f.receipt, actorId: f.actorId, sessionId: f.sessionId, kind: 'CANDIDATE', status });
    expect(stored.expiresAt.getTime()).toBeLessThanOrEqual(f.input.expiresAt.getTime());
    expect(stored.expiresAt.getTime()).toBeGreaterThan(stored.createdAt.getTime());
    const resumed = await f.journal.claimRun(f.scope, randomUUID());
    expect(await f.journal.resolveCandidateDecision(f.scope, resumed, decisionId, f.receipt)).toBe(status);
    await expect(f.journal.resolveCandidateDecision(f.scope, f.fence, decisionId, f.receipt)).rejects.toMatchObject({ code: 'SECURITY_LEASE_LOST' });
    expect(await database.securityRepairOutbox.count({ where: { runId: f.scope.runId, eventType: status === 'APPROVED' ? 'decision.approved' : 'decision.denied', publishedAt: null } })).toBe(1);
  });
  it('keeps the first decision immutable and returns only an exact idempotent request', async () => {
    const f = await waiting();
    const denied = { ...f.decision, status: 'DENIED' as const };
    const id = await f.journal.recordCandidateDecision(f.scope, denied);
    expect(await f.journal.recordCandidateDecision(f.scope, denied)).toBe(id);
    await expect(f.journal.recordCandidateDecision(f.scope, f.decision)).rejects.toMatchObject({ code: 'SECURITY_DECISION_BINDING_CHANGED' });
    await expect(f.journal.recordCandidateDecision(f.scope, { ...denied, digest: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'SECURITY_DECISION_BINDING_CHANGED' });
    await expect(f.journal.recordCandidateDecision(f.scope, { ...f.decision, requestKey: randomUUID() })).rejects.toMatchObject({ code: 'SECURITY_DECISION_ALREADY_RECORDED' });
    expect(await database.securityRepairDecision.count({ where: { runId: f.scope.runId } })).toBe(1);
    expect(await database.securityRepairOutbox.count({ where: { runId: f.scope.runId, eventType: 'decision.denied' } })).toBe(1);
  });
  it('serializes an approve/deny race so one exact plan has only one saved decision', async () => {
    const f = await waiting();
    const results = await Promise.allSettled([
      f.journal.recordCandidateDecision(f.scope, f.decision),
      f.journal.recordCandidateDecision(f.scope, { ...f.decision, requestKey: randomUUID(), status: 'DENIED' })
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await database.securityRepairDecision.count({ where: { runId: f.scope.runId } })).toBe(1);
  });
  it('refuses wrong plan, actor/session, environment and tenant decision bindings', async () => {
    const f = await waiting();
    await expect(f.journal.recordCandidateDecision(f.scope, { ...f.decision, digest: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'SECURITY_DECISION_RECEIPT_CHANGED' });
    await expect(f.journal.recordCandidateDecision(f.scope, { ...f.decision, actorId: randomUUID() })).rejects.toMatchObject({ code: 'SECURITY_ACTOR_BINDING_CHANGED' });
    await expect(f.journal.recordCandidateDecision(f.scope, { ...f.decision, sessionId: randomUUID() })).rejects.toMatchObject({ code: 'SECURITY_ACTOR_BINDING_CHANGED' });
    await expect(f.journal.recordCandidateDecision({ ...f.scope, environment: 'PRODUCTION' }, f.decision)).rejects.toMatchObject({ code: 'SECURITY_RUN_NOT_FOUND' });
    await expect(f.journal.recordCandidateDecision({ ...f.scope, tenantId: randomUUID() }, f.decision)).rejects.toMatchObject({ code: 'SECURITY_WEBSITE_UNAVAILABLE' });
    const id = await f.journal.recordCandidateDecision(f.scope, f.decision);
    const fence = await f.journal.claimRun(f.scope, randomUUID());
    await expect(f.journal.resolveCandidateDecision(f.scope, fence, randomUUID(), f.receipt)).rejects.toMatchObject({ code: 'SECURITY_DECISION_BINDING_CHANGED' });
    await expect(f.journal.resolveCandidateDecision(f.scope, fence, id, { ...f.receipt, digest: 'c'.repeat(64) })).rejects.toMatchObject({ code: 'SECURITY_DECISION_BINDING_CHANGED' });
  });
  it('requires a released waiting checkpoint, an unexpired decision and current artifact/actor authority', async () => {
    const f = await waiting(1_800_000);
    const id = await f.journal.recordCandidateDecision(f.scope, f.decision);
    const held = await f.journal.claimRun(f.scope, randomUUID());
    await expect(f.journal.recordCandidateDecision(f.scope, { ...f.decision, requestKey: randomUUID() })).rejects.toMatchObject({ code: 'SECURITY_DECISION_NOT_WAITING' });
    await database.careArtifact.update({ where: { id: f.artifact.id }, data: { status: 'QUARANTINED' } });
    await expect(f.journal.resolveCandidateDecision(f.scope, held, id, f.receipt)).rejects.toMatchObject({ code: 'SECURITY_ARTIFACT_UNAVAILABLE' });
    await database.careArtifact.update({ where: { id: f.artifact.id }, data: { status: 'ACCEPTED' } });
    await f.journal.releaseLease(f.scope, held);
    f.advance(900_001);
    const fresh = await f.journal.claimRun(f.scope, randomUUID());
    await expect(f.journal.resolveCandidateDecision(f.scope, fresh, id, f.receipt)).rejects.toMatchObject({ code: 'SECURITY_DECISION_EXPIRED' });
    await database.session.update({ where: { id: f.sessionId }, data: { revokedAt: new Date() } });
    await expect(f.journal.resolveCandidateDecision(f.scope, fresh, id, f.receipt)).rejects.toMatchObject({ code: 'TEST_AUTHORITY_DENIED' });
  });
});
