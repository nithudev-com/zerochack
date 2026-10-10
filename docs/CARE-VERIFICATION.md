# Retained offline verification: T35–T48

The eleven previously unimplemented contracts now have executable **bounded v2 profiles** under `offline-verification-v1`. The registry has 67 implemented/bound contracts. This means implementation coverage, **not 67 active production services or complete support for every technology**. All 24 source-review roles keep their existing mode. No autonomous shell, exploitation or model-controlled tool loop was added.

The supported CMS connector is a **WordPress saved-file connector**, not a live authenticated CMS connector. Commerce and integration checks use a **registered local payment mock**, not real Stripe/WooCommerce accounts. T43 prepares a **partial core-file candidate**; it does not install a WordPress update or establish complete application compatibility. These narrower scopes are visible in the catalogue, customer controls and each retained result. The original proposed contracts remain in `proposedPurpose`.

## Customer workflow

1. Create a staging source review or text workspace and save your sanitized UTF-8 files. Existing intake limits apply: 30 files / 200 KB. Include the profile files below. Never include credentials or real customer data.
2. Open **Isolated verification tools · 11 profiles**. Choose the profile and current saved version. For T40, choose a different saved source artifact from the same job as the baseline.
3. Read the scope and approve this exact selection with synthetic data only. A changed source, profile, baseline, policy or runtime image requires new consent. There is no AI token charge for these deterministic checks.
4. Review **Result**, individual checks and limitations. A run marked `COMPLETED` means evidence was stored; its actual outcome may be `FAILED`, `OBSERVED`, `PREPARED` or `PASSED`.
5. Return to the same job after closing the browser. History and downloadable reports remain available, including when new execution is disabled or the workspace is closed. T43 reports include candidate files and references to the retained original source. Nothing is installed automatically.

## Profiles and exact input contracts

| Tool | Files / behavior | Remaining limits |
| --- | --- | --- |
| T35 | `test/unit.test.mjs`, relative source imports and Node's built-in `node:test`; at least one named test; fixed 10-second test timeout | No npm install, external packages, customer shell command or coverage certification. Empty/skipped suites fail. Test-process counts are not independent security evidence. |
| T36 | `test/integration.test.mjs`; built-in Node modules, disposable SQLite and container loopback services | No PostgreSQL/MySQL/Redis/external-service compatibility claim. |
| T37 | Supplied `.ts` files outside `test/`; strict ES2022, Bundler module resolution, declarations, standard libraries; pinned TypeScript 5.9.3 | Ignores customer scripts and tsconfig. Records deterministic emitted-file hashes; does not publish a package/build. |
| T39 | `app/server.mjs` and `care/api.json`; exact status and JSON comparisons | Only fixed loopback origin, GET/POST, 10 cases, 32 KB response, 1 second/request, no redirects. |
| T40 | Current and baseline `app/server.mjs` plus identical `care/performance.json` | 1–3 GET paths; 3 warmups + 20 single-concurrency samples each; mean/p95 and relative changes. Host noise/order remain; no statistical pass gate or production load test. |
| T41 | `wp-includes/version.php`, `wp-content/plugins/<slug>/<main>.php`, `wp-content/themes/<slug>/style.css` | Reads bounded declaration headers without PHP execution. Completeness, activation and deployed versions are unknown. |
| T42 | Supplied WordPress core-file subset, including version declaration, matching the operator-reviewed reference in the image | No user-supplied trust root. Missing reference/version/path blocks. Hash comparison covers normalized UTF-8 selected files, not the whole CMS or malware absence. |
| T43 | Core-file subset + `care/wordpress.json`; exact target version, declared PHP version, subset approval | Prepares a retained candidate and tests exact snapshot-file restoration. Does not execute PHP, upgrade a DB, install the CMS, or verify live recovery. |
| T44 | `app/server.mjs`, registered `/checkout` endpoint and local mock payment contract below | Fixed synthetic success, duplicate/idempotency and decline. No real provider, order, payment, receipt or outgoing message. |
| T46 | `database/setup.sql`, `database/seed.sql`, `database/migrate.sql`, `care/database.json` | Real disposable SQLite; explicit before/after row assertions; backup byte/row restoration even after failed migration. Other SQL dialects and live backups unverified. |
| T48 | `app/server.mjs`, registered `/integration/balance` endpoint and local balance mock | Tests throttle retry and malformed-response handling against the documented mock only. |

