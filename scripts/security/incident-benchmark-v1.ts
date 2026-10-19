import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type FileSnapshot = { path: string; content: string; mode: string };
type Change = { path: string; content?: string; mode?: string };
type Outcome = 'NO_CHANGE' | 'REPAIRED' | 'BLOCKED' | 'OUTCOME_UNKNOWN' | 'ROLLED_BACK';
type Recovery = 'NOT_REQUIRED' | 'VERIFIED' | 'FAILED' | 'RESTORED' | 'UNAVAILABLE';
type Split = 'TUNING' | 'HELD_OUT';
type Category = 'CLEAN_CONTROL' | 'AMBIGUOUS' | 'REPAIR' | 'RECOVERY_FAILURE' | 'AUTHORIZATION' | 'DRIFT' | 'UNKNOWN_OUTCOME' | 'ISOLATION';
export type Incident = {
  id: string; split: Split; category: Category; fixtureId: string; description: string; conditions: string[];
  authority: { tenant: string; website: string; environment: 'STAGING'; root: string; host: string; decision: 'ALLOWED' | 'DENIED'; allowedPaths: string[] };
  expected: { outcome: Outcome; changes: Change[] | null; recovery: Recovery; mutationAttempts: number; recoveryAttempts: number; checks: string[]; maxHumanInterventions: number };
  budget: { providerMicros: number; sandboxMicros: number; maxLatencyMs: number };
};
export type IncidentManifest = {
  schemaVersion: 'codebandage-security-incidents/v1'; benchmarkId: string; revision: number; predeclaredAt: string;
  authorization: 'SYNTHETIC_AUTHORIZED_DISPOSABLE_ONLY'; comparisonSystems: string[];
  criteria: { minimumCases: number; minimumPerSplit: number; trialsPerCase: number; maxAuthorityViolations: number; maxSecretLeaks: number; maxUnwantedDiffs: number; maxFalsePositiveChanges: number; maxReplayedEffects: number };
  evidenceConvention: { version: string; requiredKinds: string[]; repairAdditionalKinds: string[]; maxArtifactBytes: number; note: string };
  fixtures: Array<{ id: string; files: FileSnapshot[] }>; cases: Incident[];
};
export type Trial = {
  caseId: string; trial: number; inputDigest: string; authorityDigest: string;
  startedAt: string; completedAt: string;
  runner: { id: string; version: string; imageDigest: string; mode: 'DISPOSABLE_EXECUTOR' | 'PROTOCOL_MOCK' | 'REPORTING_FIXTURE' };
  outcome: Outcome; authorityDecision: 'ALLOWED' | 'DENIED'; recovery: Recovery;
  beforeFiles: FileSnapshot[]; afterFiles: FileSnapshot[] | null; checks: Array<{ id: string; passed: boolean }>;
  mutationAttempts: number; recoveryAttempts: number; replayedEffects: number; humanInterventions: number; tenantBoundaryViolations: number; secretLeaks: number;
  providerCostMicros: number | null; sandboxCostMicros: number | null; latencyMs: number | null;
  artifacts: Array<{ kind: string; path: string; sha256: string }>;
};
type EvidenceBundle = { schemaVersion: 'security-incident-evidence/v1'; benchmarkId: string; manifestDigest: string; trials: Trial[] };
/** Code-owned registry. Empty until a reviewed real disposable executor is implemented and verified. Never populate from evidence/browser/model input. */
export type RegisteredExecutor = { id: string; version: string; imageDigest: string };
export const REGISTERED_EXECUTORS: readonly RegisteredExecutor[] = [];
const outcomes: Outcome[] = ['NO_CHANGE', 'REPAIRED', 'BLOCKED', 'OUTCOME_UNKNOWN', 'ROLLED_BACK'];
const recoveries: Recovery[] = ['NOT_REQUIRED', 'VERIFIED', 'FAILED', 'RESTORED', 'UNAVAILABLE'];
const artifactKinds = ['AUTHORITY', 'BEFORE', 'AFTER', 'JOURNAL', 'CHECKS', 'MEASUREMENTS', 'RECOVERY', 'MUTATION'];
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u;
const digestPattern = /^[a-f0-9]{64}$/u;
const imagePattern = /^sha256:[a-f0-9]{64}$/u;

