# Chat and secure-access upgrade — implementation record

This branch implements the secure connection and specialist disclosure journey, a chat-first workspace, the Claude adapter, and durable activity for actual chat execution. **It does not complete the entire 100-item upgrade plan or implement autonomous website repairs.** The ledger currently marks 23 narrow acceptance items verified, 57 partially implemented, and 20 without implementation or verification. The item-by-item record is [upgrade-ledger.json](upgrade-ledger.json); the supplied requirements remain in [ZEROROOT-UPGRADE-PLAN.md](ZEROROOT-UPGRADE-PLAN.md).

Baseline: `e82be579fdcca3e6139cc74f74bc0e980ab69dab`. The original unit suite passed 89 tests in 16 files. Existing release-readiness documents are historical evidence; this branch does not convert their outstanding production gates into passes.

## Implemented behavior

The website conversation is the main workspace. It supports safe Markdown, code copying, scoped production/staging history, light/dark appearance, reduced motion, Tamil fonts, mobile menus, IME-safe input, and follow-at-bottom scrolling. Existing website pricing, findings, access, tickets, and settings remain reachable through Website options on small screens. Existing assessment actions navigate back to chat.

Secure capture sends labelled credential blocks or JSON directly to a deterministic parser and an authenticated encrypted vault. It does not call a model or append submitted credential text to chat. Confirmation grants read-only inspection for 24 hours. The receipt distinguishes storage from a successful connection. Duplicate request keys do not create duplicate accounts. Invalid input is discarded with a safe explanation; durable sensitive retries are deliberately not implemented.

Supported storage categories are SSH, SFTP, CMS, database, repository, API, and hosting accounts. This is a **storage-format capability**, not a claim that seven connectors work. Only the existing production SSH connector can consume a new vault reference. It requires a trusted host fingerprint and the existing outbound-address checks. A new credential identity replaces and revokes the old account and its grants. Existing access-form replacement/deletion also revokes linked vault records.

An actively assigned human specialist can request one exact account version for 5–60 minutes with a reason. The customer receives an actionable card from the database. Approval, current assignment, current account version, unexpired authority, enabled MFA, and a session MFA verification within five minutes are checked again by the reveal endpoint. Owner status provides no disclosure bypass. Specialists can now enroll an authenticator in Profile and verify their identity in Approved Access. Revealed values use a separate non-cacheable response, ephemeral component state, and hide after 30 seconds or on window blur. Copies outside the platform require external rotation.

Claude uses the official Anthropic Messages SDK behind the existing gateway. The owner configures the provider key and an available model; no key, model entitlement, or successful live provider connection is invented. Partial tool arguments are assembled and validated before execution. Both adapters bound tool calls, screen tool outputs, and accept cancellation. SDK retries are disabled, and the gateway does not replay tool-bearing requests. Text is buffered until screening completes; browser token streaming is not implemented.

Actual model-backed chat creates persisted A02 Customer Liaison activity. Heartbeats, pause/cancel requests, completion links, and stale execution states come from database records. Authenticated SSE resumes from a sequence cursor and filters tenant, website, and environment. A maintenance task expires credentials/grants, removes expired ciphertext, and marks lost workers stale without replaying work. Customer issues and expected behavior are recorded as scoped repair requests; corrections increment the plan version and invalidate prior approval fields. Repair requests remain explicitly blocked.

## Capability matrix

