# VPS acceptance record — 2026-10-09 UTC

Status before cutover: restricted preview candidate; public release BLOCKED.
Work executed on vmi3643652. No reboot, destructive database reset, volume pruning,
root-login disablement or Cloudflare modification was performed.

## Executed evidence
- Production PostgreSQL and Redis use private networks, authentication and private-CA TLS.
- Existing database was empty before all 27 reviewed migrations were applied.
- Owner info@nithudev.com (nithudev) provisioned with the existing bootstrap tool.
  Production Owner MFA enrollment remains a user action.
- Hostinger SMTP port 465 certificate verification and authentication succeeded.
  No real test message was sent; recipient approval/delivery evidence remain pending.
- Encrypted authenticated database backup created on VPS and restored into a separate
  disposable database; 27 migrations verified. Full artifact/key recovery and off-server
  disaster recovery remain incomplete.
- Actual initial production images built; API readiness, worker heartbeat, web HTTP
  and TLS client checks passed against disposable infrastructure.
- Debian 13 API candidate: positive Prisma/Redis TLS plus wrong CA, hostname and password
  rejection checks passed. Preliminary Trivy scan: 0 critical, 43 high OS findings,
  0 Node package findings. These are not a public release pass or final-image scan.
- Full npm audit previously reported 7 high and 2 moderate findings (development chains);
  production-only npm audit reported none. Unresolved findings remain release blockers.
- VPS portal browser suite: 7 passed, 1 failed. Owner MFA/control-center fixture and
  mobile flow passed after correcting missing Owner backup-page packaging.
  Customer desktop Access navigation still returned 404; targeted retry also failed.
  Increasing wait time did not fix that issue. Do not report this suite as passing.
- Modified portal test files passed ESLint. Full latest-candidate suite remains incomplete.
- Earlier local unit/integration/Care tests are historical evidence, not a substitute
  for testing these exact final images on the VPS.

## Packaging and preview changes
- Digest-pinned Node 22 Debian 13 runtime, npm removed from application runtime only.
- Backup-page source explicitly included without including backup archives or secrets.
- Fixture database guard rejects non-test databases; root fixture containers use UID 1000.
- Preview requires committed source, matching immutable image revision labels and an
  authenticated SSH peer IP. It keeps everyone else in maintenance and does not mark
  public release gates passed. Caddy preserves API prefix and frontend nonce CSP.
- Runtime evidence after cutover is recorded outside Git under protected state; exact
  image IDs are recorded in the per-commit release manifest.

## Still required for unrestricted production
Investigate/fix remaining browser failure and release-blocking dependency/container
findings; rerun complete exact-candidate checks, production auth/MFA/email and SSE,
bounded representative load and restart recovery. Approve/test off-server backups and
full artifact/encryption-key recovery. Claude credentials/provider budgets and individual
Care capability authorization/runtime tests are absent: keep every Care capability off.
Isolated customer-code execution is not available. No paid model call was made.
Newest blue/navy artwork was not supplied; logo refresh remains pending separately.
Keep DNS-only for IP-restricted preview; do not enable Cloudflare proxying yet.
Rotate previously chat-exposed SSH/mail/Owner credentials through trusted interfaces;
never commit replacements or reset existing data-encryption keys.
