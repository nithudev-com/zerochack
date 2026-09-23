# Chat and secure-access upgrade — implementation record

This branch implements the secure connection and specialist disclosure journey, a chat-first workspace, the Claude adapter, durable activity for actual chat execution, a bounded standalone HTML repair workflow, and approved text-source reviews across all 24 roles. **It does not complete the entire 100-item upgrade plan and does not provide general autonomous application repair.** The ledger currently marks 23 narrow acceptance items verified, 70 partially implemented, and 7 without implementation or verification. The item-by-item record is [upgrade-ledger.json](upgrade-ledger.json); the supplied requirements remain in [ZEROROOT-UPGRADE-PLAN.md](ZEROROOT-UPGRADE-PLAN.md).

Baseline: `e82be579fdcca3e6139cc74f74bc0e980ab69dab`. The original unit suite passed 89 tests in 16 files. Existing release-readiness documents are historical evidence; this branch does not convert their outstanding production gates into passes.

## Implemented behavior

The website conversation is the main workspace. It supports safe Markdown, code copying, scoped production/staging history, light/dark appearance, reduced motion, Tamil fonts, mobile menus, IME-safe input, and follow-at-bottom scrolling. Existing website pricing, findings, access, tickets, and settings remain reachable through Website options on small screens. Existing assessment actions navigate back to chat.

Portal browser journeys follow the current overview headings and mobile menus. Decorative navigation initials/numbers are hidden from accessible link names. The Owner dashboard no longer displays a hardcoded 98/100 security score; it shows the recorded open-alert count and links to actual System Health checks.

Secure capture sends labelled credential blocks or JSON directly to a deterministic parser and an authenticated encrypted vault. It does not call a model or append submitted credential text to chat. Confirmation grants read-only inspection for 24 hours. The receipt distinguishes storage from a successful connection. Duplicate request keys do not create duplicate accounts. Invalid input is discarded with a safe explanation; durable sensitive retries are deliberately not implemented.

Supported storage categories are SSH, SFTP, CMS, database, repository, API, and hosting accounts. This is a **storage-format capability**, not a claim that seven connectors work. Only the existing production SSH connector can consume a new vault reference. It requires a trusted host fingerprint and the existing outbound-address checks. A new credential identity replaces and revokes the old account and its grants. Existing access-form replacement/deletion also revokes linked vault records.

An actively assigned human specialist can request one exact account version for 5–60 minutes with a reason. The customer receives an actionable card from the database. Approval, current assignment, current account version, unexpired authority, enabled MFA, and a session MFA verification within five minutes are checked again by the reveal endpoint. Owner status provides no disclosure bypass. Specialists can now enroll an authenticator in Profile and verify their identity in Approved Access. Revealed values use a separate non-cacheable response, ephemeral component state, and hide after 30 seconds or on window blur. Copies outside the platform require external rotation.

Claude uses the official Anthropic Messages SDK behind the existing gateway. The owner configures the provider key and an available model; no key, model entitlement, or successful live provider connection is invented. Partial tool arguments are assembled and validated before execution. Both adapters bound tool calls, screen tool outputs, and accept cancellation. SDK retries are disabled, and the gateway does not replay tool-bearing requests. Text is buffered until screening completes; browser token streaming is not implemented.

Actual model-backed chat creates persisted A02 Customer Liaison activity. Heartbeats, pause/cancel requests, completion links, and stale execution states come from database records. Authenticated SSE resumes from a sequence cursor and filters tenant, website, and environment. A maintenance task expires credentials/grants, removes expired ciphertext, and marks lost workers stale without replaying work. Customer issues and expected behavior are recorded as scoped repair requests; corrections increment the plan version and invalidate prior approval fields. When CARE_REPAIR_ENABLED is enabled, the supported standalone HTML workflow described below can execute. Unsupported application stacks remain blocked.

## Capability matrix

