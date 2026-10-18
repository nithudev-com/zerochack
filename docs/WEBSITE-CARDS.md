# Customer website cards

The websites list shows the website name, URL, recorded connection evidence, Open workspace and a green Tools button. The former security/monitoring/backup/scan/finding rows are hidden on this list only; existing data and other workspace pages remain unchanged.

Connection colors are red for no confirmed connection, green for checked SSH, and yellow for checked website-bound platform API read access. These are last-check results, not live sessions. Website ownership verification alone, saved credentials, failed checks, expired/revoked authorization and project-only authentication do not qualify. If both qualify, SSH takes precedence. Unknown/missing metadata is gray rather than a false status claim.

The tenant-scoped websites API projects only summary kind, provider names and last-check time. It does not return credential records, usernames, vault IDs, secrets or ciphertext, and listing websites never initiates a connection check.

Tools opens an accessible modal with SEO, Security, Automation, Marketing and Chat Agent. Every selection shows Under construction. It creates no jobs, sends no AI/vendor request and grants no execution permission. Existing Open workspace service selection is unchanged. These placeholders are separate from the existing gated security workspace.

Tests: connection-summary unit tests; auth integration test against a disposable database; websites browser fixtures at 320/390/1440px with keyboard/focus, WCAG checks, status evidence, and no-write assertions. Browser fixtures do not prove a real customer's SSH/platform credentials work.
