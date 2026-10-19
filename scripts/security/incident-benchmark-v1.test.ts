import { createHash } from 'node:crypto';
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactPayloads, canonical, compareReports, digest, evaluateBenchmark, fixtureFor, inputDigest, REGISTERED_EXECUTORS, safeRelativePath, trialMetrics, validateEvidence, validateManifest, type BenchmarkReport, type Incident, type RegisteredExecutor, type Trial } from './incident-benchmark-v1';

// These tests exercise reporting/validation mechanics only. Injected registrations
// and measured values below are synthetic unit fixtures, never actual runner evidence.
const manifest = validateManifest(JSON.parse(readFileSync(new URL('./fixtures/incidents-v1.json', import.meta.url), 'utf8')));
const registration: RegisteredExecutor = { id: 'reporting-unit-fixture', version: 'unit-v1', imageDigest: `sha256:${'a'.repeat(64)}` };
const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
const incident = (id = 'T04-php-permission') => manifest.cases.find(item => item.id === id)!;
function trialFor(item: Incident): Trial {
  const before = structuredClone(fixtureFor(manifest, item)); const after = structuredClone(before);
  for (const change of item.expected.changes ?? []) Object.assign(after.find(file => file.path === change.path)!, change);
  return { caseId: item.id, trial: 1, inputDigest: inputDigest(manifest, item), authorityDigest: digest(item.authority), startedAt: new Date(Date.parse(manifest.predeclaredAt) + 1000).toISOString(), completedAt: new Date(Date.parse(manifest.predeclaredAt) + 1100).toISOString(), runner: { ...registration, mode: 'DISPOSABLE_EXECUTOR' }, outcome: item.expected.outcome, authorityDecision: item.authority.decision, recovery: item.expected.recovery, beforeFiles: before, afterFiles: item.expected.changes === null ? null : after, checks: item.expected.checks.map(id => ({ id, passed: true })), mutationAttempts: item.expected.mutationAttempts, recoveryAttempts: item.expected.recoveryAttempts, replayedEffects: 0, humanInterventions: 0, tenantBoundaryViolations: 0, secretLeaks: 0, providerCostMicros: 100, sandboxCostMicros: 100, latencyMs: 100, artifacts: [] };
}
const bundle = (trials: Trial[]) => ({ schemaVersion: 'security-incident-evidence/v1', benchmarkId: manifest.benchmarkId, manifestDigest: digest(manifest), trials });
function saveArtifacts(trial: Trial, prefix = '') {
  const root = mkdtempSync(join(tmpdir(), 'codebandage-reporting-unit-')); temporary.push(root);
  for (const [kind, payload] of Object.entries(artifactPayloads(trial))) { const path = `${prefix}${kind.toLowerCase()}.json`; const bytes = Buffer.from(JSON.stringify(payload)); writeFileSync(join(root, path), bytes, { mode: 0o600 }); trial.artifacts.push({ kind, path, sha256: createHash('sha256').update(bytes).digest('hex') }); }
  return root;
}
const evaluateUnit = (trial: Trial, evidenceRoot: string) => evaluateBenchmark(manifest, bundle([trial]), { evidenceRoot, executors: [registration] });

