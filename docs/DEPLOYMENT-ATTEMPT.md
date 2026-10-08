# Deployment attempt — 2026-10-08

Status: **BLOCKED**. This is implementation and local candidate testing, not a
production-ready release. No production application deployment or public cutover
was performed. See `infrastructure/production/README.md` for operations.

## Environment and origin observations

Workstation: Kali, Node 22.22.2; isolated worktree based on
`24d7e5175cee15bed0db606faa84a90b84753291`. The original checkout's uncommitted
`apps/web/next-env.d.ts` was preserved. Only regenerable browser/build caches were
removed for disk headroom; user projects, databases, Docker images and volumes were
not pruned. Builds consumed part of the recovered space.

VPS read-only inspection: Ubuntu 24.04.5, Docker 29.8.2, Compose 5.6.0, Caddy active,
no application containers or Docker volumes. Server checkout was clean and detached
at the base commit above. SSH access still requires trusted console confirmation of
the observed host key and rotation of the previously exposed password. No server
secrets were generated, accounts changed, reboot performed, or configurations written.

2026-10-08 13:29 UTC: origin HTTPS validated; apex returned setup-only HTTP 503;
www redirected with HTTP 308 to apex preserving path/query. A records resolved to
164.68.114.89; no AAAA/CAA answers were returned during inspection. These observations
are not final Cloudflare verification. UFW allowed 22/80/443. Caddy's setup CSP
remains in place only for maintenance. No public application health or auth result.

## Executed tests

- Exact-lockfile `npm ci`: passed after network and disk-space retries.
- Lint, workspace typechecks, repository production build: passed.
- Unit tests: 210 passed. Initial sandbox SMTP socket failures were rerun outside
  the sandbox and passed; these were fixtures, not a real SMTP delivery.
- Disposable-database integration: 101 passed, 1 skipped after resolving test
  environment/disk failures. Additional Owner bootstrap integration: 1 passed.
- Generated OpenAPI consistency: passed. Verification fixtures: 12 passed.
- Care development browser suite: 36 passed initially; one desktop accessibility
  timeout. Targeted retry: both desktop accessibility tests passed.
- Care production-image browser suite: 36 passed initially; one test-mode cache
  assertion failed. With production test mode selected correctly, the remaining
  CSP/cache test passed. This suite uses fixtures, not real provider/chat traffic.
- Portal browser tests on isolated ports/database: 3 passed, 5 failed with login/
  navigation timeouts. Authentication release gate remains failed; do not infer
  success from cold-build timing explanations.
- API image started; dependency readiness reported database and Redis up.
  Migration image applied all 27 migrations to a disposable TLS database.
  Verified database/Redis TLS connections and rejection of wrong CA, hostname and
  password passed in the image fixture harness.
- Initial worker image crashed from bundled PostCSS dynamic require. Externalizing
  the relevant runtime packages fixed startup; corrected worker heartbeat passed.
- Built web image served sign-in, public brand assets and manifest successfully,
  with nonce CSP and private/no-store. No production Owner MFA, SMTP, Claude,
  authenticated SSE, restart recovery, load certification or restore drill passed.
- Full isolated execution/browser fixture coverage remains incomplete.

## Candidate image identities

These are workstation daemon-local image IDs built before final commits, not
revision-labelled release artifacts. Rebuild from the published clean commit,
re-test and audit exact resulting IDs before deployment. Nothing below is deployed.

| Image | SHA-256 ID |
| --- | --- |
| API tested | `35d60610c6a5b876a2bd7d2a1e6c0b12eb00ce50c87b45dae79ad9e6c5431bf3` |
| Worker corrected/tested | `73ad2e11d70409f40a94fbc901a79ecdd5ee0920e34aed75738c1195111a4494` |
| Web browser-tested | `7397f08b12279e81952d314b0a15d220bbea502baa1508b4de8fea965b6966ac` |
| Web later build; full suite not rerun | `08b620b587c41193a06c2153adc090adec534b8cd8e13593cd5e0510ab040e21` |
| Tools migration-tested | `936cf01c0c76f3182a4939032d0545e68a1f13ef1bcc4dc17615d51bfb086b7c` |

## Audit and remaining release gates

Compatible shell-quote/source-map-js/sharp updates reduced the full npm audit from
13 findings (2 critical, 9 high, 2 moderate) to 9 (0 critical, 7 high, 2 moderate).
Production-only npm audit returned zero findings. Remaining full-audit chains
include braces/Tailwind 3/glob/ESLint and selector parsing; no forced major migration
or security-gate suppression was applied. Full audit remains blocking.

Trivy 0.75.0, official release checksum verified, scanned the exact API image with
the current vulnerability database and returned failure. Findings include critical
perl-base entries with an indicated Debian update, zlib classification requiring
Debian applicability review, and high OS/npm-toolchain entries. Production npm
audit does not cover OS packages or npm bundled in the base image. Full applicability
review, compatible base/toolchain remediation and repeat image scans remain required.
Worker/web scans were also requested; consult retained scanner JSON rather than
assuming they passed. Database/Redis/tools scans remain required.

No production database exists or migrations/persistence have been verified there.
Backup encryption/HMAC, disposable restoration scripts and timer templates are
implemented but have not been executed on the VPS. Off-server destination/access,
upload/retention automation, Redis/key/artifact recovery and measured restore
evidence are still missing. Local disk snapshots alone are not disaster recovery.

SMTP provider/verified sender and approved mailbox are missing. Owner name/email,
secure password entry and MFA enrollment are pending. Claude tenant gateway
credential/model/pricing/entitlements and a bounded authorized real request are
pending. All Care capability flags remain disabled; isolated customer execution
infrastructure is not supplied by this VPS configuration.

The requested newer blue/navy logo source is not available in this workspace;
that refresh remains pending independently of deployment. Existing CodeBandage
artwork is retained. Cloudflare Full (strict), proxy/cache settings and final
HTTPS/auth/SSE validation are not performed or claimed.

Before release: resolve audit and portal failures, rebuild revision-labelled
artifacts, retain complete evidence, confirm trusted SSH access, securely configure
SMTP/Owner, review migration/rollback compatibility, complete restore/off-server
recovery, then pass the private deployment and public cutover gates. No main-branch
merge, force push, volume pruning or live database reset is authorized by this work.
