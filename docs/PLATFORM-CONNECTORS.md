# Platform connections

Customer → Websites → open a website → Website options → Connectors.
The existing SSH workflow is unchanged. This release adds **four read-only API
authentication adapters**, not universal remote administration or 150 integrations.
No adapter is registered as an AI tool, scanner, repair executor or deployer.

## Supported operations

| Platform | Credential | Fixed GET operation |
| --- | --- | --- |
| WordPress (self-hosted REST API) | Dedicated user + Application Password | `wp-json/wp/v2/users/me?context=edit&_fields=id` |
| WooCommerce REST v3 | Consumer key + consumer secret; select Read permission | `wp-json/wc/v3/products?per_page=1&_fields=id` |
| Ghost Admin API, minimum v5 | Custom integration Admin API key | `ghost/api/admin/posts/?limit=1&fields=id` |
| Directus REST API | Restricted user's static token | `users/me?fields=id` |

Installation root must use HTTPS, port 443, the exact ownership-verified hostname,
and optional simple path segments for subdirectory installs. Query strings,
embedded credentials, fragments, encoded path segments and arbitrary endpoint
paths are not accepted. A different API/admin hostname must be added and verified
as a separate website. WordPress.com OAuth is not this WordPress adapter.

Official references reviewed during implementation:

- [WordPress Application Password authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/)
- [WooCommerce authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- [WooCommerce key permissions](https://woocommerce.com/document/woocommerce-rest-api/)
- [Ghost token authentication and API versioning](https://docs.ghost.org/admin-api/)
- [Directus users API](https://directus.com/docs/api/users)
- [Directus authentication](https://directus.com/docs/_partials/authentication)

Ghost integration keys can grant writes at the provider. CodeBandage performs GET
only; this does not remove the key's upstream privileges. Use dedicated revocable
credentials, never the hosting owner's password. Do not put credentials in chat.

## Meaning of connection state

1. Verify website ownership in Settings using the existing DNS/HTTP challenge.
2. Save an encrypted credential with explicit 30-day read-check authorization.
   `CONFIGURED` means stored, **not authenticated**.
3. Click Check connection. A request without credentials must receive 401/403,
   then the authenticated request must receive HTTP 200 with the expected JSON
   shape. Otherwise the check fails closed. Public content alone is not proof.
4. `AUTHENTICATED_READ` records only the fixed read operation at `lastCheckedAt`.
   It is not a persistent session or proof of editing/scanning/deployment access.
   Recheck after provider changes; a later failure changes state to needs attention.
5. Remove access clears ciphertext and prevents future checks. An already-sent
   read cannot be recalled. Revoke the key at the provider too. Old encrypted
   backups may retain previously stored credentials.

Redirecting endpoints, security challenges, HTML login pages, public endpoints
and unsupported provider versions fail rather than being marked connected.
Changing website URL invalidates checks; expired authorization requires saving
credentials again. No automatic periodic checks or paid operations are added.

## Security and persistence

- Tenant-scoped website authorization and `websites.read` / `websites.manage`.
- Private/no-store API responses; credential values never returned or logged.
- AES-GCM via existing `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`; encrypted envelope
  binds tenant, website, provider and endpoint. Credentials never enter AI/history.
- Fixed read-only endpoints, strict credential formats, normal CA/hostname TLS
  verification, public-only DNS resolution pinned into each socket, no redirects,
  no cookies, no credentials in query strings, no caller-supplied request headers.
- DNS bound 5 seconds; each request 10 seconds; body bound 64 KiB; up to two GETs
  per explicit check. Six mutation requests/minute per client IP, plus existing
  global limits. One database-leased check per saved connector; stale leases
  recover after 45 seconds. Version checks prevent stale replacement/revocation
  and in-flight checks from resurrecting removed credentials.
- One credential per provider per website (at most four). Additive table with
  composite tenant/website foreign key. No existing SSH/vault data is migrated.
- No Docker socket, SSH commands, arbitrary HTTP methods or execution runner.

## Research catalog versus executable adapters

The user supplied `CodeBandage_150_Platform_Connection_Methods.json` (research date
2026-10-09), SHA-256
`b61ee080692702de9e438e5abea37aea46905e002d090a299ea75e470a134b54`.
`apps/api/src/modules/connectors/research.json` is a field-preserving projection
of its title, date, scope and platform guidance. Its own scope says no connector
was tested. All 150 unique entries are searchable as reference; the remaining
146 are explicitly **guide only / not implemented** and cannot collect secrets.

OAuth platforms need a registered application, reviewed scopes, redirect URI,
secure token lifecycle and owner-authorized provider testing. Plan-specific or
manual-invitation platforms cannot be turned into a universal API connector.
An API key does not grant server/source access. SSH depends on hosting/account
permissions and is not offered by every hosted builder. More adapters require
individual implementation and testing; do not simply add them to the enum.

## Verification and release

- Unit tests cover the four request formats, Ghost signing, strict target scope,
  negative authentication, malformed responses and research integrity.
- HTTPS fixture tests perform actual local TLS sockets with a test-only resolver
  and generated CA: trusted TLS passes; wrong CA/hostname, redirects, oversized
  responses, HTML and invalid JSON fail. These are not live vendor tests.
- Disposable-PostgreSQL integration tests cover tenant boundaries, ownership,
  encrypted persistence, replacement conflicts, outcome persistence, expiry and
  concurrent check/revocation. Vendor requests are mocked there.
- Browser fixtures cover save/check/failure/removal, guide-only entries,
  ownership gating and accessibility at 320/390/1440 pixels; repeat against the
  production image. These are not real customer-account login tests.
- **No live vendor account has been tested by the implementation agent.** Enter
  scoped credentials in the protected connector form and explicitly run the
  check for each authorized platform. Do not claim all 150 platforms work.

Before production migration, create an encrypted authenticated database backup
and verify restoration to a separate disposable database. Apply
`20261009094000_platform_connectors` using the exact candidate tools image and
`prisma migrate deploy`. Retain the previous application image/configuration.
Application rollback to the preceding revision is compatible with this additive
table; do not drop the table or restore over new production writes.

Existing dependency/container release gates, restricted-preview access, Owner
MFA, off-server backup requirements and disabled Care capabilities are unchanged.
Recover the existing integration encryption key with the database; never
regenerate it to repair a startup error.
