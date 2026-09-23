# Approved source reviews: implemented scope and operation

All 24 roles can now run **text-source reviews**. A02 also retains customer chat and A08 retains the separately approved static HTML repair workflow. Enabling a review role does not enable the wider engineering abilities described in the original roadmap. A source review never executes uploaded code, performs runtime tests, connects to a customer server, applies a patch or publishes a release.

## Customer flow

1. Open the website conversation and choose Production or Staging. The choice scopes records; neither environment is contacted by this workflow.
2. Select **Review source with AI team**. Describe the issue and expected outcome, select roles, and choose English or Tamil for the reports. All 24 can be selected, or the core team can be used to reduce unnecessary model calls.
3. Upload 1–30 UTF-8 source files. Use unique relative paths and keep the complete snapshot below 200 KB including metadata. Archives, binary files, credential files and traversal paths are rejected. Review and remove credentials/private customer information yourself; pattern screening is not a universal secret detector.
4. Confirm privacy review, set the model allowance and select **Prepare team review plan**. Preparing the plan encrypts the snapshot but makes no model call.
5. Open the plan and review the selected roles, source fingerprint, model, language, scope and allowance. Select **Approve source review** to authorize this exact plan for one hour.
6. **Your AI team** and the review workspace show real persisted steps. Each role runs once, records its result and unlocks the next role. The workflow does not replay failed or stale model invocations.
7. Open reports to see source observations, exact path/line citations, suggested actions and limitations. Every finding must quote supplied source within its stated line range. This establishes source provenance, not correctness of the model's interpretation.
8. Stop the review when needed. An in-flight call may still cost money; its result is fenced from publication after cancellation. Completed reports remain available; automatic artifact deletion is disabled. To change scope or continue stopped work, prepare and approve a new plan; there is no automatic retry button for an uncertain call.

Reports may say `REVIEWED`, `NEEDS_INPUT`, or `NOT_APPLICABLE`. A role can finish with missing inputs or inapplicable scope; completion means it returned a validated report, not that it fixed the website. No current advisory feed, image understanding, browser rendering, visual comparison or test execution is supplied to these review roles.

## Execution contracts

`packages/care/src/source-review.ts` owns the versioned role focus, input limits, ordering and strict result schema. Source filenames, issue text and prior summaries are untrusted data. Previous reports are passed as bounded suggestions; later roles must cite the original approved source for their own findings.

The deterministic order starts with A01/A03 when selected, places specialist reviews before A14/A16, and ends with A17/A18 when selected. Only selected roles run. This is a persisted dependency chain, not dynamic model-controlled scheduling or parallel engineering.

PostgreSQL stores approvals, leases, step indices, predecessor roles, activity events, usage references and encrypted report artifacts. The worker commits each completed step before claiming another. Review and static repair claims share a website lock with a fresh state recheck. One source-review step runs per website at a time. Each model call has a two-minute cancellation deadline; a 90-second heartbeat loss marks work stale and holds uncertain cost. Worker shutdown stops new review claims and awaits its current review step.

Approval binds source digest, selected role order, language, issue, expected outcome, model configuration and allowance. Configuration changes require a new plan. The actor's current membership/permissions and the source artifact are rechecked before model use and result publication. Source and reports remain encrypted; raw review responses are excluded from ordinary AI usage response storage. Reports and source have no automatic retention expiry. The tenant quota blocks new uploads rather than evicting history. Previously erased artifacts cannot be recovered by the migration.

Known provider usage is charged even if citation validation fails. Unknown provider outcomes retain budget reservations. The allowance covers model usage only; it is not a complete infrastructure bill or a guarantee about the provider's eventual invoice. Concurrent legacy chat cost reservation remains an open platform limitation.

## Implemented tool handlers

These fourteen bounded handlers are called by the deterministic review runner. They are not an unrestricted model-selected tool loop. Every invocation checks its server-bound approval and scope; callers cannot submit another tenant, website or network destination.