| Capability | This branch |
| --- | --- |
| Secure conversational storage and revocation | Implemented; opt-in rollout flag |
| Customer-approved named specialist reveal | Implemented with enrollment and fresh MFA |
| Existing production SSH observation connector | Reused through scoped broker references; fingerprint required |
| Other stored account types / staging connectors | Storage only; connection execution unavailable |
| Claude provider | Adapter and contract tests implemented; live smoke test outstanding |
| AI role catalogue | All 24 roles execute bounded source reviews; A02 chat and A08 static HTML repair remain separate modes |
| Proposed tool catalogue | 44 bounded source/evidence/workflow contracts; 23 wider interfaces unavailable; see CARE-TOOL-CONTRACTS.md |
| Existing assessment tools | Existing scoped tools remain separate from the proposed catalogue |
| Repair execution and source patches | Static HTML data-only runner implemented; disposable execution workers unavailable |
| Attachments | Validated encrypted HTML, screenshots and redacted logs; privacy review required |
| Protected previews and independent verification | Opaque sandbox previews and fixed structural checks implemented; visual/behavior review remains human |
| Exact candidate release | Single-file SFTP service implemented; real-host validation outstanding |
| Cost reservation | Repair model allowance implemented; infrastructure/legacy concurrency accounting remains |
| Knowledge retrieval and inter-agent dependency graph | Persisted sequential source-review dependencies implemented; reviewed retrieval and dynamic scheduling remain unavailable |
| Backup/recovery and production readiness | Existing gates remain outstanding |

## Verification recorded on 23 September 2026

| Check | Result and scope |
| --- | --- |
| `npm test` | 135 passing tests in 22 files, including Anthropic contracts, care policy/vault checks, static candidate validation and SFTP transport contracts |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed across workspaces |
| `npm run build` | API, web, and worker production builds passed |
| `npm run test:integration` | 36 Care tests passed locally against PGlite with fixture providers/remotes; the current PR CI checks run the full suite against PostgreSQL 16/Redis 7, with one opt-in live scan excluded |
| Care browser suite | 16 passing API-fixture browser journeys, including axe accessibility checks and complete history pagination; protected repair previews, exact plan approval, secure intake, responsive widths, environment clearing, Markdown isolation, Tamil input, IME, navigation, themes, and disclosure clearing |
| `npm audit --omit=dev --audit-level=high` | Zero reported vulnerabilities in the checked dependency graph |
| OpenAPI generation | Passed using `node --import tsx apps/api/src/generate-openapi.ts`; generated specification updated |

The browser suite is not a live provider test and does not validate production secrets, DNS, SSH, billing, or deployment. The care integration suite verifies duplicate capture, staging/production history separation, cross-tenant denial, grants, real TOTP enrollment/step-up, reassignment denial, reveal/revocation, legacy replacement, expiry cleanup, stale worker handling, and real authenticated resumable SSE.