| Capability | This branch |
| --- | --- |
| Secure conversational storage and revocation | Implemented; opt-in rollout flag |
| Customer-approved named specialist reveal | Implemented with enrollment and fresh MFA |
| Existing production SSH observation connector | Reused through scoped broker references; fingerprint required |
| Other stored account types / staging connectors | Storage only; connection execution unavailable |
| Claude provider | Adapter and contract tests implemented; live smoke test outstanding |
| AI role catalogue | All 24 definitions retained; only A02 is enabled for chat |
| Proposed tool catalogue | All 64 entries retained and disabled pending implementation/evaluation |
| Existing assessment tools | Existing scoped tools remain separate from the proposed catalogue |
| Repair execution, source patches, isolated workers | Not implemented |
| Attachments and screenshot feedback | Not implemented; no upload path is advertised |
| Protected previews, independent candidate verification | Not implemented |
| Exact-artifact production release | Policy helper tested; release service not implemented |
| Full workflow cost reservation and reconciliation | Not implemented; existing AI request accounting remains |
| Knowledge retrieval and inter-agent dependency graph | Not implemented |
| Backup/recovery and production readiness | Existing gates remain outstanding |

## Verification recorded on 23 September 2026

| Check | Result and scope |
| --- | --- |
| `npm test` | 103 passing tests in 18 files, including 6 Anthropic contract tests and 8 care policy/vault tests |
| `npm run lint` | Passed |
| `npm run typecheck` | Passed across workspaces |
| `npm run build` | API, web, and worker production builds passed |
| Care API integration suite | 11 passing tests using actual authentication/routes and a disposable PGlite PostgreSQL-compatible database; all repository migrations applied |
| Care browser suite | 10 passing API-fixture browser journeys; secure intake, responsive widths, environment clearing, Markdown isolation, Tamil input, IME, navigation, themes, and disclosure clearing |
| `npm audit --omit=dev --audit-level=high` | Zero reported vulnerabilities in the checked dependency graph |
| OpenAPI generation | Passed using `node --import tsx apps/api/src/generate-openapi.ts`; generated specification updated |

The browser suite is not a live provider test and does not validate production secrets, DNS, SSH, billing, or deployment. The care integration suite verifies duplicate capture, staging/production history separation, cross-tenant denial, grants, real TOTP enrollment/step-up, reassignment denial, reveal/revocation, legacy replacement, expiry cleanup, stale worker handling, and real authenticated resumable SSE.

The complete integration suite was also attempted through PGlite: 15 tests passed, 4 failed, and 1 was skipped in that earlier run. The four failures included socket/protocol/connection errors after database operations in the PostgreSQL compatibility adapter. **The complete integration suite is not recorded as passing.** It must pass against the real PostgreSQL 16/Redis CI services. Production migration rollback, load, crash/race, accessibility assistive-technology, live provider, and recovery drills remain open. The normal Playwright browser installer could not complete in this workspace; local browser checks used an npm-distributed Chromium binary. The optional `CARE_CHROMIUM_EXECUTABLE` path exists only in the test runner.

## Remaining implementation, separate from configuration

Before a website repair can run, implement a supported isolated-worker backend with disposable filesystems, restricted outbound traffic and resource limits, controlled source snapshots, path-constrained patches, and independent test execution. Then add the repair-plan approval service, protected artifact and preview storage, feedback-to-candidate revision handling, exact candidate digest/source/environment binding, backup validation, deterministic deployment, immediate drift checks, and authoritative health/recovery reconciliation. Unit-tested release binding is only a policy primitive.

Additional product work includes attachment quarantine and privacy classification, reviewed tenant-scoped knowledge retrieval, coordinator dependencies, total-job budget reservation, tenant-scoped rollout policy administration, retention across artifacts/backups, monitoring authorization expiry, accessibility/recovery drills, and measured repair-quality benchmarks. Adding API keys alone will not complete this work.

The supported source/deployment stack, isolated worker service, preview origin/storage, production secret manager, and backup provider must be selected and provisioned before those integrations can be exercised. No live deployment was performed by this branch.

See [CARE-OPERATIONS.md](CARE-OPERATIONS.md) for configuration and rollback limitations.

## Browser fixture captures

These images show the local application with synthetic API fixtures, not a live customer or production connection.

![Desktop chat fixture](screenshots/care-desktop.png)

![Mobile chat fixture with Tamil input](screenshots/care-mobile.png)
