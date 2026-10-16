# Tools, continuity and defensive recovery

The application has 24 source-review roles and 67 registered tool contracts. Forty-four contracts have bounded implementations or dedicated workflow bindings: 24 source/policy tools, 9 saved-evidence tools and 11 dedicated workflows. Twenty-three wider contracts remain unavailable. The [complete contract matrix](CARE-TOOL-CONTRACTS.md) records every boundary, entrypoint and missing prerequisite. More role names do not establish better accuracy; evaluate the existing roles against representative approved cases and inspect false positives, missed issues, citations and actual cost.

## Installed and exercised components

| Component | Purpose | Verification boundary |
| --- | --- | --- |
| TypeScript 5.9.3 compiler API | T65 parses JS/TS/JSX/TSX using an in-memory host | No filesystem, imports, tsconfig, plugins, emit or runtime execution; syntax only |
| Strict JSON parser | T65 checks JSON syntax | Does not validate an application's business schema |
| PostCSS 8.5.27 | T66 parses standalone CSS | No plugins, source-map loading, external imports or browser rendering |
| yaml 2.9.0 | T67 checks supplied YAML documents and duplicate keys | No alias expansion, custom tags, templates, platform schemas or pipeline execution |
| parse5 8.0.1 | T31 static HTML language/alt/title/ID references; T32 local fragments | Not accessible-name computation, link crawling or WCAG certification |
| @axe-core/playwright | Automated WCAG-tagged checks of the Care UI in mobile/desktop and light/dark states | UI fixture tests; manual keyboard, screen-reader and inclusive-user evaluation still required |
| Vitest 4.1.11, Playwright, PostgreSQL/Prisma, Redis | Application contracts, browser journeys, persisted steps and CI | Provider and SFTP adapters in automated Care tests are fixtures |
| T53 recovery metadata | Retained verified-backup records, schedules, recorded monitoring and unresolved releases | No backup-byte revalidation, clean-state determination, live health check or restore |

All diagnostic outputs are bounded. Unsupported files return `NOT_APPLICABLE`; a parser problem returns an observation rather than a fabricated success. Every tool remains bound to the approved tenant, website, environment and source. Source-review policy v4 fences old unfinished v1/v2/v3 plans; saved results remain available, but further model work needs a newly approved plan.

Run the ordinary CI gates and `npm run test:accessibility`. In an actual configured deployment, run `npm run care:preflight -- TENANT_UUID`. The command reports database schema, preserved-history migration, worker heartbeat, Redis, model pricing/configuration and missing live-validation evidence. It does not make a model call or operate a customer host.

CI now audits production and development dependencies with `npm audit --audit-level=moderate`. The previous Vitest 3 test dependency and its mocker carried a moderate advisory; the test stack is pinned to the patched 4.1.11 release. A clean advisory report describes the checked dependency graph at that time, not the absence of all possible application vulnerabilities.

## Saved work and history

- The latest 200 messages load first in chronological display order. **Load older messages** reaches every preceding page using stable time/ID cursors.
- The latest 30 jobs load in the chosen environment. **Load older jobs** reaches previous submitted work and its saved reports.
- Messages, submitted jobs, source, reports, candidates and Care release recovery evidence are stored server-side. Closing the tab does not cancel already-approved worker jobs. Reopen the same website with an authorized account to continue.
- Unsent drafts, file-picker selections and credential input are not saved in browser storage. A lost HTTP response is not proof that a submission failed; inspect saved activity before retrying.
- Maintenance no longer deletes Care artifacts by age. Storage quotas reject new uploads instead of deleting existing evidence. Explicit website/account deletion and database-backup retention are separate lifecycle policies.
- Credential expiry/revocation and approval deadlines remain enforced. Preserving evidence does not preserve expired authority.

Apply migration `20260923030000_care_preserve_history` with all old maintenance workers stopped, then deploy compatible API/web/worker instances together. The migration clears deadlines for accepted artifacts; content already wiped by an earlier worker cannot be recreated. Retain protected backups of the database and matching encryption keys. Never use a destructive down migration to roll back this change.

## Recovery and prevention workflow

1. Restrict exposure through the hosting provider and preserve incident logs, source snapshots and the relevant timeline. Avoid overwriting evidence during recovery.
2. Review account/session access with the owner and provider; revoke unauthorized sessions and replace compromised credentials through their secure controls.
3. Identify a known clean source version and suitable verified backup. A recently created backup may still contain compromised material; T53 deliberately does not mark it clean.
4. Restore and validate in an isolated staging environment, reconcile required data, patch supported dependencies, review access control and configuration, and run the site's registered functional tests.
5. Obtain the specific deployment approval after reviewing evidence and rollback readiness. The current deterministic Care release supports a single static HTML file only; other systems require a supported deployment workflow and specialist oversight.
6. Verify the live outcome and monitor for recurrence. Keep backups and practice restoration separately from model source reviews.

The application does not promise that every compromise is detected or that future compromise is impossible. Model review is advice, not proof of remediation.

## Figma and MCP integrations

Figma is useful for approved design references and human comparison. A ChatGPT Figma connection is a workspace connector; it does not install an MCP server or OAuth credentials inside Zerochack. This change does not claim a Figma-file import or render comparison without a supplied design reference. Codex Security can support a separate authorized defensive review after its connection is completed; it is not a runtime dependency of this app.

A production MCP adapter still needs a concrete provider, tenant-scoped authorization, least-privilege tools, a trusted endpoint/transport, secret storage, bounded outputs, timeouts, audit records and revocation. No arbitrary MCP URL launcher, shell tool or automatic installation of unreviewed servers has been added. The current deterministic tools are ordinary internal handlers, not a claimed complete MCP implementation.

Primary references reviewed for the implementation:

- [Playwright accessibility testing](https://playwright.dev/docs/accessibility-testing)
- [TypeScript compiler API](https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API)
- [YAML document parser and options](https://eemeli.org/yaml/)
- [PostCSS parser API](https://postcss.org/api/)
- [parse5 source locations](https://parse5.js.org/interfaces/parse5.ParserOptions.html)
- [MCP authorization specification](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2025-11-25/basic/authorization.mdx)


## Retained text workspace

T13/T14 create customer-authorized staging text copies and append literal patches. T33/T34 save real fixed static lint/type-check results bound to exact versions. Saved versions/reports survive reload and closure; unsent edits do not. No workspace code executes or deploys. T29 compares sanitized same-job screenshot pixels; capture provenance remains unverified. See [tool contract matrix](CARE-TOOL-CONTRACTS.md) for all 49 implemented/bound modes, 18 unavailable contracts and exact limits. Apply migration `20260923040000_care_text_workspace` before deploying this increment.
