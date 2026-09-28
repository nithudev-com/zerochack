# Explicit-consent Care observations: T20, T23 and T24

## What is implemented

Three previously unavailable contracts now have narrowly scoped API, persistence and UI implementations. The registry is **52 implemented/bound, 15 unavailable** out of 67; this is not a product-completion percentage. No autonomous tool loop, exploit tests, credential guessing, general shell, customer builds or production repair capability is added.

T20 matches exact selected npm/Packagist package coordinates against `https://api.osv.dev/v1/querybatch`. T23 performs one unauthenticated HEAD at the root of the already-verified production website. T24 performs one certificate-validated TLS handshake for that registered HTTPS host. They use dedicated, explicit customer consent; source-review agents cannot select these network tools.

## Setup and rollout

Apply `20260928000000_care_observations` with the new flags disabled. Preserve the existing database and encryption keys. The additive migration introduces a scoped observation table, idempotency and single-active-observation constraints; it deletes no history.

- `CARE_ENABLED=true` enables the parent Care surface.
- `CARE_OBSERVATIONS_ENABLED=true` enables registered-website observations.
- `CARE_ADVISORIES_ENABLED=true` additionally requires `CARE_REVIEW_ENABLED=true` and enables exact-package disclosure to OSV.
- `CARE_ARTIFACT_KEY` must be a persistent distinct production key whenever either feature is enabled.

Both new flags default to false. The new adapters use built-in Node HTTP/TLS/fetch and existing scanner policy; no dependency installation or model entitlement is implied. Coordinate with the deployment's egress policy. Do not enable a broad internet proxy to make the tools work.

## Customer workflow

Open a website job and expand **Authorized website observations & advisory matching**. For HTTP/TLS, review the displayed exact target and authorize one observation. For T20, select up to 50 exact package versions and explicitly approve disclosure of those coordinates. Nothing is selected by default. Private package names can identify a project; customers should not select them without accepting that disclosure.

Changes to the selected tool, source version, package selection, environment, target or availability invalidate the UI consent. The server independently checks the current scope. Normal source-review approval alone does not authorize sharing a dependency list with OSV.

The result view and history show real persisted records. Reloading, reconnecting or retrying a request key cannot trigger the same external call again. Older records are paginated and encrypted result artifacts remain under existing history/tenant quotas.

## Endpoints

All paths have the `/v1` prefix and inherit authenticated Care/CSRF-origin controls.

| Endpoint | Behavior |
| --- | --- |
| GET /jobs/:id/observation-options?before=UUID | Current safe scope, exact dependency inventory, flags and scoped history. Requires websites.manage and ai.use. |
| POST /jobs/:id/observations | Strict T20/T23/T24 input, explicit consent and a UUID requestKey. Requires websites.manage and ai.use. |
| GET /jobs/:id/observations/:runId | Authorized retained result/error state; chat.read and same tenant/site/job. |

T20 input also contains exact `revisionId`, `sourceDigest`, selected `{ecosystem,name,version}` coordinates and `consentToSharePackageVersions:true`. Every coordinate must occur in the currently approved source snapshot. T23/T24 instead require `confirmTarget` matching the registered root and `authorizeReadOnlyObservation:true`. Submitted hosts, ports, request headers, commands and alternate destinations are rejected.

A dedicated table records actor, input digest, target/source binding, tool, idempotency key, expiry, state and encrypted artifact reference. States are RUNNING, COMPLETED, FAILED and INTERRUPTED. Authorization and result events are audited without source, response bodies, private header values or secrets. The server rechecks session, membership, role, website, source approval and target binding after the external operation before persisting successful evidence. Revocation cannot undo data already transmitted; it blocks publication of a successful authorized result.

## Boundaries and limits

**Website observations.** Production jobs only, pre-existing VERIFIED website binding, standard ports 80/443, no query strings, root path only, no redirects, no credential/cookie forwarding and no response body reads. Public DNS validation rejects unsafe/mixed responses; the selected address is pinned for the connection. TLS validates the original hostname rather than the literal pinned address. A ten-second deadline includes DNS waiting. HTTP response headers are capped; returned observations are allowlisted booleans rather than raw header values. Header presence does not establish security; TLS reports one negotiated connection, not all supported protocols, certificate revocation or application safety.

**Advisories.** Exact versions from package.json, npm lockfile v1/v2/v3, npm shrinkwrap and composer.lock. Ranges, links, unsupported versions and malformed records remain explicitly unverified/skipped. The inventory never installs packages or treats declarations as deployed facts. OSV receives only selected name/version/ecosystem coordinates, never source, website URLs, credentials, resolved tarball URLs or repository URLs. One batch, no automatic retries, no redirects, ten-second timeout, bounded streamed response and validated output. Returned IDs and modification dates are normalized. Pagination/caps are reported INCOMPLETE instead of clean. This is advisory matching, not proof of exploitability or absence of vulnerabilities.

**Execution.** One active observation per website, thirty new observations/site/hour, endpoint request rate limits, bounded request/output sizes. Same-key retries return the saved operation; different input/actor/target with the same key is rejected. A crashed operation is displayed as INTERRUPTED after its deadline and never replayed. A new request may close the stale record before admission. Late results cannot overwrite a replaced, expired, cancelled or scope-changed run. Existing artifact quotas can block saving a result, which must remain a visible failure rather than a fabricated success.

## Tests and verification

Unit tests cover exact inventory extraction, unsupported versions, fixed provider input, malformed/oversized/paginated provider data, no raw header disclosure, pinned addresses, unsafe DNS and original-hostname TLS checks. Integration tests use real application authentication/database state and fixture external transports, including consent, idempotency, cross-tenant denial, cancellation, revocation, encrypted results and environment filtering. Browser tests verify disclosure selection, disabled-until-approved actions, target-drift invalidation and reload without replay.

Local lint and 93 selected tests passed before the full CI handoff. Full database/build/browser evidence belongs to the final GitHub Actions validation run, not this statement. No live OSV call, customer host, production credential or restore drill was used in these tests. Live connectivity and deployment policy still need environment-specific evaluation.

## Remaining wider work

T25–T28 browser services; T35–T37 customer test/build workers; T39–T40 API/performance fixtures; T41–T44 CMS/commerce integrations; T46 migration compatibility; T48 provider fixtures remain unavailable. General multi-file repair, richer external knowledge, token streaming, production key rotation and independent live recovery validation are not completed by this increment. The original 100-item ledger is not relabelled complete.

## Primary protocol references

- OSV batch request/response: https://google.github.io/osv.dev/post-v1-querybatch/
- Node TLS certificate and hostname validation: https://nodejs.org/api/tls.html