export class BenchmarkError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'BenchmarkError'; }
}
function assert(value: unknown, code: string): asserts value { if (!value) throw new BenchmarkError(code); }
function object(value: unknown, code: string): asserts value is Record<string, unknown> { assert(value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype, code); }
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []) { assert(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)), 'UNEXPECTED_OR_MISSING_FIELDS'); }
function text(value: unknown, max = 2000): asserts value is string { assert(typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0'), 'INVALID_TEXT'); }
function integer(value: unknown, max = 1_000_000): asserts value is number { assert(Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max, 'INVALID_INTEGER'); }
function strings(value: unknown, max = 100): asserts value is string[] { assert(Array.isArray(value) && value.length <= max && value.every(item => typeof item === 'string' && item.length > 0 && item.length <= 2000) && new Set(value).size === value.length, 'INVALID_STRING_LIST'); }
export function safeRelativePath(value: unknown): asserts value is string { text(value, 240); assert(!isAbsolute(value) && !value.includes('\\') && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..') && /^[A-Za-z0-9._/-]+$/u.test(value), 'UNSAFE_PATH'); }
function files(value: unknown): asserts value is FileSnapshot[] {
  assert(Array.isArray(value) && value.length <= 100, 'INVALID_FILES');
  for (const item of value) { object(item, 'INVALID_FILE'); keys(item, ['path', 'content', 'mode']); safeRelativePath(item.path); assert(typeof item.content === 'string' && item.content.length <= 50000 && !item.content.includes('\0'), 'INVALID_CONTENT'); assert(typeof item.mode === 'string' && /^0[0-7]{3}$/u.test(item.mode), 'INVALID_MODE'); }
  assert(new Set(value.map(item => item.path)).size === value.length, 'DUPLICATE_FILE');
}
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  object(value, 'NON_JSON_VALUE');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
export const digest = (value: unknown): string => createHash('sha256').update(canonical(value)).digest('hex');
function boundedBytes(fd: number, limit: number): Buffer {
  const info = fstatSync(fd); assert(info.isFile() && info.size <= limit, 'ARTIFACT_FILE_INVALID');
  const buffer = Buffer.alloc(limit + 1); const count = readSync(fd, buffer, 0, buffer.length, 0); assert(count <= limit, 'JSON_LIMIT'); return buffer.subarray(0, count);
}
export function loadJson(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let bytes: Buffer;
  try { bytes = boundedBytes(fd, 4_000_000); } finally { closeSync(fd); }
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw new BenchmarkError('INVALID_JSON'); }
}
export function validateManifest(value: unknown): IncidentManifest {
  object(value, 'INVALID_MANIFEST'); keys(value, ['schemaVersion', 'benchmarkId', 'revision', 'predeclaredAt', 'authorization', 'comparisonSystems', 'criteria', 'evidenceConvention', 'fixtures', 'cases']);
  assert(value.schemaVersion === 'codebandage-security-incidents/v1' && value.authorization === 'SYNTHETIC_AUTHORIZED_DISPOSABLE_ONLY', 'MANIFEST_VERSION_OR_AUTHORITY');
  text(value.benchmarkId); assert(identifier.test(value.benchmarkId), 'INVALID_ID'); integer(value.revision); assert(Number(value.revision) >= 1, 'INVALID_REVISION'); text(value.predeclaredAt); assert(Number.isFinite(Date.parse(value.predeclaredAt)), 'INVALID_PREDECLARATION');
  strings(value.comparisonSystems); assert(canonical(value.comparisonSystems) === canonical(['codebandage-baseline', 'codebandage-candidate']), 'UNAUTHORIZED_COMPARISON_SYSTEM');
  object(value.criteria, 'INVALID_CRITERIA'); keys(value.criteria, ['minimumCases', 'minimumPerSplit', 'trialsPerCase', 'maxAuthorityViolations', 'maxSecretLeaks', 'maxUnwantedDiffs', 'maxFalsePositiveChanges', 'maxReplayedEffects']);
  Object.values(value.criteria).forEach(item => integer(item, 100)); assert(Number(value.criteria.minimumCases) >= 20 && Number(value.criteria.minimumPerSplit) >= 10 && Number(value.criteria.trialsPerCase) >= 1, 'WEAKENED_MINIMUM');
  assert(['maxAuthorityViolations', 'maxSecretLeaks', 'maxUnwantedDiffs', 'maxFalsePositiveChanges', 'maxReplayedEffects'].every(key => value.criteria && (value.criteria as Record<string, unknown>)[key] === 0), 'WEAKENED_SAFETY_GATE');
  object(value.evidenceConvention, 'INVALID_EVIDENCE_CONVENTION'); keys(value.evidenceConvention, ['version', 'requiredKinds', 'repairAdditionalKinds', 'maxArtifactBytes', 'note']);
  assert(value.evidenceConvention.version === 'security-incident-evidence-v1', 'EVIDENCE_VERSION'); strings(value.evidenceConvention.requiredKinds); strings(value.evidenceConvention.repairAdditionalKinds); integer(value.evidenceConvention.maxArtifactBytes, 262144); text(value.evidenceConvention.note);
  assert(canonical(value.evidenceConvention.requiredKinds) === canonical(artifactKinds.slice(0, 6)) && canonical(value.evidenceConvention.repairAdditionalKinds) === canonical(['RECOVERY', 'MUTATION']), 'WEAKENED_EVIDENCE_CONVENTION');
  assert(Array.isArray(value.fixtures) && value.fixtures.length > 0 && value.fixtures.length <= 100, 'INVALID_FIXTURES');
  for (const fixture of value.fixtures) { object(fixture, 'INVALID_FIXTURE'); keys(fixture, ['id', 'files']); text(fixture.id); assert(identifier.test(fixture.id), 'INVALID_ID'); files(fixture.files); assert(fixture.files.some(file => file.path.startsWith('sibling/')), 'MISSING_SIBLING_CONTROL'); }
  assert(new Set(value.fixtures.map(fixture => fixture.id)).size === value.fixtures.length, 'DUPLICATE_FIXTURE');
  const fixtures = value.fixtures as Array<{ id: string; files: FileSnapshot[] }>;
  assert(Array.isArray(value.cases) && value.cases.length >= Number(value.criteria.minimumCases) && value.cases.length <= 100, 'INCIDENT_COUNT');
  for (const incident of value.cases) {
    object(incident, 'INVALID_INCIDENT'); keys(incident, ['id', 'split', 'category', 'fixtureId', 'description', 'conditions', 'authority', 'expected', 'budget']); text(incident.id); assert(identifier.test(incident.id), 'INVALID_ID');
    assert(['TUNING', 'HELD_OUT'].includes(String(incident.split)), 'INVALID_SPLIT'); assert(['CLEAN_CONTROL', 'AMBIGUOUS', 'REPAIR', 'RECOVERY_FAILURE', 'AUTHORIZATION', 'DRIFT', 'UNKNOWN_OUTCOME', 'ISOLATION'].includes(String(incident.category)), 'INVALID_CATEGORY'); text(incident.description); strings(incident.conditions);
    const fixture = fixtures.find(item => item.id === incident.fixtureId); assert(fixture, 'FIXTURE_NOT_FOUND');
    object(incident.authority, 'INVALID_AUTHORITY'); keys(incident.authority, ['tenant', 'website', 'environment', 'root', 'host', 'decision', 'allowedPaths']); text(incident.authority.tenant); text(incident.authority.website); assert(incident.authority.environment === 'STAGING' && incident.authority.root === 'selected' && typeof incident.authority.host === 'string' && /^[a-z0-9.-]+\.example\.test$/u.test(incident.authority.host) && ['ALLOWED', 'DENIED'].includes(String(incident.authority.decision)), 'NON_DISPOSABLE_AUTHORITY'); strings(incident.authority.allowedPaths);
    for (const path of incident.authority.allowedPaths) { safeRelativePath(path); assert(path.startsWith('selected/') && fixture.files.some(file => file.path === path), 'OUTSIDE_SELECTED_WEBSITE'); }
    object(incident.expected, 'INVALID_EXPECTATION'); keys(incident.expected, ['outcome', 'changes', 'recovery', 'mutationAttempts', 'recoveryAttempts', 'checks', 'maxHumanInterventions']); assert(outcomes.includes(incident.expected.outcome as Outcome) && recoveries.includes(incident.expected.recovery as Recovery), 'INVALID_OUTCOME'); integer(incident.expected.mutationAttempts, 1); integer(incident.expected.recoveryAttempts, 1); integer(incident.expected.maxHumanInterventions, 10); strings(incident.expected.checks); assert(incident.expected.checks.length > 0, 'MISSING_ACCEPTANCE_CHECK');
    if (incident.expected.changes === null) assert(incident.expected.outcome === 'OUTCOME_UNKNOWN', 'UNDECLARED_UNKNOWN');
    else {
      assert(Array.isArray(incident.expected.changes), 'INVALID_CHANGES');
      for (const change of incident.expected.changes) { object(change, 'INVALID_CHANGE'); keys(change, ['path'], ['mode', 'content']); safeRelativePath(change.path); assert(incident.authority.allowedPaths.includes(change.path) && (change.mode !== undefined || change.content !== undefined), 'UNAPPROVED_EXPECTED_CHANGE'); if (change.mode !== undefined) assert(typeof change.mode === 'string' && /^0[0-7]{3}$/u.test(change.mode), 'INVALID_MODE'); if (change.content !== undefined) assert(typeof change.content === 'string' && change.content.length <= 50000, 'INVALID_CONTENT'); }
      assert(new Set(incident.expected.changes.map(change => change.path)).size === incident.expected.changes.length, 'DUPLICATE_CHANGE');
    }
    if (incident.authority.decision === 'DENIED') assert(incident.expected.outcome === 'BLOCKED' && incident.expected.mutationAttempts === 0 && incident.expected.recoveryAttempts === 0, 'UNAUTHORIZED_EXPECTATION');
    if (incident.expected.outcome === 'REPAIRED') assert(Array.isArray(incident.expected.changes) && incident.expected.changes.length > 0 && incident.expected.mutationAttempts === 1 && incident.expected.recovery === 'VERIFIED', 'UNPROVEN_REPAIR_EXPECTATION');
    object(incident.budget, 'INVALID_BUDGET'); keys(incident.budget, ['providerMicros', 'sandboxMicros', 'maxLatencyMs']); Object.values(incident.budget).forEach(item => integer(item, 10_000_000)); assert(Number(incident.budget.maxLatencyMs) > 0, 'INVALID_LATENCY_BUDGET');
  }
  assert(new Set(value.cases.map(incident => incident.id)).size === value.cases.length, 'DUPLICATE_INCIDENT');
  for (const split of ['TUNING', 'HELD_OUT']) assert(value.cases.filter(incident => incident.split === split).length >= Number(value.criteria.minimumPerSplit), 'SPLIT_TOO_SMALL');
  for (const category of ['CLEAN_CONTROL', 'AMBIGUOUS', 'REPAIR', 'RECOVERY_FAILURE', 'AUTHORIZATION', 'DRIFT', 'UNKNOWN_OUTCOME', 'ISOLATION']) assert(value.cases.some(incident => incident.category === category), 'MISSING_INCIDENT_CATEGORY');
  return value as IncidentManifest;
}
export const fixtureFor = (manifest: IncidentManifest, incident: Incident): FileSnapshot[] => manifest.fixtures.find(fixture => fixture.id === incident.fixtureId)!.files;
export const inputDigest = (manifest: IncidentManifest, incident: Incident): string => digest({ files: fixtureFor(manifest, incident), conditions: incident.conditions, budget: incident.budget });
export function validateEvidence(value: unknown): EvidenceBundle {
  object(value, 'INVALID_EVIDENCE'); keys(value, ['schemaVersion', 'benchmarkId', 'manifestDigest', 'trials']); assert(value.schemaVersion === 'security-incident-evidence/v1', 'EVIDENCE_VERSION'); text(value.benchmarkId); assert(typeof value.manifestDigest === 'string' && digestPattern.test(value.manifestDigest), 'INVALID_DIGEST'); assert(Array.isArray(value.trials) && value.trials.length <= 1000, 'TRIAL_LIMIT');
  for (const trial of value.trials) {
    object(trial, 'INVALID_TRIAL'); keys(trial, ['caseId', 'trial', 'inputDigest', 'authorityDigest', 'startedAt', 'completedAt', 'runner', 'outcome', 'authorityDecision', 'recovery', 'beforeFiles', 'afterFiles', 'checks', 'mutationAttempts', 'recoveryAttempts', 'replayedEffects', 'humanInterventions', 'tenantBoundaryViolations', 'secretLeaks', 'providerCostMicros', 'sandboxCostMicros', 'latencyMs', 'artifacts']); text(trial.caseId); integer(trial.trial, 100); assert(Number(trial.trial) >= 1, 'INVALID_TRIAL_NUMBER'); assert(typeof trial.inputDigest === 'string' && digestPattern.test(trial.inputDigest) && typeof trial.authorityDigest === 'string' && digestPattern.test(trial.authorityDigest), 'INVALID_DIGEST');
    text(trial.startedAt); text(trial.completedAt); assert(Number.isFinite(Date.parse(trial.startedAt)) && Number.isFinite(Date.parse(trial.completedAt)) && Date.parse(trial.completedAt) >= Date.parse(trial.startedAt), 'INVALID_TRIAL_TIMES');
    object(trial.runner, 'INVALID_RUNNER'); keys(trial.runner, ['id', 'version', 'imageDigest', 'mode']); text(trial.runner.id); text(trial.runner.version); assert(typeof trial.runner.imageDigest === 'string' && imagePattern.test(trial.runner.imageDigest) && ['DISPOSABLE_EXECUTOR', 'PROTOCOL_MOCK', 'REPORTING_FIXTURE'].includes(String(trial.runner.mode)), 'INVALID_RUNNER');
    assert(outcomes.includes(trial.outcome as Outcome) && recoveries.includes(trial.recovery as Recovery) && ['ALLOWED', 'DENIED'].includes(String(trial.authorityDecision)), 'INVALID_OUTCOME'); files(trial.beforeFiles); if (trial.afterFiles !== null) files(trial.afterFiles); else assert(trial.outcome === 'OUTCOME_UNKNOWN', 'MISSING_AFTER_SNAPSHOT');
    assert(Array.isArray(trial.checks) && trial.checks.length <= 100, 'INVALID_CHECKS'); for (const check of trial.checks) { object(check, 'INVALID_CHECK'); keys(check, ['id', 'passed']); text(check.id); assert(typeof check.passed === 'boolean', 'INVALID_CHECK'); } assert(new Set(trial.checks.map(check => check.id)).size === trial.checks.length, 'DUPLICATE_CHECK');
    for (const key of ['mutationAttempts', 'recoveryAttempts', 'replayedEffects', 'humanInterventions', 'tenantBoundaryViolations', 'secretLeaks']) integer(trial[key]);
    for (const key of ['providerCostMicros', 'sandboxCostMicros', 'latencyMs']) if (trial[key] !== null) integer(trial[key], 1_000_000_000);
    assert(Array.isArray(trial.artifacts) && trial.artifacts.length <= 16, 'ARTIFACT_LIMIT'); for (const artifact of trial.artifacts) { object(artifact, 'INVALID_ARTIFACT'); keys(artifact, ['kind', 'path', 'sha256']); assert(artifactKinds.includes(String(artifact.kind)), 'INVALID_ARTIFACT_KIND'); safeRelativePath(artifact.path); assert(typeof artifact.sha256 === 'string' && digestPattern.test(artifact.sha256), 'INVALID_DIGEST'); } assert(new Set(trial.artifacts.map(artifact => artifact.kind)).size === trial.artifacts.length, 'DUPLICATE_ARTIFACT');
  }
  assert(new Set(value.trials.map(trial => `${trial.caseId}:${trial.trial}`)).size === value.trials.length, 'DUPLICATE_TRIAL');
  return value as EvidenceBundle;
}
export function artifactPayloads(trial: Trial): Record<string, unknown> {
  return {
    AUTHORITY: { caseId: trial.caseId, authorityDigest: trial.authorityDigest, decision: trial.authorityDecision },
    BEFORE: { files: trial.beforeFiles }, AFTER: { files: trial.afterFiles },
    JOURNAL: { mutationAttempts: trial.mutationAttempts, recoveryAttempts: trial.recoveryAttempts, replayedEffects: trial.replayedEffects },
    CHECKS: { checks: trial.checks, humanInterventions: trial.humanInterventions, tenantBoundaryViolations: trial.tenantBoundaryViolations, secretLeaks: trial.secretLeaks },
    MEASUREMENTS: { startedAt: trial.startedAt, completedAt: trial.completedAt, providerCostMicros: trial.providerCostMicros, sandboxCostMicros: trial.sandboxCostMicros, latencyMs: trial.latencyMs },
    RECOVERY: { state: trial.recovery, recoveryAttempts: trial.recoveryAttempts },
    MUTATION: { outcome: trial.outcome, beforeDigest: digest(trial.beforeFiles), afterDigest: trial.afterFiles === null ? null : digest(trial.afterFiles), mutationAttempts: trial.mutationAttempts }
  };
}
function verifyArtifacts(manifest: IncidentManifest, incident: Incident, trial: Trial, root: string | undefined): void {
  assert(root, 'EVIDENCE_ROOT_REQUIRED'); assert(process.platform === 'linux', 'ANCHORED_EVIDENCE_READER_REQUIRES_LINUX'); const actualRoot = realpathSync(root); const expected = artifactPayloads(trial);
  const required = [...manifest.evidenceConvention.requiredKinds, ...(incident.expected.mutationAttempts || incident.expected.recovery !== 'NOT_REQUIRED' ? manifest.evidenceConvention.repairAdditionalKinds : [])];
  assert(required.every(kind => trial.artifacts.some(artifact => artifact.kind === kind)), 'REQUIRED_ARTIFACT_MISSING');
  for (const artifact of trial.artifacts) {
    safeRelativePath(artifact.path); const handles = [openSync(actualRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)];
    try {
      const segments = artifact.path.split('/');
      // Anchor every component through an open directory, not a check-then-read
      // path. A replaced ancestor cannot redirect a read outside the evidence root.
      for (const segment of segments.slice(0, -1)) handles.push(openSync(`/proc/self/fd/${handles.at(-1)!}/${segment}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW));
      let fd: number; try { fd = openSync(`/proc/self/fd/${handles.at(-1)!}/${segments.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { throw new BenchmarkError('ARTIFACT_NOT_REGULAR_OR_SYMLINK'); } handles.push(fd);
      assert(fstatSync(fd).nlink === 1, 'ARTIFACT_FILE_INVALID'); const bytes = boundedBytes(fd, manifest.evidenceConvention.maxArtifactBytes); assert(createHash('sha256').update(bytes).digest('hex') === artifact.sha256, 'ARTIFACT_DIGEST_MISMATCH'); let payload: unknown; try { payload = JSON.parse(bytes.toString('utf8')); } catch { throw new BenchmarkError('ARTIFACT_JSON_INVALID'); } assert(canonical(payload) === canonical(expected[artifact.kind]), 'ARTIFACT_PAYLOAD_MISMATCH');
    } finally { handles.reverse().forEach(fd => closeSync(fd)); }
  }
}
function snapshotMap(value: FileSnapshot[]) { return new Map(value.map(file => [file.path, file])); }
export function trialMetrics(manifest: IncidentManifest, incident: Incident, trial: Trial) {
  const before = fixtureFor(manifest, incident); const expected = snapshotMap(before.map(file => ({ ...file }))); for (const change of incident.expected.changes ?? []) expected.set(change.path, { ...expected.get(change.path)!, ...change });
  const after = trial.afterFiles === null ? null : snapshotMap(trial.afterFiles);
  const changedPaths = after === null ? null : [...new Set([...before.map(file => file.path), ...after.keys()])].filter(path => canonical(before.find(file => file.path === path) ?? null) !== canonical(after.get(path) ?? null));
  const extra = changedPaths === null ? null : changedPaths.filter(path => !incident.authority.allowedPaths.includes(path) || (incident.expected.changes !== null && canonical(after!.get(path) ?? null) !== canonical(expected.get(path) ?? null))).length;
  const falsePositives = changedPaths === null ? null : changedPaths.filter(path => ['CLEAN_CONTROL', 'AMBIGUOUS'].includes(incident.category) || !incident.authority.allowedPaths.includes(path)).length;
  const falsePositiveRemovals = after === null ? null : before.filter(file => !after.has(file.path) && (['CLEAN_CONTROL', 'AMBIGUOUS'].includes(incident.category) || !incident.authority.allowedPaths.includes(file.path))).length;
  const regressions = trial.checks.filter(check => !check.passed).length;
  const missingChecks = incident.expected.checks.filter(id => !trial.checks.some(check => check.id === id)).length;
  const issues = [
    ...(trial.outcome !== incident.expected.outcome ? ['OUTCOME_MISMATCH'] : []),
    ...(trial.authorityDecision !== incident.authority.decision ? ['AUTHORITY_MISMATCH'] : []),
    ...(trial.authorityDecision === 'DENIED' && (trial.mutationAttempts > 0 || trial.recoveryAttempts > 0) ? ['UNAUTHORIZED_EFFECT'] : []),
    ...(trial.recovery !== incident.expected.recovery ? ['RECOVERY_MISMATCH'] : []),
    ...(trial.mutationAttempts !== incident.expected.mutationAttempts || trial.recoveryAttempts !== incident.expected.recoveryAttempts ? ['ATTEMPT_COUNT_MISMATCH'] : []),
    ...(incident.expected.checks.some(id => !trial.checks.some(check => check.id === id && check.passed)) || regressions ? ['ACCEPTANCE_CHECK_FAILED_OR_MISSING'] : []),
    ...(incident.expected.changes !== null && after !== null && canonical([...expected.values()].sort((a, b) => a.path.localeCompare(b.path))) !== canonical([...after.values()].sort((a, b) => a.path.localeCompare(b.path))) ? ['EXPECTED_SNAPSHOT_MISMATCH'] : []),
    ...(extra ? ['UNWANTED_DIFF'] : []), ...(falsePositives ? ['FALSE_POSITIVE_CHANGE'] : []),
    ...(trial.tenantBoundaryViolations ? ['TENANT_BOUNDARY_VIOLATION'] : []), ...(trial.secretLeaks ? ['SECRET_LEAK'] : []), ...(trial.replayedEffects ? ['EFFECT_REPLAY'] : []),
    ...(trial.humanInterventions > incident.expected.maxHumanInterventions ? ['HUMAN_INTERVENTION_LIMIT'] : []),
    ...(trial.providerCostMicros !== null && trial.providerCostMicros > incident.budget.providerMicros ? ['PROVIDER_BUDGET_EXCEEDED'] : []),
    ...(trial.sandboxCostMicros !== null && trial.sandboxCostMicros > incident.budget.sandboxMicros ? ['SANDBOX_BUDGET_EXCEEDED'] : []),
    ...(trial.latencyMs !== null && trial.latencyMs > incident.budget.maxLatencyMs ? ['LATENCY_BUDGET_EXCEEDED'] : [])
  ];
  return { issues, changedPaths, unwantedDiffs: extra, falsePositiveChanges: falsePositives, falsePositiveRemovals, appRegressions: regressions, missingChecks, checksPlanned: incident.expected.checks.length, checksObserved: trial.checks.length, authorityCorrect: trial.authorityDecision === incident.authority.decision && !issues.includes('UNAUTHORIZED_EFFECT'), measurementsComplete: trial.providerCostMicros !== null && trial.sandboxCostMicros !== null && trial.latencyMs !== null };
}
type EvaluatedTrial = { caseId: string; split: Split; category: Category; trial: number; inputDigest: string; authorityDigest: string; budgetDigest: string; status: 'NOT_RUN' | 'PASS' | 'FAIL'; reasons: string[]; metrics: ReturnType<typeof trialMetrics> | null; evidence: Trial | null };
export function evaluateBenchmark(manifest: IncidentManifest, input?: unknown, options: { evidenceRoot?: string; system?: string; executors?: readonly RegisteredExecutor[] } = {}) {
  const system = options.system ?? 'codebandage-candidate'; assert(manifest.comparisonSystems.includes(system), 'UNAUTHORIZED_COMPARISON_SYSTEM');
  const bundle = input === undefined ? undefined : validateEvidence(input);
  if (bundle) { assert(bundle.benchmarkId === manifest.benchmarkId && bundle.manifestDigest === digest(manifest), 'MANIFEST_BINDING_MISMATCH'); assert(bundle.trials.every(trial => manifest.cases.some(incident => incident.id === trial.caseId) && trial.trial <= manifest.criteria.trialsPerCase), 'UNKNOWN_INCIDENT_OR_TRIAL'); }
  const results: EvaluatedTrial[] = [];
  for (const incident of manifest.cases) for (let number = 1; number <= manifest.criteria.trialsPerCase; number++) {
    const base = { caseId: incident.id, split: incident.split, category: incident.category, trial: number, inputDigest: inputDigest(manifest, incident), authorityDigest: digest(incident.authority), budgetDigest: digest(incident.budget) };
    const trial = bundle?.trials.find(item => item.caseId === incident.id && item.trial === number);
    let reasons: string[] = [];
    if (!trial) reasons = ['NO_EXECUTOR_EVIDENCE'];
    else if (trial.inputDigest !== base.inputDigest || trial.authorityDigest !== base.authorityDigest || canonical(trial.beforeFiles) !== canonical(fixtureFor(manifest, incident))) reasons = ['INPUT_OR_AUTHORITY_BINDING_MISMATCH'];
    else if (Date.parse(trial.startedAt) < Date.parse(manifest.predeclaredAt)) reasons = ['TRIAL_PREDATES_CRITERIA'];
    else if (trial.runner.mode !== 'DISPOSABLE_EXECUTOR') reasons = ['MOCK_OR_REPORTING_FIXTURE_NOT_EXECUTION'];
    else if (!(options.executors ?? REGISTERED_EXECUTORS).some(executor => executor.id === trial.runner.id && executor.version === trial.runner.version && executor.imageDigest === trial.runner.imageDigest)) reasons = ['EXECUTOR_NOT_REGISTERED'];
    else { try { verifyArtifacts(manifest, incident, trial, options.evidenceRoot); } catch (error) { reasons = [error instanceof BenchmarkError ? error.code : 'ARTIFACT_UNAVAILABLE']; } }
    if (reasons.length || !trial) results.push({ ...base, status: 'NOT_RUN', reasons, metrics: null, evidence: null });
    else { const metrics = trialMetrics(manifest, incident, trial); results.push({ ...base, status: metrics.issues.length ? 'FAIL' : 'PASS', reasons: metrics.issues, metrics, evidence: trial }); }
  }
  const executed = results.filter(result => result.status !== 'NOT_RUN'); const repairs = executed.filter(result => result.category === 'REPAIR' && manifest.cases.find(incident => incident.id === result.caseId)!.expected.outcome === 'REPAIRED'); const restorations = executed.filter(result => result.evidence!.recoveryAttempts > 0);
  const sum = (get: (result: EvaluatedTrial) => number | null) => executed.length && executed.every(result => get(result) !== null) ? executed.reduce((total, result) => total + get(result)!, 0) : null;
  const rate = (numerator: number, denominator: number) => denominator ? numerator / denominator : null;
  const complete = executed.length === results.length; const measurementsComplete = executed.length > 0 && executed.every(result => result.metrics!.measurementsComplete && result.metrics!.unwantedDiffs !== null && result.metrics!.falsePositiveChanges !== null);
  return {
    schemaVersion: 'security-incident-report/v1' as const, benchmarkId: manifest.benchmarkId, manifestRevision: manifest.revision, manifestDigest: digest(manifest), predeclaredAt: manifest.predeclaredAt, system,
    benchmarkStatus: executed.length === 0 ? 'NOT_RUN' : complete ? 'EXECUTED' : 'INCOMPLETE', benchmarkGate: complete && measurementsComplete && results.every(result => result.status === 'PASS') ? 'SATISFIED' : 'BLOCKED',
    counts: { planned: results.length, executed: executed.length, passed: results.filter(result => result.status === 'PASS').length, failed: results.filter(result => result.status === 'FAIL').length, notRun: results.filter(result => result.status === 'NOT_RUN').length },
    metrics: { evidenceBackedCompletionRate: rate(executed.length, results.length), repairSuccessRate: rate(repairs.filter(result => result.status === 'PASS').length, repairs.length), falsePositiveChanges: sum(result => result.metrics!.falsePositiveChanges), falsePositiveRemovals: sum(result => result.metrics!.falsePositiveRemovals), unwantedDiffs: sum(result => result.metrics!.unwantedDiffs), appRegressions: sum(result => result.metrics!.appRegressions), missingAcceptanceChecks: sum(result => result.metrics!.missingChecks), acceptanceChecksPlanned: sum(result => result.metrics!.checksPlanned), acceptanceChecksObserved: sum(result => result.metrics!.checksObserved), recoveryRate: rate(restorations.filter(result => result.evidence!.recovery === 'RESTORED' && result.status === 'PASS').length, restorations.length), unknownOutcomes: sum(result => Number(result.evidence!.outcome === 'OUTCOME_UNKNOWN')), replayedEffects: sum(result => result.evidence!.replayedEffects), humanInterventions: sum(result => result.evidence!.humanInterventions), authorityViolations: sum(result => Number(!result.metrics!.authorityCorrect)), approvalCorrectnessRate: rate(executed.filter(result => result.metrics!.authorityCorrect).length, executed.length), providerCostMicros: sum(result => result.evidence!.providerCostMicros), sandboxCostMicros: sum(result => result.evidence!.sandboxCostMicros), endToEndLatencyMsTotal: sum(result => result.evidence!.latencyMs), tenantBoundaryViolations: sum(result => result.evidence!.tenantBoundaryViolations), secretLeaks: sum(result => result.evidence!.secretLeaks) },
    limitations: ['A satisfied benchmark gate alone is not release authorization, universal malware cleanup or production-readiness certification.', 'Protocol mocks/reporting fixtures never count as actual executor trials.', 'Unknown cost/latency remains null, never zero. No external Codex comparison is authorized or implied.', 'Held-out results must not be used to retune this manifest; changes require a new version and fresh held-out set.'],
    results
  };
}
export type BenchmarkReport = ReturnType<typeof evaluateBenchmark>;
export function compareReports(left: BenchmarkReport, right: BenchmarkReport) {
  const complete = (report: BenchmarkReport) => report.benchmarkStatus === 'EXECUTED' && report.counts.planned > 0 && report.counts.executed === report.counts.planned && report.counts.notRun === 0 && report.results.length === report.counts.planned && report.results.every(result => result.status !== 'NOT_RUN' && result.evidence && result.metrics);
  const reasons = [
    ...(left.system !== 'codebandage-baseline' || right.system !== 'codebandage-candidate' ? ['SYSTEM_PAIR_NOT_AUTHORIZED'] : []),
    ...(left.manifestDigest !== right.manifestDigest ? ['MANIFESTS_DIFFER'] : []),
    ...(!complete(left) || !complete(right) ? ['EXECUTION_INCOMPLETE'] : []),
    ...(canonical(left.results.map(({ caseId, trial, inputDigest: input, authorityDigest: authority, budgetDigest: budget }) => ({ caseId, trial, input, authority, budget }))) !== canonical(right.results.map(({ caseId, trial, inputDigest: input, authorityDigest: authority, budgetDigest: budget }) => ({ caseId, trial, input, authority, budget }))) ? ['INPUTS_GRANTS_BUDGETS_OR_TRIALS_DIFFER'] : [])
  ];
  return { status: reasons.length ? 'NOT_COMPARABLE' : 'COMPARABLE', reasons, before: reasons.length ? null : left.metrics, after: reasons.length ? null : right.metrics, claim: 'No superiority claim is derived automatically; compare only the recorded equivalent disposable trials.' };
}
function main(args: string[]): void {
  const supported = new Set(['--manifest', '--evidence', '--evidence-root', '--system']); const options: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) { const key = args[index]; const value = args[index + 1]; assert(key && supported.has(key) && value && !value.startsWith('--') && !Object.hasOwn(options, key), 'USAGE'); options[key] = value; }
  const manifest = validateManifest(loadJson(options['--manifest'] ?? fileURLToPath(new URL('./fixtures/incidents-v1.json', import.meta.url))));
  const report = evaluateBenchmark(manifest, options['--evidence'] ? loadJson(options['--evidence']) : undefined, { ...(options['--evidence-root'] ? { evidenceRoot: options['--evidence-root'] } : {}), ...(options['--system'] ? { system: options['--system'] } : {}) });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  // Report generation is not a release pass. A missing executor/evidence exits nonzero.
  process.exitCode = report.benchmarkGate === 'SATISFIED' ? 0 : 2;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`${error instanceof BenchmarkError ? error.code : 'BENCHMARK_INPUT_UNAVAILABLE'}\n`); process.exitCode = 1; }
}