describe('versioned synthetic incident declaration', () => {
  it('predeclares 24 authorized disposable incidents, independent tuning/held-out IDs and sibling controls', () => {
    expect(manifest.cases).toHaveLength(24); expect(manifest.cases.filter(item => item.split === 'TUNING')).toHaveLength(12); expect(manifest.cases.filter(item => item.split === 'HELD_OUT')).toHaveLength(12);
    expect(new Set(manifest.cases.map(item => item.category)).size).toBe(8); expect(manifest.fixtures.every(fixture => fixture.files.some(file => file.path.startsWith('sibling/')))).toBe(true);
    expect(manifest.cases.filter(item => item.expected.outcome === 'REPAIRED').length).toBeGreaterThanOrEqual(4); expect(REGISTERED_EXECUTORS).toEqual([]);
  });
  it('reports all executor incidents NOT_RUN with no invented repair rate, recovery, money or latency', () => {
    const report = evaluateBenchmark(manifest); expect(report.benchmarkStatus).toBe('NOT_RUN'); expect(report.benchmarkGate).toBe('BLOCKED'); expect(report.counts).toEqual({ planned: 24, executed: 0, passed: 0, failed: 0, notRun: 24 });
    expect(report.results.every(result => result.status === 'NOT_RUN' && result.reasons[0] === 'NO_EXECUTOR_EVIDENCE')).toBe(true);
    expect(report.metrics).toMatchObject({ evidenceBackedCompletionRate: 0, repairSuccessRate: null, recoveryRate: null, providerCostMicros: null, sandboxCostMicros: null, endToEndLatencyMsTotal: null, approvalCorrectnessRate: null, unwantedDiffs: null });
  });
  it.each(['maxAuthorityViolations', 'maxSecretLeaks', 'maxUnwantedDiffs', 'maxFalsePositiveChanges', 'maxReplayedEffects'] as const)('rejects weakening %s', key => {
    const changed = structuredClone(manifest); changed.criteria[key] = 1; expect(() => validateManifest(changed)).toThrow('WEAKENED_SAFETY_GATE');
  });
  it('rejects duplicate incidents, undersized held-out split and unapproved expected changes', () => {
    const duplicate = structuredClone(manifest); duplicate.cases[1]!.id = duplicate.cases[0]!.id; expect(() => validateManifest(duplicate)).toThrow('DUPLICATE_INCIDENT');
    const split = structuredClone(manifest); split.cases[23]!.split = 'TUNING'; expect(() => validateManifest(split)).toThrow('SPLIT_TOO_SMALL');
    const outside = structuredClone(manifest); outside.cases[3]!.authority.allowedPaths = ['sibling/index.php']; expect(() => validateManifest(outside)).toThrow('OUTSIDE_SELECTED_WEBSITE');
    const expected = structuredClone(manifest); expected.cases[3]!.expected.changes = [{ path: 'selected/not-approved.php', mode: '0664' }]; expect(() => validateManifest(expected)).toThrow('UNAPPROVED_EXPECTED_CHANGE');
  });
  it.each(['/etc/passwd', '../escape', 'selected/../other', 'selected//file', 'selected\\file', './file'])('rejects unsafe artifact/fixture path %s', path => { expect(() => safeRelativePath(path)).toThrow(); });
  it('binds fixture input, injected conditions, budgets and grants independently', () => {
    const item = structuredClone(incident()); const initial = inputDigest(manifest, item); item.conditions.push('NEW_FAULT'); expect(inputDigest(manifest, item) !== initial).toBe(true);
    item.conditions.pop(); item.budget.providerMicros++; expect(inputDigest(manifest, item) !== initial).toBe(true); item.budget.providerMicros--; item.authority.tenant = 'another-tenant'; expect(inputDigest(manifest, item)).toBe(initial); expect(digest(item.authority) !== digest(incident().authority)).toBe(true);
    expect(digest({ a: 1, b: 2 })).toBe(digest({ b: 2, a: 1 })); expect(() => canonical(undefined)).toThrow('NON_JSON_VALUE');
  });
});