| ID | Handler | Implemented result |
| --- | --- | --- |
| T01 | case_get_summary | Approved issue and expected outcome |
| T02 | environment_get_manifest | Bound environment, snapshot digest and execution limits |
| T04 | case_get_authorizations | Read-only approval metadata and expiry |
| T09 | source_list_files | Approved paths, digests and line counts |
| T10 | source_read_sanitized | Bounded ranges from the approved text snapshot |
| T11 | source_search_symbols | Bounded literal source matches; no regex execution or AST claims |
| T19 | dependencies_inventory | Declared package.json dependencies with truncation and advisory limitations |
| T21 | secrets_scan_local | Pattern-screening results without secret values |
| T31 | accessibility_run_checks | Static HTML language, alt/title and ID references; no browser or WCAG certification |
| T32 | content_check_links | Local HTML fragment IDs; no fetching |
| T53 | recovery_get_readiness | Server-bound production backup/monitoring metadata and unresolved release gaps; no restore certification |
| T65 | source_check_syntax | In-memory strict JSON and JS/TS/JSX/TSX parsing without filesystem/import/config access |
| T66 | design_check_css | Standalone CSS parsing without plugins/source maps or rendering |
| T59 | workflow_get_status | Current job state and completed predecessor roles |

The other **52 proposed tools remain disabled**. The owner registry describes the actual execution mode. T10 has a 250 KB output limit; the other implemented tools have a 64 KB limit. Oversized output stops the review instead of silently omitting required source.

## Deployment

Deploy API, web and worker together and apply migrations through `20260923030000_care_preserve_history`. Stop old maintenance workers before migrating; they still contain the former artifact purge. Source-review policy is now `source-review-v2`; unfinished v1 plans require a new approval plan, while their saved results remain readable. Configure:

```dotenv
CARE_ENABLED=true
CARE_REVIEW_ENABLED=true
CARE_REVIEW_BUDGET_MICROS=5000000
```

Provision distinct `CARE_VAULT_KEY` and `CARE_ARTIFACT_KEY` values in the deployment's secret manager. Do not use sample keys or rotate an artifact key while stored content depends on it. Configure an enabled tenant AI policy, provider credential, entitled model and nonzero input/output prices in AI Gateway. Repair and release flags remain separate.

Run the read-only setup check with the deployment environment loaded:

```sh
npm run care:preflight -- TENANT_UUID
```

The command checks database review columns, Redis, worker heartbeat, provider/model configuration and rollout flags. It does not invoke a model, inspect a customer website or certify production readiness. Its output explicitly leaves live provider evaluation and recovery drills unverified.

Keep the existing PostgreSQL, Redis, Zod, Prisma, provider adapters and frontend stack. No extra agent framework or vector database is required for this bounded workflow. Before general application repair, provide disposable isolated engineering/browser workers, pinned test/build profiles, target-specific connectors, reviewed knowledge sources and real model-quality evaluations. Merely installing a library or enabling a catalogue entry cannot supply these capabilities.

## Validation and remaining gates

The expanded suites cover 135 unit tests, 36 Care API integration tests using PGlite and fixture model/remote adapters, and 16 API-fixture browser tests. Consult the current PR checks for completed CI evidence. The integration suite exercises every one of the 24 roles, checkpoints between fresh service instances, tenant isolation, exact approval, invalid citations, current authorization, cancellation, reservations, dependency failure, a second worker, stale handling and rollback before HTTP success. The full integration suite also ran against real PostgreSQL 16/Redis in CI; subsequent commit-order regression fixes are tracked in the current [pull request checks](https://github.com/nithudev-com/zerochack/pull/1/checks).

These are implementation-contract tests, not an accuracy benchmark of a real model. PostgreSQL 16/Redis CI must pass for the revision being released. Live provider representative-case evaluations, production migrations/rollback, load/failover and real publish/restore drills remain separate gates. The original 100-item project is not complete. See `CARE-IMPLEMENTATION.md` and `upgrade-ledger.json` for the wider status. The customer and owner flow is also explained in [Tamil](USAGE-TA.md).
