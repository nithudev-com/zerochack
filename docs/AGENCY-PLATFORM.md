# Agency platform

## Authorization model

Agency access has two independent gates. The signed-in user must hold the relevant system RBAC permission in its agency tenant, and an `ACTIVE` `agency_client_relationships` row must grant the corresponding client capability. Client identifiers from headers or query parameters never expand the session tenant.

Grant capabilities are `CLIENT_READ`, `WEBSITES_READ`, `SECURITY_READ`, `TICKETS_READ`, `SUBSCRIPTIONS_READ`, `BILLING_READ`, `QUOTES_READ`, and `QUOTES_MANAGE`. Revocation clears all capabilities immediately. Missing, unrelated, revoked, or insufficient grants return a concealed 404.

Multiple websites remain owned by the client tenant. Agency endpoints query only the union of client tenant IDs authorized for the requested capability; ownership is never transferred to the agency.

## Commerce

Owners configure each agency's markup, maximum discount, revenue share, package-version entitlements, and client grant capabilities. Rates are stored as basis points and constrained to 0–10,000. No default commercial margin is embedded in application logic.

Agency quote totals are calculated server-side from the entitled immutable package version and the current agency policy. The resulting base price, markup, discount ceiling, revenue share, relationship, and package version are captured in quote provenance and `termsSnapshot`, so later policy changes do not rewrite history.

## Removal and revocation

Owners may revoke a relationship. Agencies may relinquish their own access. Both transitions are audited; they do not delete client data. Historical quotes remain attached to both the client and agency but cannot be mutated after access is revoked.

## Security tests

Integration coverage includes unrelated tenants, altered tenant headers/query parameters, missing quote capabilities, owner-route privilege escalation, multiple client websites, client removal, and immediate revocation.