describe('receipt/report validation, not actual executor trials', () => {
  it.each(['PROTOCOL_MOCK', 'REPORTING_FIXTURE'] as const)('does not credit %s as execution even with a matching synthetic registration', mode => {
    const trial = trialFor(incident()); trial.runner.mode = mode; const root = saveArtifacts(trial); const report = evaluateUnit(trial, root);
    expect(report.counts.executed).toBe(0); expect(report.results[3]!.reasons).toEqual(['MOCK_OR_REPORTING_FIXTURE_NOT_EXECUTION']); expect(report.metrics.providerCostMicros).toBeNull();
  });
  it('does not trust a self-declared disposable executor or image', () => {
    const trial = trialFor(incident()); const root = saveArtifacts(trial); const report = evaluateBenchmark(manifest, bundle([trial]), { evidenceRoot: root });
    expect(report.results[3]!.reasons).toEqual(['EXECUTOR_NOT_REGISTERED']); expect(report.benchmarkStatus).toBe('NOT_RUN');
  });
  it('mechanically checks bound receipts without calling any executor, network or provider', () => {
    const trial = trialFor(incident()); const report = evaluateUnit(trial, saveArtifacts(trial)); expect(report.results[3]!.status).toBe('PASS'); expect(report.counts).toMatchObject({ planned: 24, executed: 1, passed: 1, notRun: 23 }); expect(report.benchmarkStatus).toBe('INCOMPLETE'); expect(report.benchmarkGate).toBe('BLOCKED');
  });
  it('rejects stale manifest/input/grants and unknown case or repeated trial evidence', () => {
    const trial = trialFor(incident()); const stale = bundle([trial]); stale.manifestDigest = 'b'.repeat(64); expect(() => evaluateBenchmark(manifest, stale)).toThrow('MANIFEST_BINDING_MISMATCH');
    trial.authorityDigest = 'c'.repeat(64); expect(evaluateBenchmark(manifest, bundle([trial])).results[3]!.reasons).toEqual(['INPUT_OR_AUTHORITY_BINDING_MISMATCH']);
    trial.caseId = 'not-a-case'; expect(() => evaluateBenchmark(manifest, bundle([trial]))).toThrow('UNKNOWN_INCIDENT_OR_TRIAL');
    expect(() => validateEvidence(bundle([trial, trial]))).toThrow('DUPLICATE_TRIAL');
  });
  it('does not accept trials recorded before the criteria were declared', () => {
    const trial = trialFor(incident()); trial.startedAt = trial.completedAt = new Date(Date.parse(manifest.predeclaredAt) - 1).toISOString(); const report = evaluateUnit(trial, saveArtifacts(trial)); expect(report.results[3]!.reasons).toEqual(['TRIAL_PREDATES_CRITERIA']); expect(report.counts.executed).toBe(0);
  });
  it('requires every receipt and actual artifact bytes, never just a success boolean', () => {
    const trial = trialFor(incident()); const root = saveArtifacts(trial); trial.artifacts = trial.artifacts.filter(artifact => artifact.kind !== 'RECOVERY'); expect(evaluateUnit(trial, root).results[3]!.reasons).toEqual(['REQUIRED_ARTIFACT_MISSING']);
    const complete = trialFor(incident()); const directory = saveArtifacts(complete); writeFileSync(join(directory, 'before.json'), '{}'); expect(evaluateUnit(complete, directory).results[3]!.reasons).toEqual(['ARTIFACT_DIGEST_MISMATCH']);
  });
  it('rejects a hash-correct but semantically unrelated receipt', () => {
    const trial = trialFor(incident()); const root = saveArtifacts(trial); const bytes = Buffer.from('{"state":"trust-me"}'); writeFileSync(join(root, 'recovery.json'), bytes); trial.artifacts.find(artifact => artifact.kind === 'RECOVERY')!.sha256 = createHash('sha256').update(bytes).digest('hex');
    expect(evaluateUnit(trial, root).results[3]!.reasons).toEqual(['ARTIFACT_PAYLOAD_MISMATCH']);
  });
  it('rejects artifact symlinks and traversal before reading unapproved bytes', () => {
    const trial = trialFor(incident()); const root = saveArtifacts(trial); const target = join(root, 'before.json'); const link = join(root, 'link.json'); symlinkSync(target, link); trial.artifacts.find(artifact => artifact.kind === 'BEFORE')!.path = 'link.json'; expect(evaluateUnit(trial, root).results[3]!.reasons).toEqual(['ARTIFACT_NOT_REGULAR_OR_SYMLINK']);
    trial.artifacts[0]!.path = '../outside.json'; expect(() => validateEvidence(bundle([trial]))).toThrow('UNSAFE_PATH');
  });
  it('rejects hardlinked receipts rather than reading a second identity as private evidence', () => {
    const trial = trialFor(incident()); const root = saveArtifacts(trial); linkSync(join(root, 'before.json'), join(root, 'second-identity.json')); expect(evaluateUnit(trial, root).results[3]!.reasons).toEqual(['ARTIFACT_FILE_INVALID']);
  });
  it('counts false-positive deletion, sibling diffs and real check failures instead of accepting REPAIRED text', () => {
    const item = incident(); const trial = trialFor(item); trial.afterFiles = trial.afterFiles!.filter(file => file.path !== 'selected/uploads/customer-note.txt'); trial.afterFiles!.find(file => file.path === 'sibling/index.php')!.mode = '0600'; trial.checks[0]!.passed = false;
    const metrics = trialMetrics(manifest, item, trial); expect(metrics.unwantedDiffs).toBe(2); expect(metrics.falsePositiveChanges).toBe(2); expect(metrics.falsePositiveRemovals).toBe(1); expect(metrics.appRegressions).toBe(1); expect(metrics.issues).toEqual(expect.arrayContaining(['UNWANTED_DIFF', 'FALSE_POSITIVE_CHANGE', 'ACCEPTANCE_CHECK_FAILED_OR_MISSING', 'EXPECTED_SNAPSHOT_MISMATCH']));
    const report = evaluateUnit(trial, saveArtifacts(trial)); expect(report.results[3]!.status).toBe('FAIL'); expect(report.metrics.repairSuccessRate).toBe(0);
  });
  it('blocks a passing-health claim when a required check is missing, even with correct bytes', () => {
    const trial = trialFor(incident()); trial.checks.pop(); const report = evaluateUnit(trial, saveArtifacts(trial)); expect(report.results[3]!.status).toBe('FAIL'); expect(report.results[3]!.reasons).toContain('ACCEPTANCE_CHECK_FAILED_OR_MISSING');
  });
  it('counts denied-authority effects, leaked canaries, cross-tenant evidence and replay as failures', () => {
    const item = incident('H05-expired-grant'); const trial = trialFor(item); trial.mutationAttempts = 1; trial.secretLeaks = 1; trial.tenantBoundaryViolations = 1; trial.replayedEffects = 1;
    const report = evaluateUnit(trial, saveArtifacts(trial)); const result = report.results.find(value => value.caseId === item.id)!; expect(result.status).toBe('FAIL'); expect(result.reasons).toEqual(expect.arrayContaining(['UNAUTHORIZED_EFFECT', 'SECRET_LEAK', 'TENANT_BOUNDARY_VIOLATION', 'EFFECT_REPLAY'])); expect(report.metrics.authorityViolations).toBe(1); expect(report.metrics.approvalCorrectnessRate).toBe(0);
  });
  it('evaluates exact recovery outcomes and does not conflate verified backup with successful restoration', () => {
    const item = incident('T10-health-rollback'); const trial = trialFor(item); const report = evaluateUnit(trial, saveArtifacts(trial)); expect(report.metrics.recoveryRate).toBe(1);
    const wrong = trialFor(item); wrong.recovery = 'VERIFIED'; expect(trialMetrics(manifest, item, wrong).issues).toContain('RECOVERY_MISMATCH');
    expect(evaluateBenchmark(manifest).metrics.recoveryRate).toBeNull();
  });
  it('preserves unknown cost/snapshot and never treats a retry/replay as harmless', () => {
    const item = incident('T11-write-reply-lost'); const trial = trialFor(item); trial.providerCostMicros = null; trial.sandboxCostMicros = null; trial.latencyMs = null;
    const report = evaluateUnit(trial, saveArtifacts(trial)); expect(report.metrics).toMatchObject({ unknownOutcomes: 1, providerCostMicros: null, sandboxCostMicros: null, endToEndLatencyMsTotal: null, unwantedDiffs: null }); expect(report.benchmarkGate).toBe('BLOCKED'); trial.replayedEffects++; expect(trialMetrics(manifest, item, trial).issues).toContain('EFFECT_REPLAY');
  });
  it('reports actual supplied cost/latency overruns and human intervention limits as unmet criteria', () => {
    const item = incident(); const trial = trialFor(item); trial.providerCostMicros = item.budget.providerMicros + 1; trial.sandboxCostMicros = item.budget.sandboxMicros + 1; trial.latencyMs = item.budget.maxLatencyMs + 1; trial.humanInterventions = 20;
    expect(trialMetrics(manifest, item, trial).issues).toEqual(expect.arrayContaining(['PROVIDER_BUDGET_EXCEEDED', 'SANDBOX_BUDGET_EXCEEDED', 'LATENCY_BUDGET_EXCEEDED', 'HUMAN_INTERVENTION_LIMIT']));
  });
});

