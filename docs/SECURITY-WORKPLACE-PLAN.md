# Security workplace implementation and continuation

The owner specification of18October2026 governs this focused upgrade. Phase
status distinguishes local implementation, deployment setup and verified operation.
No phase is complete merely because contracts/docs/flags exist.

| Phase | Current checkpoint | Exit evidence still required |
| --- | --- | --- |
| P0 audit/preservation | Recorded; exact hotfix image checks/runtime/browser passed; audit blockers and compatibility spike recorded | Preserve this baseline as later phases change shared code |
| P1 durable orchestration | Foundation implemented: actual LangGraph, encrypted Prisma saver, journal/decisions/outbox/controller and dormant BullMQ dispatch. 60 new real PG/Redis cases passed within the broader 233-pass integration suite; one optional live scan skipped | New trusted product admission/current actor+grant integration and actual gateway/sandbox handlers; production migration/activation not done |
| P2 permission repair | Typed managed-static STAGING helper/broker; real pinned SSH bit-only hardening, separately signed restore and lost-ack reconciliation passed. Generic SFTP remains refused | Product exact-change MFA/payment/current-authority/UI integration; uncertain-journal restore admission; supported customer hosting enrollment |
| P3 local sandbox loop | Separate rootless engine installed/namespace+outer-cgroup checks passed; actual official gVisor guest launch failed before execution; engine disabled/data preserved | Reviewed compatible local runtime, actual per-job/adversarial limits/isolation, typed broker and PHP/WP/Node iterations; see ADR002 |
| P4 playbooksB–I | Not implemented | Each usable target-to-executor-to-verifier flow with provenance/recovery; unsupported cases handoff |
| P5 inline workplace | Existing chat preserved; inspection coverage hotfix | Typed plan/diff/recovery/approval/results in current SecurityChat, authority/drift/mobile/accessibility tests |
| P6 release/activation | No new repair capability enabled; local production build passed; public release audits remain blocked | Final gates, actual incident benchmark, canary/recovery evidence, focused draft PR and separately authorized activation |

## Acceptance traceability

| Owner scenarios | Existing/new code boundary | Required evidence |
| --- | --- | --- |
|1,2 | customer SSH/assessment; care source/static routes | Existing fixture/unit/integration/browser suites; real customer checks separately labelled |
|3 | future security plan/snapshot/broker | Persisted observed evidence, exact source and no invented price/provider status |
|4,14 | permission target + trusted helper/executor | Real disposable target: bit0002 only, unchanged bytes/ownership, refuse races/links, separately approved restore |
|5 | quarantine playbook | Malicious fixture preserved outside executable root; benign control not removed |
|6 | exact WP core playbook | Trusted version/locale checksums; configuration/uploads/custom content preserved |
|7 | redirect/injection playbook | Exact malicious behavior removed; legitimate redirects/routes/regressions pass |
|8 | dependency security patch | Reproducible package/lock provenance, bounded security diff and app tests |
|9 | authoritative readiness/allowance | Missing model/runtime/package/backup/budget is blocked with actual reason |
|10,11 | journal/approval/checkpoint/broker | Revoked/expired/mismatched session, account, tenant/site/artifact denies execution/access |
|12 | untrusted-source boundary | Embedded instructions cannot create authority, expand target or disclose secrets |
|13,15,16 | journal/reconciliation/cancellation | Crashes before/possible-after write, separate restore authority, no blind replay |
|17,19 | fixed isolated profiles + shared regressions | Ordinary flows work with synthetic data; six other workplaces/commercial/auth unchanged |
|18 | current chat/query policy/new inline cards | Tamil/IME, keyboard,320/1440px,history,drafts,429backoff,persisted progress |
|20 | specialist/result verifier | Completed scan/status-only record cannot resolve repair |
|21 | VPS-local runtime broker | Real mount/host/private-network/resource/cleanup denial with live-service health observations |

## Broader ledger classification (history unchanged)

Security dependency: ZR001–010,017,020,023–027,031–040,048–049,051–058,
060,062–064,066–068,070–076,078–086,088–094,096–100.

Preservation-only beyond the specifically affected security slice: ZR005,
011–016,018–019,021–022,028–030,041–047,050,053,059,061,069,077,087,089,095.
An item can have a security dependency and broader preservation obligations; this
classification does not grant completion of its general engineering roadmap.

