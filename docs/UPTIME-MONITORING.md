# Customer uptime controls

In Customer → Overview, select a website, then use **Pause monitoring** next to
its uptime status. **Resume monitoring** restarts that website's checks using
the saved frequency and email preference. No SSH connection is required.

Pause is website-specific. It does not change another website's monitoring or
the account-wide monitoring-email preference. Check history, incident evidence
and email-delivery history are retained; past percentages are not a live status.
Manual **Check now** is unavailable while paused.

The database policy is authoritative: disabling is committed even if Redis is
unavailable and its repeating schedule cannot be removed. Queued checks refuse
to probe a disabled policy. An in-progress HTTP request can finish, but its
result cannot create alerts or overwrite the paused status. Policy changes and
probe-result commits use the same short website-row lock; network operations
are outside database transactions.

The email worker rechecks the current tenant-scoped website policy before
claiming a monitoring delivery and immediately before calling SMTP. Paused,
archived, missing or changed policies suppress queued/retrying monitoring mail
with `MONITORING_PAUSED_OR_CHANGED`. Outbox policy versions prevent old alerts
from being replayed after resume. Legacy records use their creation time as the
fence. Suppressed records are retained, not reset or resent. Other email types
(including password resets) are unaffected. Recipient authorization and email
preferences are still independently checked.

Pause cannot recall email already handed to SMTP or cancel a network operation
already in flight. SMTP acceptance is not proof of inbox delivery. Checks and
alert delivery also depend on the CodeBandage control-plane host being available;
this is sampled HTTP availability, not independent server-health monitoring.

For verification, use disposable databases and a capturing SMTP fixture, never
pause a customer's live monitor solely to run a test. Relevant regression suites:
`apps/api/src/auth.integration.test.ts` and
`apps/web/care-e2e/uptime.spec.ts` (development and built production web).
