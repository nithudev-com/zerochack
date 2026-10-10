# Verification profile evidence — 2026-10-01

This increment implements eleven bounded offline profiles (T35–T37, T39–T44, T46, T48), giving 67 bounded catalogue implementations/bindings. It does not make all proposed live connectors or deployment capabilities active. See [scope and setup](CARE-VERIFICATION.md).

Local evidence so far:

- 12 real synthetic profile tests passed, exercising all eleven profiles and representative failing inputs. Node subprocess tests, TypeScript emits/hashes, local HTTP applications, timing measurements, checksum mismatches, candidate restoration, mock payment behaviors and SQLite migration/backup restoration execute real code. These fixed trusted fixtures were run host-side on Node 24; arbitrary customer code was not run on the host.
- 203 existing/new unit tests passed.
- 15 new authentication/database integration tests passed using a disposable migration-backed PGlite database. These use an injected runner to test authorization, encrypted persistence, no-replay idempotency, stale/revoked/cancelled scope, baseline selection, history pagination and failed-result semantics. They do not verify the rootless container runtime.
- Lint, workspace typechecks (including the corrected API fixture types), API/web/worker builds and OpenAPI generation passed. The development browser suite passed 31 existing journeys plus the new verification journey on a focused rerun after correcting its staging fixture selection. All 32 production-build Care/homepage journeys passed. An initial browser build found a browser-safe import extension issue; it was fixed before the passing runs.
- Actual rootless deployment preflight is expected to block in this root workspace. No sandbox-disabling fallback was added.

The normal GitHub CI pipeline additionally validates real PostgreSQL/Redis, application builds, OpenAPI consistency and browser journeys. A separate Node 24 job builds the runner and a clearly marked synthetic-reference image, then reruns all profile tests in offline bounded Docker fixture containers. That verifies the worker image and fixtures; **Docker fixture success does not verify the production rootless Podman adapter or its deployment**. Exact CI status must be checked on the published commit.

The WordPress reference is synthetic in tests. No live CMS, official package download/authenticity review, real payment service, production database, customer deployment, full application restore drill or live security guarantee is claimed. Features default off and T42/T43 require an operator-reviewed reference in the pinned production image. Main is unchanged.

## Security dependency follow-up

[CI run 36863081923](https://github.com/nithudev-com/zerochack/actions/runs/36863081923) on `c5bc576` passed the new verification fixture job: **12/12 host fixture tests and 12/12 offline container fixture tests**, including runtime isolation assertions. Its separate application validation job stopped at the dependency audit with six affected dependency groups (one critical, four high, one moderate); later application checks did not run in that job. The audit gate was retained.

The dependency follow-up raises declared minimum versions and refreshes the lockfile:

| Dependency | Resolved patched version |
| --- | --- |
| Next.js | 16.3.8 |
| Fastify | 5.12.5 |
| Nodemailer | 10.0.13 |
| Undici | 7.30.0 |
| fast-uri | 3.1.8 / 4.2.1 on their existing major-version branches |
| brace-expansion | 1.1.21 / 5.0.12 on their existing major-version branches |

The subsequent local npm audit reported **0 vulnerabilities**. This is the package advisory feed's result at that time, not a security guarantee or container/OS audit. The Nodemailer major update requires Node 20+; this repository already requires Node 22+. Two real loopback SMTP compatibility tests verify synthetic delivery with the idempotency message ID and rejection handling; no external email is sent. Local lint, workspace typechecks and **205 unit tests** pass after the update. Final full CI status belongs to the new published commit and is recorded in PR #1.

Primary references: [Next.js advisory and patched version](https://github.com/advisories/GHSA-vcvr-r3jv-pc5j), [Nodemailer changelog](https://github.com/nodemailer/nodemailer/blob/master/CHANGELOG.md). The full list of affected dependencies was obtained from the actual CI/npm audit, not from a guessed technology inventory.