Outside scope: new functionality for the six other workplaces, broad design/
commerce/CMS/MCP expansion, general knowledge retrieval, managed specialist
workstations, broader64/67tool completion and general product benchmarking.
No original ledger requirement/status/evidence is rewritten by this classification.

## Continuation rule

Implemented source boundaries and tests:

- `packages/security-orchestration`: scoped sanitized graph, checkpoint encryption,
  pause/resume/readiness and terminal-cursor recovery; graph protocol tests.
- `apps/api/src/modules/security-repair`: actual Prisma checkpoint storage,
  bounded transaction/lease/fencing journal, saved candidate decisions/costs and
  single controller; real disposable PostgreSQL tests. Production/recovery-write
  transitions remain hard-denied until a separately registered verified adapter.
- `apps/worker/src/security-workflow-dispatch*`: scoped outbox publication and
  one-attempt/global-concurrency-one BullMQ dispatch; protocol and real Redis tests.
  No worker index/timer/HTTP/tool activation is registered.
- Shared Care claim/admission/approval paths use the same website lock and retain
  uncertainty conflicts; inverse-order draft/reopen tests cover preservation.
  Retained artifact references cannot be wiped through the old deletion endpoint.
- `infrastructure/security-managed-target`: fresh managed namespace, fixed-command
  SSH, one-shot permits, encrypted bytes+metadata recovery and actual drill. New
  uncertain-journal reconciliation is observation-only and local-test verified;
  it cannot certify an uncertain write or authorize a restore.
- `scripts/security-runtime` / `infrastructure/security-runtime`: guarded separate
  provisioning/provenance/limits/probe/stop tooling; actual failed job evidence
  retained. Unit guards are not a passing hostile-code isolation certification.
- `scripts/security/fixtures/incidents-v1.json`:24 predeclared incidents with
  separate tuning/held-out cases. Reporting tests are implemented; all actual
  benchmark executor trials remain NOT_RUN, with no invented success metrics.
- `.github/workflows/ci.yml` and `scripts/security/prepare-ci-integration.ts`:
  source/run-bound disposable GitHub-hosted database compatibility. Existing
  audit remains blocking; actual hosted CI is not a local protocol-test result.

## Reviewable source increments

| Commit | Changed boundary | Evidence / remaining gate |
| --- | --- | --- |
| `7279cda` | Website-only inspection and honest coverage UI | Exact deployed images, baseline unit/integration/dev+production browser checks; restricted preview only |
| `f21f03b` | Preservation audit and operational/release gates | Source/host audit; no new executor activation |
| `094aae7` | Graph/checkpoint, journal/controller, dispatch, additive migration and shared Care conflict guards | Real disposable PostgreSQL/Redis, restart/decision/fencing/cost/tenant tests; no product admission |
| `908f9ef` | Managed staging helper, broker, encrypted recovery and observation-only reconciliation | Earlier exact source-manifest real SSH harden/restore/lost-ack drill; later reconciliation extension local tests only |
| `c0877a1` | Dedicated VPS runtime provenance/provision/stop/probes and ADR002 | Outer rootless engine checks passed; actual guest creation failed, runtime stopped, no customer execution |
| `289e6c7` | Predeclared 24-case incident/reporting harness | Reporting tests passed; actual benchmark trials NOT_RUN |
| `98ffec1` | Strict hosted CI fixture preparation and guard compatibility | 69 focused protocol tests, lint and API/worker typechecks passed; no actual hosted workflow result yet |

The managed staging proof is not the required customer-to-authorized-executor
vertical slice. Product integration remains unfinished local implementation,
not an unavailable external account. Tracks B–I and inline plan/approval/results
are also unfinished; the gVisor compatibility blocker must not disguise them.
The next source step is a server-derived admission/current-authority binding
reusing existing actor/session/MFA/pricing/grants, followed by the exact managed
adapter enrollment and inline journey. No generic SFTP or production-write gate
may be removed to finish that step.

After each increment update `security-workplace-progress.json` with exact source,
changed files, commands/results, unresolved gates and next safe action. Small
reviewable commits only; no unrelated main merge/force push. Preserve checkpoints
and data if external access, runtime capacity, package licensing or consequential
production authority blocks a later step. No runtime/repair completion is claimed
from this document.