The full integration suite passed against the real PostgreSQL 16/Redis services in [GitHub CI run 35837889941](https://github.com/nithudev-com/zerochack/actions/runs/35837889941). This resolves the earlier local PGlite socket/protocol failures. That run exposed a browser-test configuration issue: the browser used `localhost` while the API allowed `127.0.0.1`. The test runner now uses one loopback hostname for the browser, API and CORS allowlist. A subsequent CI run exposed intermittent create/read failures because several Care routes sent HTTP success before the database transaction committed. Job, plan, review, release and specialist-access creation now wait for commit before sending a response. Two additional rollback/retry regression checks bring the local Care integration suite to 33 passing tests. The [pull request checks](https://github.com/nithudev-com/zerochack/pull/1/checks) provide the current full-suite and browser verdict for each published revision.

Production migration rollback, load, crash/race, accessibility assistive-technology, live provider, and recovery drills remain open. The normal Playwright browser installer could not complete in this workspace; local Care browser checks used an npm-distributed Chromium binary. The optional `CARE_CHROMIUM_EXECUTABLE` path exists only in the test runner.

## Approved multi-role source review

All 24 roles can run customer-approved text-source reviews through the real gateway integration. Source snapshots and reports are encrypted, approvals bind exact scope/model/allowance, and each step is checkpointed in PostgreSQL. Twenty-three offline source/policy tools and one scoped recovery-metadata tool are available; the deterministic runner selects a fixed subset for each approved review. Strict result schemas reject fabricated file/line quotations. Later roles receive prior summaries as untrusted context and must cite source independently. Reports expose missing evidence and do not certify model conclusions, tests or repairs.

The customer can choose all roles or a smaller team and request Tamil or English reports. The team panel no longer truncates the assigned team at twelve roles. Worker claims serialize reviews and static repairs per website. A source-screening expression was bounded to avoid excessive processing on long text. A read-only `care:preflight` command reports missing deployment configuration. See [CARE-SOURCE-REVIEWS.md](CARE-SOURCE-REVIEWS.md) for usage, limits and rollout.

## Supported static HTML repair workflow

A customer records the issue, uploads reviewed UTF-8 HTML (up to 200 KB), and approves a versioned plan bound to the source digest, selected model configuration, expected behavior and model allowance. Optional PNG/JPEG screenshots are decoded, resized within limits and re-encoded without metadata; redacted logs are bounded. Screenshots and logs are for human review and are not sent to the model. Upload validation happens before acceptance, with a 200-artifact/50 MB tenant quota and encrypted storage. This is synchronous validation, not a durable asynchronous quarantine service.

The durable worker claims a job with a lease, invokes A08 once through the configured AI gateway, and applies bounded unique-anchor replacements. It never executes uploaded code, scripts, build tools or a shell. Server checks reject dynamic/executable content, external resources and basic structural defects. The candidate is stored encrypted; its raw patch is excluded from chat and AI usage response storage. The approval reserves model cost; known usage settles even when checks fail, while uncertain cost stays reserved. Infrastructure charges and concurrent legacy chat reservations remain outside this accounting.

The authenticated UI displays before/after HTML inside opaque-origin sandboxed iframes with restrictive CSP. Tests verify script blocking, blocked remote image requests, inaccessible frame DOM, mobile width and explicit approval. The customer must review appearance and intended behavior; static checks do not prove visual quality, functionality or full accessibility.

With the separate release flag enabled, a customer selects a fingerprint-pinned production SSH account and a visible absolute path ending in index.html. Fresh MFA and explicit approval bind source/candidate hashes, current plan and account version, target path, public website URL and conditional rollback. The deterministic worker verifies that the remote file and public HTML response exactly match the approved source, saves and decrypt-verifies the original, takes a remote exclusive lock, checks for drift again, and uses the OpenSSH atomic-rename extension. Unsupported atomic overwrite fails closed. Health requires HTTP 200, HTML content type and the exact candidate hash; transformed/minified/cache-modified pages are unsupported.

Failed candidate health triggers the specifically approved conditional restore, only while the remote file still matches the candidate. Uncertain writes become OUTCOME_UNKNOWN, retain recovery material and block another website release. Reconciliation observes remote/public hashes and removes only the matching release lock; it does not replay replacement. The API integration tests use a simulated remote transport and a fixture model adapter through the real gateway. SFTP unit tests cover its callback contract. No real SSH endpoint, provider account, public deployment or disaster-recovery drill was exercised.

## Remaining implementation and external gates

General frameworks, JavaScript applications, multi-file repositories, databases and build systems still need a provisioned disposable execution worker and independent runtime/browser verification. The wider engineering capabilities of review-only roles, 23 proposed general tool interfaces, dynamic coordinator graphs, external reviewed knowledge retrieval, full infrastructure billing, asynchronous attachment quarantine and broader operational controls remain incomplete. No implementation catalogue entry substitutes for these services.

Before enabling production release, run the full integration suite against PostgreSQL 16/Redis, use a real provider account with configured prices, test a disposable SFTP/static-host target and rollback, establish an exclusive deployment window, verify key/backup retention, and complete crash/failover and authorization-expiry drills. A separate external writer can race SFTP; it must be excluded operationally because ordinary SFTP cannot atomically compare and swap against unrelated writers. Neither static checks nor this branch certify production readiness.

See [CARE-OPERATIONS.md](CARE-OPERATIONS.md) for opt-in configuration, retention and recovery procedures.

## Browser fixture captures

These images show the local application with synthetic API fixtures, not a live customer or production connection.

![Desktop chat fixture](screenshots/care-desktop.png)

![Mobile chat fixture with Tamil input](screenshots/care-mobile.png)


## Saved history, deterministic diagnostics and recovery evidence

Case artifacts no longer expire automatically. Stable tenant/site/environment cursors expose all older messages and jobs; initial chat reads now return the latest 200 messages rather than silently stopping at the first 200. Browser closure does not cancel approved worker jobs. Unsent drafts and credential inputs are intentionally excluded from persistent browser storage. A maintenance/API-restart test preserves encrypted source and reports beyond one year.

Five additional handlers cover static HTML semantics, local fragment links, source syntax, CSS syntax and actual scoped recovery metadata. The registry now contains 66 contracts: 14 implemented, 52 disabled. `@axe-core/playwright` adds automated WCAG checks of the actual Care UI in mobile/desktop and light/dark states; those checks found and fixed a theme-transition contrast failure. They do not certify all accessibility needs. See [tools and recovery setup](CARE-TOOLS-AND-RECOVERY.md).


## Homepage technology coverage follow-up

Preserves the user's `858e746` homepage, directory and SEO redesign. The 12 technology areas now share their input examples and real role/check mappings with the customer source-review form. Counts are derived from the implemented registry. Expanded native text formats close the gap between the listed technologies and upload acceptance; browser/API path validation is shared. T67 adds bounded offline YAML checks using pinned yaml 2.9.0. Current totals: 24 source-review roles, 67 contracts, 15 implemented tools and 52 unavailable wider tools. This is source-review coverage, not certified live integrations or general autonomous repair.

Source-review policy is v3; unfinished older plans need a new approval, while saved history and existing completed reports remain available. Homepage search/filter/reset, keyboard examples, navigation, SEO data and mobile/desktop automated accessibility are included in CI. See CARE-SOURCE-REVIEWS.md for current verification counts and rollout requirements.

A production-mode check found that the existing `script-src self` policy blocked Next.js hydration scripts, leaving the homepage on its loading fallback. A request proxy now generates a fresh nonce and overrides caller nonce/CSP headers; document rendering is dynamic so the nonce matches the response. Homepage JSON-LD receives that nonce. Script protections stay strict, and pages must not be cached as shared static HTML. CI now runs the full Care/home browser suite against both dev and the built production server, including nonce rotation and actual search interaction.

## Tool contract implementation pass

The current matrix is [CARE-TOOL-CONTRACTS.md](CARE-TOOL-CONTRACTS.md), which supersedes counts in earlier dated implementation entries. Of the previously unavailable 52 contracts, 19 now have new bounded handlers/proposal code and 10 are explicitly bound to existing dedicated application workflows. Total: 44 bounded implementations/bindings and 23 unavailable contracts. The narrower v2 boundaries are explicit; this does not fulfill the general execution roadmap. Policy v4 approvals include the expanded deterministic source context. Customer evidence tools and saved monitoring proposals are accessible from each job; owner capabilities show deployment flags, entrypoints and missing dependencies. No generic source execution, offensive automation, external MCP server or live-provider configuration is introduced.


## Retained text-workspace increment

Current total: **49 bounded implementations/workflow bindings; 18 unavailable contracts**. T13 creates a scoped staging text copy with explicit customer consent. T14 appends exact-digest literal patches and retains all prior versions. T33/T34 run fixed lint and semantic TypeScript snapshot checks with worker resource limits, retain reports and never execute customer code. T29 compares actual sanitized same-job PNG pixels without claiming renderer/capture provenance. These narrower v2 modes are explicit in the registry; original proposed purposes remain visible.

Workspace history, authenticated downloads, stale-source conflicts, idempotency, concurrency, closed-workspace fencing, quotas and artifact integrity are covered by tests. Apply migration 20260923040000_care_text_workspace before rollout. It admits zero-cost unapproved manual text drafts only; model budget constraints remain. TypeScript 5.9.3 is explicitly pinned as an API runtime dependency. Source-review policy remains v4 because model context and model approval scope are unchanged.