`app/server.mjs` must listen on `process.env.HOST` / `process.env.PORT`. The harness sets loopback ports 18765 (app) and 18766 (payment mock), and supplies `PAYMENTS_URL`. It does not supply any application/service credentials. The server gets a minimal environment. Only fixed synthetic fixture code is included in `infrastructure/verification/fixtures/server.mjs`; adapt your own application adapter to this documented contract.

`care/api.json` is an array of 1–10 cases, for example:

```json
[{"path":"/health","method":"GET","status":200,"json":{"ok":true}}]
```

POST cases may include `body`. Paths contain only `/`, letters, digits, `_` and `-`; external URLs, queries and redirects are rejected. Expected JSON equality is structural, including array order. Raw response bodies/logs are not persisted.

`care/performance.json` contains, for example, `["/health"]`. Both versions must declare the exact same profile. Each version is started separately and measured sequentially in the same bounded experiment. The recorded selection includes both artifact IDs, source hashes and immutable image identity.

`care/wordpress.json` has exactly three fields:

```json
{"targetVersion":"6.1.0","phpVersion":"8.3","approveCoreSubset":true}
```

These are **illustrative version strings, not upgrade recommendations**. Choose a currently reviewed target reference and the correct declared PHP version. The target must be newer than the supplied version. Non-core source paths, missing reference files, unsupported versions and insufficient declared PHP fail. The remaining PHP/CMS/database compatibility checks are explicitly unverified.

`care/database.json` has `before` and `after` lists (1–10 each). Every assertion is `{ "query": "SELECT ...", "rows": [...] }`; rows are synthetic, ordered, explicit, at most 20 expected rows. Example:

```json
{"before":[{"query":"SELECT id FROM items ORDER BY id","rows":[{"id":1}]}],"after":[{"query":"SELECT id, count FROM items ORDER BY id","rows":[{"id":1,"count":0}]}]}
```

The SQL executes only inside the disposable container, with extension loading disabled. No database URLs are accepted. Restore verifies the original SQLite file bytes and before assertions; it is not a reversible-migration claim.

### Registered mock payment contract

T44 posts `/checkout` with `cart: [{sku: "fixture-item", quantity: 2, unitAmount: 600}]`, `paymentToken: "fixture_ok"`, `idempotencyKey: "fixture-success"`. The app calls mock `POST /v1/payment_intents` with JSON `{amount: 1200, currency: "usd", payment_method: "fixture_ok"}` and the `idempotency-key` header. The mock returns a synthetic succeeded intent with `livemode: false`. App success is HTTP 200 and `{status: "paid", total: 1200, orderId: <string>}`. Repeating checkout must return the identical order and cause only one mock charge. A second key `fixture-decline` with token/method `fixture_declined` produces mock HTTP 402; the app must return 402 and `{status: "declined"}`. No contact details are used.

T48 calls app `GET /integration/balance`. The fixed mock `GET /v1/balance` first returns HTTP 429 / `retry-after: 0`, then `{object:"balance",livemode:false,available:[{amount:1200,currency:"usd"}]}`. The app must return 200 and exactly `{amount:1200,currency:"usd",testMode:true}`. The next call gets deliberately malformed provider JSON; the app must return 502 and exactly `{error:"provider_invalid"}`. This small mock is **Stripe-shaped, not Stripe certification or a full API emulator**.

## Operator setup and activation

Apply migration `20261001000000_care_verification` with new execution disabled; preserve the existing database, backups and encryption keys. Deploy compatible API/web code. New variables:

```dotenv
CARE_VERIFICATION_ENABLED=false
# Set only after building and reviewing the image in the service user's local store:
# CARE_VERIFICATION_IMAGE=sha256:<64 lowercase hex characters>
```

