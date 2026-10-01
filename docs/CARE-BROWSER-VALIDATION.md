# Static browser increment validation

Date: 2026-09-28. Base: `592055cbe1a9dc17624fe5bf80c6979744430e05` on `codex/zeroroot-chat-care-upgrade`.

This increment adds bounded T25–T28 workflows, raising the registry from 52 to 56 implemented/bound contracts. Eleven contracts remain unavailable. All 24 source-review roles retain their existing bounded mode; no new model-directed execution loop is added.

Local verification:

- **199 unit tests passed**, including exact registry accounting, browser opt-in configuration, secret-key separation and production launcher boundaries.
- **10 new API integration tests passed** using disposable migration-backed PGlite and a deterministic renderer. Authentication, both consents, cross-tenant/cursor/source rejection, stale revisions, cancellation/session/source changes during capture, encrypted reports/screenshots, disabled-execution reads, idempotency, pagination, interruption and failure history were exercised. Native PostgreSQL/Redis coverage is a separate regular CI gate.
- **6 real browser/build checks passed**: static rendering, context disposal, private text/ARIA cleanup, actual opaque screenshot pixels and viewport dimensions, registered disclosure/overflow checks, invalid private regions and the built preflight's fail-closed root-service response.
- **31 development and 31 production-build Care/homepage journeys passed**. These exercised a test server, not the live deployment.
- Workspace typechecks, lint, API/web/worker builds and OpenAPI generation passed. `npm audit --audit-level=moderate` reported **0 vulnerabilities** in this local run.

Local browser fixtures used Playwright 1.62.1 with an explicitly selected Chromium 153.0.8010.0 test binary because the matching CDN download was unavailable in this execution environment. These fixed synthetic fixtures establish renderer behavior, not production sandbox readiness. Regular CI installs Playwright's matching Chromium and runs the same tests.

Validation caught and fixed a style-insertion wait with scripts disabled, obsolete expected tool counts, and CommonJS runtime dependencies incorrectly bundled into the built preflight. PostCSS/YAML and Playwright now remain external runtime packages. A clean local rebuild resolved an empty generated Next routes manifest before production UI verification; no generated manifest is committed.

The production launcher preflight correctly reports `BROWSER_SANDBOX_REQUIRED` under this root execution identity. A working non-root Linux Chromium sandbox in the real deployment is still required. The optional Debian browser image has not been built/deployed here. No live customer page, external model account, CMS/commerce account, production rollout or restore drill was used. These checks do not certify 100% security, live availability or completion of the wider roadmap.

The normal [PR checks](https://github.com/nithudev-com/zerochack/pull/1/checks) validate the published tree with PostgreSQL 16, Redis 7, pinned browser installation, unit/integration suites, API/web/worker builds, OpenAPI consistency, six browser/build checks, portal journeys, and both development and production Care/homepage journeys. No temporary workflow is required.
