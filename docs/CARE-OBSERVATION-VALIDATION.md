# Care observation increment — validation record

## Implemented scope

This increment adds dedicated, manually consented T20 advisory matching, T23 registered-website HTTP observations and T24 registered-host TLS observations. It also corrects dependency inventory, filters Care credential/request metadata by the selected environment, adds encrypted observation history and idempotent request handling, and introduces explicit customer controls and tests.

The registry now accounts for **52 bounded implementations/workflow bindings and 15 unavailable contracts out of 67**. This is not a product-completion percentage. The broader 100-item plan and general autonomous application repair are not complete.

## Verified application revision

- Validated integration commit: `b1bb1cdfe8596232e0112e7e40d76cf2be02e0d8`.
- Validation workflow: [run 36375229227](https://github.com/nithudev-com/zerochack/actions/runs/36375229227).
- The workflow applied hash-verified integration changes, ran the checks below, and committed the tested source only after those checks passed.
- The subsequent cleanup removes temporary development workflows and adds this record; it does not modify the tested application source.

## Actual results from the completed run

| Check | Result |
| --- | --- |
| Dependency audit | 0 reported vulnerabilities in that audit |
| Database migrations | 24 applied successfully to disposable PostgreSQL |
| Lint | Passed |
| TypeScript | Passed across all workspaces |
| Unit tests | 195 passed in 27 files |
| Integration tests | 75 passed; 1 opt-in live scan skipped |
| API, web and worker builds | Passed |
| OpenAPI generation | Passed; generated specification committed |
| Portal browser journeys | 8 passed |
| Care/homepage development-build browser journeys | 29 passed |
| Care/homepage production-build browser journeys | 29 passed |

The first browser validation found an observation-selector label problem. It was fixed with an explicit label/control association; the test was retained and passed in both final browser suites. Application CI remains responsible for checking the final published branch and OpenAPI consistency.

The external HTTP/TLS/OSV adapters were tested using controlled fixtures and mocked transports. The integration suite used real application authentication and disposable PostgreSQL/Redis services. Browser suites are controlled application tests, not observations of customer websites. Production-build browser tests are not a production deployment. No live provider account, customer server, real advisory-service response, production secret or publish/restore drill was used in these tests.

## Security and data-handling coverage

Tests exercise exact approved dependency selection, explicit package disclosure consent, fixed provider destinations, malformed/oversized/paginated responses, public-address pinning, original-hostname certificate checks, absence of raw header/cookie disclosure, cross-tenant rejection, encrypted result storage, session revocation, cancelled jobs, target changes, interrupted requests and retries without repeated external effects.

Neither the presence of an HTTP header nor a successful TLS handshake proves application security. Advisory matches concern declared versions in the approved snapshot, not confirmed runtime exploitability. A finite passing test suite does not certify universal security.

## Deployment requirements

Apply `20260928000000_care_observations` with the new features disabled. Preserve existing database history and persistent encryption keys; deploy matching API/web/worker versions. Both `CARE_OBSERVATIONS_ENABLED` and `CARE_ADVISORIES_ENABLED` default to false. Advisory matching also requires source reviews to be enabled. A distinct persistent artifact key and the existing Care authorization controls remain mandatory for production use.

See [Care observations](CARE-OBSERVATIONS.md) for endpoint contracts, customer consent, quotas, scope binding, failure states and rollout procedures. See [tool contracts](CARE-TOOL-CONTRACTS.md) for the complete implementation matrix.

## Still unavailable

T25–T28 browser services; T35–T37 customer-project test/build workers; T39–T40 API/performance fixtures; T41–T44 CMS/commerce connectors; T46 database migration compatibility; T48 provider-specific integration fixtures remain unavailable. They require actual implementation and evaluation, not simply an enable flag.

General multi-file repairs, broader external knowledge, browser token streaming, production key rotation and live recovery/provider evaluation remain unfinished. Main is not merged or deployed by this increment, and no production-readiness claim is made.
