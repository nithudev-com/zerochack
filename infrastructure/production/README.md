# CodeBandage single-VPS operations

This path is separate from development Compose. It targets the verified Ubuntu
VPS `vmi3643652` and `https://codebandage.com`, with host Caddy and one origin.
Configuration is not proof of a successful deployment. Retain actual command
results and review the release gates for the exact commit and image IDs.

## Access and first provisioning

Verify the SSH host fingerprint through the provider console. Rotate the exposed
root password there. Keep the existing recovery connection. A deployment account
with Docker access is root-equivalent; do not call it unprivileged. Test its key
login in a separate session before approving any root/password-login transition.
No reboot, SSH transition, Docker reinstall, or Caddy installation is performed by
these scripts. Run `bash scripts/deploy/preflight.sh` on the VPS and inspect results.

Inspect `/opt/codebandage/source` before moving its detached checkout. Preserve
local edits. Fetch upstream, review changes, and check out the exact tested commit,
never a floating branch tip. On an existing installation back up data and review
all migrations before running deploy. Never reset databases or prune volumes.

After trusted access is established, run `python3 scripts/deploy/init-state.py` on
the VPS. It refuses workstation use, existing-data/new-key combinations, or partial
state. It creates independent keys once in `/opt/codebandage/state` (700), protected
env files (600), a private CA, and hostname-bound service certificates. Failed
provisioning leaves its exact staging directory for secure recovery. Do not rerun
by deleting state. Recover existing encryption keys when ciphertext exists.

Run `python3 scripts/deploy/configure-smtp.py` interactively on the VPS. Obtain
provider host/port, verified sender, username and credential from the selected
provider. The password prompt does not echo. SMTP is mandatory; no dummy email
provider or production validation bypass is provided. SPF/DKIM records must come
from that provider; preserve existing mail records. Validate one delivery only to
the Owner-approved test mailbox before recording the SMTP gate as passed.

Protected env files are not a managed vault. Root and Docker administrators can
read them; env values also exist in container metadata. Never print expanded
Compose config or container environments. Never archive state in Git/build contexts,
CI artifacts or support logs. Restrict access and use encrypted off-server recovery.
Web receives public URL variables only, not database or application secrets.

## Build, test and release

On a clean committed candidate run `bash scripts/deploy/build.sh /protected/release.env`.
This builds API, worker, web and tools images using a digest-pinned Node base and
records daemon-local immutable IDs. Transfer exact image archives or publish/load
exact registry digests; local IDs do not automatically exist on another daemon.
Keep prior images and manifests. Record dependency audits and image scanner results
including database/Redis images. High/critical findings remain release blockers
until compatibility/applicability is reviewed; do not weaken CI's audit gate.

Run repository lint, typechecks, unit, integration, browser, fixture tests and builds.
Use isolated databases whose names contain `test`; never production. Run OpenAPI
generation and review consistency. Test the actual images with production-shaped
TLS and HTTPS configuration, CA/hostname/password negative tests, worker heartbeat,
queue recovery, authentication/roles/MFA, private cache/CSP, assets, mobile/desktop,
SSE/cancellation and bounded representative load. Health probes alone cannot prove
these. No 100-user or provider capability certification is implied.

Copy `release-gates.example.json` outside Git and fill it from retained evidence.
Every `passed` field is a reviewer assertion requiring actual results, not a bypass.
`check-release.py` binds those assertions to the candidate and tested image IDs.
Run `bash scripts/deploy/deploy.sh /protected/release.env /protected/gates.json`.
The controlled tools image applies `prisma migrate deploy`; API/worker/web start
privately. Caddy stays in maintenance until cutover gates are reviewed.

Bootstrap Owner through the tools image's `node apps/api/dist/scripts/create-owner.js`,
with protected `OWNER_EMAIL`, `OWNER_NAME`, `OWNER_PASSWORD`, `OWNER_TENANT_NAME`
environment supplied via a Compose override using `env_file: {path: ..., format: raw}`.
Never put credentials in command arguments/history. The Owner script preserves an
existing Owner and rejects email addresses belonging to non-Owner accounts; it never
resets credentials or MFA. Enroll Owner MFA via the application
before privileged use; do not bypass customer email verification.
The interactive wrapper `python3 scripts/deploy/bootstrap-owner.py /protected/release.env`
uses a non-echoing prompt and removes only its own ephemeral credential file on exit.

After Owner/MFA, authenticated smoke, SSE, off-server recovery and rollback reviews
pass, run `bash scripts/deploy/cutover.sh /protected/release.env /protected/gates.json`.
It validates Caddy, preserves the old file, reloads safely and runs HTTPS smoke.
It does not overwrite Caddy certificate storage. The sample preserves `/v1`, removes
spoofable client-IP headers, trusts only one proxy hop in Fastify, and preserves
Next's nonce CSP and API headers. No public docs, database, Redis, metrics or debug
port is published. Caddy's admin listener must remain loopback.

## TLS, capabilities and recovery

PostgreSQL denies plaintext network sessions and uses SCRAM. Prisma 6.12 clients
use `sslmode=require&sslaccept=strict&sslcert=/run/trust/ca.crt`; do not infer verification
from URI text: run negative tests against the actual engine. PostgreSQL backup
clients use `verify-full`. Redis disables its plaintext port, uses password auth,
TLS and AOF with `noeviction`. Node clients trust the private CA via
`NODE_EXTRA_CA_CERTS`. Server-only certificates are mounted only into their service;
clients receive CA public material only. Never disable certificate verification.

