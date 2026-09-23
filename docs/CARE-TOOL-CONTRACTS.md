# Care tool contracts: implementation and setup

All 67 contracts are accounted for. **44 have bounded implementations or dedicated workflow bindings; 23 remain unavailable.** Compared with the previous 15-tool registry, this pass adds 19 new bounded handlers/proposal implementations and binds 10 contracts to existing application workflows. Narrower v2 contracts preserve the wider proposal in `proposedPurpose`; they do not claim the entire original roadmap.

- 24 source/policy tools: 23 offline handlers and T53 scoped recovery metadata.
- 9 tools read actual retained evidence and workflow records.
- 11 dedicated workflows retain their own permissions, setup and approval gates.
- No model-directed tool loop, generic shell, uploaded test execution or offensive workflow is enabled.

Implementation is distinct from deployment activation. The owner capability view reports deployment flags and requirements. Provider, CMS, commerce, browser and recovery evaluations cannot be certified by this registry. Existing history and encrypted artifacts remain retained; this pass adds no schema migration or dependency.

## Customer use

Open a website job and expand **Saved evidence & source tools**. Select the saved report, access-type inventory, release status, error codes or monitoring record you need. Missing records report NOT_OBSERVED. CSS token comparison needs two CSS paths in the same approved snapshot and an unexpired v4 review approval. T12 and T16 are available through the API for exact stored artifact comparison and plan binding checks.

For a production job, **Propose a monitoring schedule** saves a durable proposal in job history. It does not activate a schedule. Review it with the customer; an authorized operator separately configures the existing monitoring policy and verifies scheduler execution. Cancellation preserves the proposal.

New automatic source checks appear in the persisted deterministic-check report. Knowledge lookup contains only three bundled Care policy notes with exact revision matching, not current vendor documentation. SBOM and Prisma inventories are declarations, not installed/deployed facts.

## API contract

All HTTP entrypoints below have the `/v1` prefix and require an authenticated session. POST requests retain the application's CSRF and tenant permissions. No caller-supplied tenant, host, command or destination is accepted by the read dispatcher.

`POST /jobs/:id/tools/:toolId` accepts a strict JSON object:

| Tools | Arguments | Authority |
| --- | --- | --- |
| T03, T05, T51, T56, T57, T58, T62 | `{}` | chat.read; current tenant and active website |
| T12 | baselineArtifactId, candidateArtifactId: UUIDs | Same job/site/environment, retained artifacts, verified stored hashes |
| T16 | revisionId: UUID; sourceDigest: SHA-256 | Revision belongs to the current job |
| T06 | query: 2–120 characters | Current source-review approval |
| T07 | id: source-evidence, candidate-approval or recovery-history; version: care-policy-notes-v1 | Current source-review approval |
| T10 | path; optional startLine/endLine | Exact approved source path and range |
| T11 | text; optional path | Bounded literal search in approved source |
| T30 | baselinePath, candidatePath | Two distinct approved CSS paths |
| Other implemented source tools | `{}` | websites.manage + ai.use, enabled review, exact current unexpired v4 approval |

Outputs contain toolId, jobId, observedAt and output. T10 is capped at 250 KB; other dispatcher outputs at 64 KB. Oversized results fail explicitly. Individual report views retain full saved results. Dedicated artifact routes retain existing upload/download limits rather than the dispatcher limit. Unsupported/dedicated operations cannot be invoked through this read-only dispatcher.

`POST /jobs/:id/monitoring-plan` takes requestKey (UUID), intervalMinutes and alertCooldownMinutes (integers 5–10080), and expectedStatus (100–599, default 200). It requires websites.manage and a production job. Same-key/same-input retries return the persisted proposal; different input with the same key is rejected. At most 10 outstanding proposals per website; cancel to close one without deleting history. No endpoint in this pass approves or applies these proposals.

## Verification and rollout