describe('equivalent comparison gate', () => {
  it('refuses comparison of unrun results or a claimed external Codex baseline', () => {
    const left = evaluateBenchmark(manifest, undefined, { system: 'codebandage-baseline' }); const right = evaluateBenchmark(manifest); expect(compareReports(left, right)).toMatchObject({ status: 'NOT_COMPARABLE', reasons: ['EXECUTION_INCOMPLETE'], before: null, after: null });
    expect(() => evaluateBenchmark(manifest, undefined, { system: 'codex' })).toThrow('UNAUTHORIZED_COMPARISON_SYSTEM');
  });
  it('does not trust a manually changed EXECUTED summary when trials remain NOT_RUN', () => {
    const left = evaluateBenchmark(manifest, undefined, { system: 'codebandage-baseline' }); const right = evaluateBenchmark(manifest); left.benchmarkStatus = right.benchmarkStatus = 'EXECUTED'; expect(compareReports(left, right)).toMatchObject({ status: 'NOT_COMPARABLE', reasons: ['EXECUTION_INCOMPLETE'], before: null, after: null });
  });
  it.each(['inputDigest', 'authorityDigest', 'budgetDigest', 'trial'] as const)('rejects comparison with different %s before reporting a score', key => {
    // Pure report-gate unit input, not execution evidence or a saved benchmark result.
    const left: BenchmarkReport = evaluateBenchmark(manifest, undefined, { system: 'codebandage-baseline' }); const right = evaluateBenchmark(manifest); left.benchmarkStatus = right.benchmarkStatus = 'EXECUTED';
    if (key === 'trial') right.results[0]!.trial = 2; else right.results[0]![key] = 'different';
    expect(compareReports(left, right).reasons).toContain('INPUTS_GRANTS_BUDGETS_OR_TRIALS_DIFFER');
  });
});