Service certificates last one year. Alert at least 30 days before expiry using
`openssl x509 -checkend 2592000`; renew with the existing CA and identical DNS SANs,
validate chains/hostnames, then restart one service at a time and recheck clients.
Preserve CA and all existing application encryption keys in encrypted recovery.
Re-encryption/key rotation of existing Care data is not implemented.

All Care flags default off: base, review, repair, observations, advisories, browser,
verification, release. Anthropic requires the existing Owner tenant gateway's
provider adapter, credential, model, price and entitlement configuration, not just
an env API key. Record one bounded approved real request before activation. Do not
run customer code on this host or give workers the Docker socket. Isolated execution
infrastructure remains a separate prerequisite for browser/verification capabilities.

Run `python3 scripts/deploy/backup.py /protected/release.env` for an encrypted
PostgreSQL snapshot over verified TLS, with separate HMAC authentication. Install
the supplied systemd unit/timer only after a successful backup and restore drill,
setting `/opt/codebandage/releases/current.env` to the deployed manifest.
Run `python3 scripts/deploy/restore-check.py /protected/release.env /exact/backup.dump.enc codebandage_restore_test_UNIQUE`
(lowercase unique suffix) to verify HMAC and restore into a newly created disposable
database; it refuses any existing database. Retain it for application/keys testing.
No live database is overwritten. These scripts do not back up Redis AOF, server
configuration, or keys; include these in the separately reviewed full recovery plan.
Queue recovery needs application-level review to avoid replaying external work.

Retention target: 7 daily, 4 weekly and 3 monthly validated snapshots off-server.
Until approved off-server storage and upload/retention automation exist, retain
local snapshots, monitor disk use and remove nothing automatically. Same-disk
backup is not disaster recovery. RPO/RTO remain unmeasured until a full drill.
Self-managed PostgreSQL/Redis on one VPS do not provide managed-service HA.

Rollback requires reviewing forward-compatible migrations and disabling/draining
new worker work. Use the previous immutable application IDs and retained config,
verify private readiness, then route traffic. Never automatically downgrade schema
or restore live data after new writes. Care vault references require compatible
binaries. Keep maintenance if compatibility or recovery is uncertain.

## Cloudflare

After origin HTTPS works, choose Full (strict), proxy apex/www, bypass cache for the
whole host initially and keep Rocket Loader off. Review static-only caching later.
No separate API DNS record is needed. Preserve ACME renewal and SSH recovery.
This Caddy file uses connection peer IP; behind Cloudflare it reports the edge IP.
Before enabling proxying, review and configure Cloudflare's current trusted proxy
ranges and authenticated client-IP boundary, then re-test spoofing, cookies and SSE.
Do not blindly trust incoming CF-Connecting-IP or X-Forwarded-For. Cloudflare changes
are not performed or claimed by repository scripts.

## Restricted acceptance preview

When public launch gates are incomplete, the explicitly requested restricted
preview can be used for Owner acceptance and MFA enrollment. After reviewing
migrations, SMTP authentication, image readiness and the actual findings, run
`python3 scripts/deploy/preview.py /protected/release.env YOUR_CURRENT_PUBLIC_IP`
over the authenticated VPS SSH connection. The script verifies a clean committed
revision and matching immutable image labels. The IP must exactly match that
connection's public peer; broad networks and caller-supplied forwarded headers
cannot grant access. Only that peer and loopback receive the application.
Everyone else receives maintenance HTTP 503. Domain www redirects preserve the URI.

### Moving from preview to public access

The message `CodeBandage is in a restricted preview. Public registration is not open yet.`
is the deliberate Caddy access gate, not a missing DNS record. A valid certificate
and healthy private containers do not open that gate. Inspect the current Caddyfile
and the exact release evidence over authenticated SSH. If the Owner's IP changed,
refresh the restricted preview with `preview.py`; that is not public publication.

For public publication, satisfy every field in `release-gates.example.json` and run
`cutover.sh` against the exact deployed candidate and immutable image manifest.
Do not edit out the peer restriction manually, mark missing tests passed, or remove
the dependency/container/off-server-backup gates. The backup gate requires a tested
copy outside this VPS, including an approved plan to recover existing encryption
keys and artifacts; a local database snapshot alone is not sufficient.

The CSS toolchain pins `postcss-selector-parser` 7.1.6 for the fix documented in
[GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf).
`npm run test:build-toolchain` checks nested selectors, Tailwind 3 utilities and the
actual portal stylesheet. The unused `eslint-config-next` dependency was removed;
the existing ESLint configuration and CI lint/audit checks are unchanged.
Tailwind 3 still pulls in `braces` 3.0.3, for which
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
lists no patched release. The full dependency audit therefore remains a release
blocker. Do not treat a clean runtime-only audit as a clean build/tools audit or
blindly run `npm audit fix --force`; a Tailwind major migration needs separate
visual, browser, accessibility and production-image verification.

This is **RESTRICTED PREVIEW**, not a passed public release. Keep DNS-only mode:
enabling Cloudflare proxying changes the connection peer and blocks preview access.
If the Owner's IP changes, reconnect and rerun with the new verified peer. The
script does not reset keys, run migrations, reset Owner credentials or mark audit
gates as passed. It preserves the existing Caddyfile, validates the replacement,
and restores the prior file if reload or local HTTPS readiness fails. Do not use
preview to accept customer traffic or customer code. Keep Care capabilities off
until their individual authorization/provider/runtime tests pass.

The production runtime now uses the digest-pinned official Node 22 Debian 13
image, and excludes npm/npx from API/worker/web runtimes. Build and migration tools
retain their package manager. Scan each exact image: removing unused tooling
does not resolve all OS or development-dependency findings.
