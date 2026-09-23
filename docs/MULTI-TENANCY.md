# Multi-tenancy

Tenant context comes exclusively from the hashed server-side session cookie. Authentication verifies the user, session expiry/revocation, account state, active membership, tenant, roles, and permissions before attaching context to a request.

Tenant-owned resource queries include both resource ID and `request.tenantId`. Unknown and cross-tenant identifiers return 404. Agency access uses an explicit active agency-client relationship and a per-capability grant. Specialists operate through assigned tickets and scoped remediation sessions; they do not receive blanket access to customer tenant APIs.

Chat streaming uses tenant-and-website event keys and verifies the website before opening a stream. Active streams re-check session, account, and membership state every ten seconds and close after revocation. API responses are not shared-cacheable.

The adversarial integration suite uses similarly named tenants and attempts path-ID, query, header, report, scan, ticket, AI, backup, notification, and streaming access. PostgreSQL row-level security is not enabled, so application predicate review and restricted database credentials remain mandatory.