- Unit coverage checks source-only parsing, bounded reports, CSS path confinement, local-only OpenAPI references, versioned policy notes and exhaustive registry accounting.
- API tests exercise real authentication and disposable PostgreSQL-compatible storage: tool approvals, cross-job/tenant rejection, artifact integrity, persisted findings, stale monitoring, redacted error codes, idempotent proposals and retained cancellation. Model and remote adapters remain fixtures.
- Browser tests exercise evidence controls, consent before saving proposals, reload continuity, source/repair journeys, homepage coverage and accessibility checks in development and production.
- Deploy API/web/worker together. Source-review policy is v4: unfinished older plans must be recreated and approved; their saved results remain readable. Existing preserved-history migration and matching encryption keys remain required.
- Remaining 23 contracts need actual implementation/evaluation and the prerequisites listed below. Installing library names or connecting a ChatGPT plugin does not provision those services inside this application.

## Complete implementation matrix

| ID | Contract | Actual implemented scope | Entry point / missing prerequisite |
| --- | --- | --- | --- |
| T01 | case_get_summary | Read the sanitized current case and unresolved questions. | POST /jobs/:id/tools/T01. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T02 | environment_get_manifest | Read the bound environment, source revision, and supported capabilities. | POST /jobs/:id/tools/T02. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T03 | access_get_capabilities | Credential types and capability metadata only; never account secrets or live access. | POST /jobs/:id/tools/T03. Requires: Authenticated tenant/site access; Recorded evidence in this job or environment |
| T04 | case_get_authorizations | Read applicable grants and their expiry without modifying them. | POST /jobs/:id/tools/T04. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T05 | findings_list_evidence | Bounded persisted source findings and artifact references; no runtime verification. | POST /jobs/:id/tools/T05. Requires: Authenticated tenant/site access; Recorded evidence in this job or environment |
| T06 | knowledge_search_reviewed | Search the bundled, versioned Care policy notes; no external vendor or cross-customer knowledge. | POST /jobs/:id/tools/T06. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T07 | knowledge_get_versioned_doc | Read an exact bundled Care policy note revision and provenance. | POST /jobs/:id/tools/T07. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T08 | case_propose_plan | Persist a static HTML or uploaded-source plan; customer approval starts work. | POST /jobs/:id/change-plan; POST /websites/:websiteId/reviews. Requires: CARE_REPAIR_ENABLED or CARE_REVIEW_ENABLED; Configured model and prices; Authorized source and budget |
| T09 | source_list_files | List permitted paths in the sanitized source snapshot. | POST /jobs/:id/tools/T09. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T10 | source_read_sanitized | Read bounded source ranges while excluding secret-bearing files. | POST /jobs/:id/tools/T10. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T11 | source_search_symbols | Search approved source paths and return bounded matches. | POST /jobs/:id/tools/T11. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T12 | source_diff_snapshot | Compare hashes and changed paths of two authorized stored artifacts in the same job. | POST /jobs/:id/tools/T12. Requires: Authenticated tenant/site access; Recorded evidence in this job or environment |
| T13 | workspace_create | **Unavailable** | No disposable multi-file workspace service is provisioned. Needs tenant isolation, quotas, lifecycle cleanup and evaluated execution profiles. |
| T14 | workspace_apply_patch | **Unavailable** | No general patch workspace exists. Needs approved paths, base digest, conflict checks and isolated candidate storage; static HTML repair is separate. |
| T15 | workspace_create_candidate | Package one validated index.html candidate as an encrypted artifact. No general repository commits. | Approved static HTML repair worker → runOneRepair. Requires: CARE_REPAIR_ENABLED; Exact approved static HTML plan; Configured provider |
| T16 | workspace_check_conflicts | Check persisted plan version and source digest conflicts; no live Git merge or ownership checks. | POST /jobs/:id/tools/T16. Requires: Authenticated tenant/site access; Recorded evidence in this job or environment |
| T17 | security_review_source | Reviewed JS/TS AST patterns for dynamic evaluation and raw HTML sinks; no data-flow or exploit analysis. | POST /jobs/:id/tools/T17. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T18 | security_review_config | Versioned defensive configuration line patterns; observations require contextual review. | POST /jobs/:id/tools/T18. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T19 | dependencies_inventory | Read manifests and lockfiles into a normalized package inventory. | POST /jobs/:id/tools/T19. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T20 | dependencies_match_advisories | **Unavailable** | No approved advisory dataset/feed adapter is connected. Needs ecosystem/version normalization, freshness, provenance and applicability tests. |
| T21 | secrets_scan_local | Check authorized source for secrets; return redacted locations only. | POST /jobs/:id/tools/T21. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T22 | supplychain_inventory_image | Inventory top-level CycloneDX/SPDX JSON declarations; no image extraction or advisory feed. | POST /jobs/:id/tools/T22. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T23 | http_check_configuration | **Unavailable** | No Care-bound HTTP observation adapter is implemented. Needs fixed verified targets, DNS/redirect/response limits and consent; no arbitrary URL tool. |
| T24 | tls_get_summary | **Unavailable** | No Care-bound TLS adapter is implemented. Needs a fixed verified host, certificate-chain validation and timestamped evaluation. |
| T25 | preview_open_bound | **Unavailable** | No disposable restricted preview browser service is provisioned. Static HTML iframe preview is available through T52. |
| T26 | browser_get_accessibility_snapshot | **Unavailable** | Needs T25 plus sanitized browser accessibility-tree extraction and privacy tests. |
| T27 | browser_capture_sanitized_screenshot | **Unavailable** | Needs T25 plus approved viewports, reliable private-region masking, retention and screenshot evidence tests. |
| T28 | browser_run_registered_journey | **Unavailable** | Needs T25 plus a reviewed journey registry, synthetic fixtures and bounded execution. Customer scripts are not executed. |
| T29 | design_compare_viewports | **Unavailable** | Needs approved baseline/candidate screenshots from a reproducible renderer and an evaluated image comparison profile. |
| T30 | design_compare_tokens | Compare custom-property declarations in two supplied CSS files; no rendering or computed cascade. | POST /jobs/:id/tools/T30. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T31 | accessibility_run_checks | Check static HTML language, alt, iframe title and ID references; browser accessibility assessment is separate. | POST /jobs/:id/tools/T31. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T32 | content_check_links | Check local fragment links against IDs in supplied HTML; no fetching or route validation. | POST /jobs/:id/tools/T32. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T33 | quality_run_lint | **Unavailable** | No disposable lint worker/profile registry is provisioned. Needs pinned rules without customer plugins, resource limits and isolation tests. |
| T34 | quality_run_typecheck | **Unavailable** | No isolated project type-check profile is provisioned. T65 supplies syntax checks only. |
| T35 | quality_run_unit_tests | **Unavailable** | No isolated registered unit-test worker is provisioned. Application CI tests this product; it does not execute uploaded customer tests. |
| T36 | quality_run_integration_tests | **Unavailable** | No isolated integration-test worker with disposable test services is provisioned. |
| T37 | quality_run_build | **Unavailable** | No isolated reproducible build worker with pinned dependencies and restricted package scripts is provisioned. |
| T38 | api_validate_contract | Basic OpenAPI 3 JSON structure and reference existence; no full schema or compatibility validation. | POST /jobs/:id/tools/T38. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T39 | api_run_fixture_checks | **Unavailable** | No registered API fixture runner exists. Needs isolated services, synthetic data and explicit expected outcomes. |
| T40 | performance_compare_runs | **Unavailable** | No controlled performance-profile runner/baseline store exists. No production load testing is supported. |
| T41 | cms_get_inventory | **Unavailable** | No CMS-specific read-only inventory connector is connected or evaluated. |
| T42 | cms_compare_trusted_files | **Unavailable** | Needs a supported CMS connector and authenticated trusted package manifests/artifacts. User-supplied files alone do not establish trusted provenance. |
| T43 | cms_prepare_approved_update | **Unavailable** | Needs a supported CMS staging connector, exact update approval, compatibility evaluation and recovery evidence. |
| T44 | commerce_run_test_checkout | **Unavailable** | Needs a supported commerce sandbox account, registered synthetic checkout journey and proof that real transactions/messages are disabled. |
| T45 | database_get_schema | Inventory supplied Prisma declaration names; no live schema connection or customer rows. | POST /jobs/:id/tools/T45. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T46 | database_check_migration_compatibility | **Unavailable** | Needs isolated disposable database profiles, synthetic fixtures and approved migration/recovery checks. No customer database is queried. |
| T47 | infra_review_manifest | Versioned container and infrastructure text patterns; no live infrastructure changes. | POST /jobs/:id/tools/T47. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T48 | integration_test_fixture | **Unavailable** | Needs a provider-specific registered fixture adapter and test account configuration. No generic external request runner is available. |
| T49 | evidence_record_candidate | Register the validated candidate with SHA-256, creator, job and environment provenance. | Static HTML repair worker → writeArtifact. Requires: CARE_REPAIR_ENABLED; Artifact encryption key and quota; Validated candidate |
| T50 | evidence_get_artifact | Authorized retained artifact bytes with integrity validation; no public download URL. | GET /artifacts/:id/content. Requires: CARE_REPAIR_ENABLED; Authorized artifact; Artifact decryption key |
| T51 | review_get_change_summary | Compare the exact saved candidate/source hashes and attached static verification. | POST /jobs/:id/tools/T51. Requires: Authenticated tenant/site access; Recorded evidence in this job or environment |
| T52 | preview_publish_candidate | Return validated static HTML for the private sandboxed preview. No hosted app, scripts, forms or network. | GET /artifacts/:id/preview. Requires: CARE_REPAIR_ENABLED; Authorized static HTML artifact |
| T53 | recovery_get_readiness | Read actual backup/restore readiness; never fabricate a restore point. | POST /jobs/:id/tools/T53. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T54 | release_prepare_manifest | Persist a single-file SFTP release proposal bound to the verified candidate, path and account; no deployment. | POST /jobs/:id/releases. Requires: CARE_REPAIR_ENABLED and CARE_RELEASE_ENABLED; Verified candidate/site; Current fingerprint-pinned account |
| T55 | release_request_approval | Publish the saved release approval card in Care. Separate customer approval and fresh MFA are mandatory. | POST /jobs/:id/releases → release.approval_required. Requires: Same prerequisites as T54; Customer must separately approve |
| T56 | release_get_status | Read saved single-file release status; no new post-deployment probe. | POST /jobs/:id/tools/T56. Requires: Authenticated tenant/site access; Recorded evidence in this job or environment |
| T57 | observability_get_redacted_errors | Read bounded Care job/agent/release error codes; no raw logs or telemetry export. | POST /jobs/:id/tools/T57. Requires: Authenticated tenant/site access; Recorded evidence in this job or environment |
| T58 | observability_get_health | Read saved production monitoring signals with timestamps and staleness; no live check. | POST /jobs/:id/tools/T58. Requires: Authenticated tenant/site access; Recorded evidence in this job or environment |
| T59 | workflow_get_status | Read persisted workflow state, blockers, and active tasks. | POST /jobs/:id/tools/T59. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T60 | workflow_request_pause | Persist a stop request and fence future steps. In-flight costs or external effects can remain uncertain. | POST /jobs/:id/pause. Requires: Nonterminal authorized job |
| T61 | specialist_request_handoff | Customer submits a screened support request to the human ticket queue. No automatic assignment, secret grant or repair. | POST /websites/:websiteId/tickets. Requires: tickets.create permission; Customer-reviewed, sanitized title and description |
| T62 | report_prepare_summary | Prepare a summary from actual retained source reports with artifact references. | POST /jobs/:id/tools/T62. Requires: Authenticated tenant/site access; Recorded evidence in this job or environment |
| T63 | feedback_attach_issue | Persist repair feedback and invalidate earlier approvals. A new plan is required; old history is retained. | POST /jobs/:id/feedback. Requires: Authorized REPAIR job; Sanitized feedback |
| T64 | monitoring_propose_plan | Save a monitoring proposal in job history. Does not schedule checks, contact a host or change the live policy. | POST /jobs/:id/monitoring-plan. Requires: websites.manage permission; Customer must review the proposal; Operator configures the approved monitoring policy separately |
| T65 | source_check_syntax | Parse approved JSON and JS/TS/JSX/TSX text in memory; no imports, type checking or execution. | POST /jobs/:id/tools/T65. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T66 | design_check_css | Parse standalone CSS without plugins, source maps or rendering. | POST /jobs/:id/tools/T66. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
| T67 | source_check_yaml | Parse supplied YAML documents with duplicate-key diagnostics; no alias expansion, custom tag resolution, schema validation or execution. | POST /jobs/:id/tools/T67. Requires: Current exact source-review approval; CARE_REVIEW_ENABLED; Authorized sanitized source |
