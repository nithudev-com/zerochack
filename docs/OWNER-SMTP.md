# Owner SMTP settings

Open **Owner → SMTP Settings** (`/owner/smtp-settings`). The same link is available from Email Automation. A current Owner session, `integrations.manage`, and MFA verified within 15 minutes are required for every read, update, verification, and test request.

The existing protected server SMTP configuration remains active until an Owner saves an override. Enter the SMTP hostname, port 465 (implicit TLS) or 587 (required STARTTLS), username, password, sender address and display name. Hostinger uses `smtp.hostinger.com:465`. Incoming IMAP/POP and client-autodiscovery DNS records are not used by the application.

**Verify and save SMTP** validates the TLS certificate/hostname and authenticates before replacing the active settings. A failed check leaves the previous settings intact. A blank password preserves the saved password only when the host and username are unchanged. Changing either requires a new password. Passwords are write-only: they are never returned to the browser or written to audit metadata. Stale forms and concurrent changes are rejected; reload before trying again.

SMTP connection verification does not establish sender authorization or inbox delivery. Use **Send test email to me** only after confirming the checkbox. It sends one fixed message to the authenticated Owner's verified mailbox, never an arbitrary recipient. The endpoint is limited to three test requests per hour per client IP in production. No message is sent merely by loading or saving the settings. Check the inbox and spam folder yourself. Configure SPF/DKIM/DMARC using the chosen provider's actual instructions; this feature does not modify DNS.

## Scope and safety

API account verification/reset/invitation emails and background notification emails read the same active settings on each new attempt. No container restart is required. An already-started send may finish on its previous settings. Existing email templates, notification preferences, automation policy, normal customer verification and Agency/Affiliate approval rules remain unchanged. Owner System Health now verifies actual SMTP TLS/authentication instead of reporting an open TCP port as healthy.

Owner-supplied settings permit only public hostnames, ports 465/587, and authenticated encrypted connections. Each send resolves and checks DNS, pins the selected public IP, and checks TLS against the original hostname. There is no certificate-validation bypass, insecure SMTP option, arbitrary test-message editor, or public settings endpoint. Provider errors are sanitized before application/worker logging.

## Storage and recovery

The override is a singleton `system_settings` row keyed `email.smtp.primary`, encrypted as one payload using the existing `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`. Generic settings endpoints do not return that row; ordinary settings writes cannot edit it. No schema migration or production data reset is needed. Updates and explicit test sends create audit records without credentials.

Database backups contain the encrypted override. Securely retain the matching integration encryption key outside the database and arrange off-server recovery; a same-disk backup is not disaster recovery. Never regenerate the key to repair an SMTP error. Corrupt/unreadable saved settings fail closed rather than silently using stale server credentials. Keep the protected server SMTP env file as an operator recovery source, not as a second dashboard-controlled configuration. Once an override is active, editing only that env file will not change outgoing application mail.

Rolling back to a release predating this feature uses server env SMTP again. Before such a rollback, confirm those credentials still work; no automatic database downgrade or deletion is performed. Saved settings remain encrypted for a later compatible release.

Transport behavior follows the [Nodemailer SMTP documentation](https://nodemailer.com/smtp): `verify()` checks connection/TLS/authentication, not actual delivery. Automated tests use synthetic SMTP providers and isolated test databases; they must not send verification/reset email or mutate settings in production.