Activation requires Care + source reviews, a stable distinct production artifact encryption key, an installed reviewed immutable runner image, and **non-root Linux with local rootless Podman, seccomp and cgroup v2 CPU/memory/pids delegation**. `/usr/bin/podman` is the fixed binary. No Docker socket, remote engine, host bind mounts, arbitrary executable path or user command is accepted. Prefer a dedicated service host/account; containers still share the host kernel, so this is not a claim of perfect isolation.

Build `infrastructure/verification/Dockerfile`, review its base/dependencies, import it into that service user's rootless Podman store and pin the resulting `sha256:` image ID. The base tag is resolved at build time; runtime execution never pulls a tag/image. TypeScript is fixed at 5.9.3; Node's exact version is recorded in each result. A new image requires new consent. Review/rebuild the base for security updates before deployment.

The API checks rootless mode, seccomp, delegated controllers and exact local image identity. Execution uses no network, no proxy forwarding, read-only root, non-root container UID, no capabilities/new privileges, bounded tmpfs, 256 MB memory, 1 CPU, 64 processes, bounded output, an outer deadline and a Podman 50-second timeout. The trusted worker has its own 45-second deadline. Cleanup is attempted in `finally`; the container timeout also applies if the API process disappears. There is one execution per API process and one active run per website, with a 30/hour website quota. Budget host capacity and replica count before enabling.

Run `npm run care:verification-preflight` as the actual service user, or the built `apps/api/dist/scripts/care-verification-preflight.js`. It uses the production adapter and a fixed synthetic unit test without a database. Root or missing isolation fails closed. Validate every required profile and resource/network behavior on the deployment; a green fixture alone does not certify the whole hosting environment. The API defaults the capability off.

### WordPress reference provisioning

T42/T43 deliberately fail until a reviewed reference is installed in the image. Do not substitute customer files, arbitrary URLs or fixture manifests.

`infrastructure/verification/prepare-wordpress-reference.py` downloads an exact official WordPress HTTPS archive, permits redirects only to official WordPress HTTPS hosts, requires an independently reviewed expected SHA-256, bounds archive sizes, parses UTF-8 core files without extracting/executing them, normalizes line endings and derives core/PHP minimum versions. Supply `--version`, `--sha256` and `--output` after operator review. The importer was syntax-checked here; **no live official package download or authenticity review was performed in this increment**.

Build a derived production image that adds that reviewed JSON at `/opt/runner/trusted-wordpress.json`; repin the complete resulting image. The comparator checks reference file hashes/version/provenance; its trust ultimately depends on that operator review and immutable image. The shipped `Dockerfile.fixture` and its reference are explicitly synthetic test data. The production adapter rejects images with `ZEROCHACK_TEST_IMAGE` set. Never deploy a fixture image or relabel fixture data as authentic.

## API, persistence and limits

- `GET /jobs/:id/verification-options`: supported source, baseline choices, runtime image and 20-row cursor history. `enabled` indicates configuration/source eligibility; it does not bypass the runtime preflight.
- `POST /jobs/:id/verification-runs`: `requestKey`, tool ID, current `revisionId`, `artifactId`, `sourceDigest`, exact `imageDigest`, `authorizeVerification: true`, `syntheticDataOnly: true`; T40 additionally requires a distinct same-job `baselineArtifactId` and `baselineDigest`. No URL/command/account fields are accepted.
- `GET /jobs/:id/verification-runs/:runId`: saved status and decrypted authorized evidence. History remains readable when new execution is disabled.

Tenant/site/job scope and current session/membership/management permission are checked before and after execution. Source revision, image, job cancellation and execution expiry are rechecked before saving results. Consent is saved before executing. Request keys cannot be reused for another selection or actor. An interrupted run is retained and never silently replayed. Database foreign keys bind scope, a partial unique index prevents simultaneous site runs, and reports are encrypted with integrity hashes and existing artifact quotas. Quotas reject new writes instead of deleting old history.

Validation is recorded in [CARE-VERIFICATION-VALIDATION.md](CARE-VERIFICATION-VALIDATION.md). Deployment activation, live CMS/provider integration and full production readiness remain separate, unverified work.

Primary implementation references: [Podman run](https://docs.podman.io/en/latest/markdown/podman-run.1.html), [Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html), [WordPress plugin headers](https://developer.wordpress.org/plugins/plugin-basics/header-requirements/).
