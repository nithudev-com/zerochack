# Security incident benchmark v1

This is a **synthetic, authorized disposable-incident declaration and evidence/reporting harness**, not a malware-removal executor. It makes no network, SSH, model, container, sandbox or production calls and cannot grant execution authority. `REGISTERED_EXECUTORS` is intentionally empty: all 24 executor incidents currently report `NOT_RUN`, the benchmark gate is `BLOCKED`, and the CLI exits **2**. Generating a JSON report is not passing a benchmark or approving deployment.

## Predeclared set

`fixtures/incidents-v1.json` is versioned before executor trials. It contains 12 tuning and 12 held-out cases, eight categories, exact synthetic fixture bytes/modes, selected-site/sibling controls, grants, expected final deltas, acceptance checks, recovery and authority outcomes, attempt limits, human-intervention limits and identical bounded budgets. `.example.test` hosts and logical paths are not customer targets. Fixtures contain inert examples and legitimate controls, not executable malware. Permission, PHP and redirect repair cases are candidates for **real disposable filesystem/runtime execution later**, not evidence that these executors exist now.

Use tuning cases for changes. Do not tune against held-out results or silently edit expectations to make a failure pass; declare v2 with a fresh held-out set if the benchmark changes. Publishing the manifest makes the split auditable; it is an organizational held-out boundary, not a claim that its fixtures are secret from developers or models. Include the manifest digest in every trial.

## Commands

With the repository's installed toolchain:

```sh
npx tsx scripts/security/incident-benchmark-v1.ts
npx vitest run scripts/security/incident-benchmark-v1.test.ts
```

The first command prints the current `NOT_RUN` report and exits 2, deliberately. Exit 0 means only that all declared benchmark trials/measurements met this benchmark's criteria; it is **not** release authority or a universal clean-site certificate. Exit 1 means invalid/unavailable input. CI must not turn exit 2 into a passing execution claim.

After a separately reviewed real disposable executor is implemented, tested and registered in **code-owned** configuration, its retained evidence can be evaluated:

```sh
npx tsx scripts/security/incident-benchmark-v1.ts \
  --manifest scripts/security/fixtures/incidents-v1.json \
  --evidence /protected/synthetic-trial-bundle.json \
  --evidence-root /protected/synthetic-trial-artifacts \
  --system codebandage-candidate
```

Only operator-authorized synthetic data belongs in these paths. Never supply production access/configuration, raw customer source, credentials, provider authentication, real mailboxes or tenant database snapshots. Do not enable capabilities, purchase services or run customer code on the control-plane host to produce a benchmark score.

## Evidence contract

`validateEvidence` exports the strict bundle contract. The bundle uses `security-incident-evidence/v1`, binds benchmark ID + canonical manifest SHA-256, and supplies unique `(caseId, trial)` entries. Each trial binds the exact input digest (fixture bytes, injected conditions and budget), authority digest, reviewed executor ID/version/immutable image, actual outcome, before/after snapshots, checks, recovery state, journal counters and measured cost/latency. `artifactPayloads` defines the exact required JSON payload for each receipt.

Every trial needs `AUTHORITY`, `BEFORE`, `AFTER`, `JOURNAL`, `CHECKS` and `MEASUREMENTS` artifacts; mutation/recovery cases additionally need `RECOVERY` and `MUTATION`. Each reference is a relative path and byte SHA-256. The Linux reader anchors every path component to an open directory, rejects symlinks, nonregular/hardlinked/oversized files, verifies bytes and checks each artifact's semantic payload against the trial. Unknown artifact fields, duplicate trials/kinds, missing checks, stale inputs/grants and unregistered/self-declared images fail closed.

Artifact hashing is **mechanical integrity**, not independent proof that a runner actually executed a write, tested a restore, checked egress or incurred a provider charge. Registering an executor therefore requires prior real isolation/authority/recovery tests and a trustworthy producer of the receipts/journal/measurements. Never register a protocol mock, a graph state transition, a provider stub, this reporting test harness or an image label alone as a real executor. The CLI cannot register executors from supplied JSON. Unit tests inject synthetic registrations to test reporting mechanics only; those values/results are not benchmark evidence and must not be published as real trials.

Reported measurements include evidence-backed completion, expected narrow-repair success, false-positive changes/removal of protected controls, unwanted diffs, failed/missing functional checks, restoration rate, unknown outcomes, replay, human interventions, approval correctness, tenant/privacy failures, provider/sandbox cost and end-to-end latency totals. Rates state their denominators via per-case results and planned/executed counts. Null means unmeasured/unknown, never free, fast or passing. A verified backup record is not a successful restore; an unknown outcome is not automatically retried; a disabled executor with an honest blocked result is not a repair success. Missing after-snapshot/cost/latency evidence keeps the benchmark gate blocked even when expected unknown-outcome handling was correct.

The harness has no raw-log or arbitrary-HTML rendering path. JSON output may include **synthetic** file snapshots from validated trials, so retain benchmark artifacts privately and apply bounded retention. Never place them in public CI artifacts without reviewing content.

## Comparison

`compareReports` accepts typed reports produced by this harness. It refuses incomplete execution, changed manifest/input/grants/budget/trial counts and any system pair other than `codebandage-baseline` → `codebandage-candidate`. Before comparing, independently review that both registered real runners have equivalent runtime privileges, budgets, isolation, versions and trial counts; the report cannot prove operational equivalence merely from a label. There is no authorized Codex account/API/runtime benchmark in this implementation and no Codex comparison is performed or inferred. A valid comparison reports recorded before/after metrics only; it never invents a superiority claim.

## Acceptance / limitations

Zero false-positive changes, unwanted diffs, authority violations, tenant failures, leaked canaries or replay is required. Exact expected outcome/snapshot, successful required checks, appropriate current recovery, bounded attempts/interventions and measured budget/latency must all match. These criteria are predeclared, not retrofitted to a score. Protocol mocks and reporting fixtures remain `NOT_RUN` regardless of their success strings. High performance on these fixtures cannot establish broad malware absence, support for all platforms, managed-service reliability or safe production activation.
