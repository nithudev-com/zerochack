# Platform connections

Customer → Websites → open a website → Connections (in the task panel).
Both `/access` and `/connectors` show SSH and fourteen searchable API methods;
selecting a method starts no network check. SSH save now checks the connection
only, without automatically starting a security assessment or leaving the form.
The existing stored SSH credentials are unchanged. There are **fourteen read-only API
authentication adapters**, not universal remote administration or 150 integrations.
No adapter is registered as an AI tool, scanner, repair executor or deployer.

## Development, redesign and fix requests

Chat starts in normal message mode. Apparent credentials still trigger explicit
secure-capture consent and never become a normal message through that UI path.
The task panel builds a scoped development/redesign/fix brief with acceptance
checks. Its explicit save creates a real support conversation, not an AI job,
paid model call, remote edit or release. Support retains the saved request;
unsent drafts are cleared on environment changes and are not persisted locally.
Do not include secrets or private customer data in briefs. Pattern checks are
not a substitute for reviewing the content before sending it to support.

Tools & availability reports Care's API state and source-review/repair/release
flags. A disabled or failed capability is not marked ready. Enabled flags still
need provider/model/budget, source consent, job preflight and exact approval.
Snapshot lint/type tools and saved text versions remain in approved source
workspaces; browser/runtime execution and production release are not unlocked
by adding a connector. The existing evidence-chat backend remains scoped to
website/security evidence; this UI does not turn it into a general remote coder.

## Supported operations

| Platform | Credential | Fixed operation |
| --- | --- | --- |
| WordPress (self-hosted REST API) | Dedicated user + Application Password | `wp-json/wp/v2/users/me?context=edit&_fields=id` |
| WooCommerce REST v3 | Consumer key + consumer secret; select Read permission | `wp-json/wc/v3/products?per_page=1&_fields=id` |
| Ghost Admin API, minimum v5 | Custom integration Admin API key | `ghost/api/admin/posts/?limit=1&fields=id` |
| Directus REST API | Restricted user's static token | `users/me?fields=id` |
| Shopify GraphQL Admin 2026-10 | Installed same-organization app client ID/secret | Token exchange, then POST a fixed read query for shop ID and domains |
| Joomla web services (Joomla 5/6) | Dedicated user's Joomla API token | GET `api/index.php/v1/content/articles?page[limit]=1` |
| Payload default REST API | API-key enabled auth collection slug + dedicated user API key | GET `api/{collection}/me`; returned user/token discarded |
| Strapi 5 default REST API | Protected collection plural API ID + read-only API token | GET `api/{collection}?pagination[page]=1&pagination[pageSize]=1`; content discarded |
| PrestaShop legacy Webservice | 32-character key with GET shops permission only | GET `api/shops/?display=[id]&limit=0,1`, Output-Format JSON |
| CS-Cart API 1.0 | Restricted API-enabled administrator email + API key | GET `api/products/?items_per_page=1`; product metadata discarded |
| Medusa v2 Admin API | Dedicated Secret API key (not publishable key) | GET `admin/products?limit=1&fields=id` |
| Contentful CMA v1 | Space ID + restricted CMA token | GET `spaces/{spaceId}`; space ID must match; **project access only** |
| DatoCMS CMA v3 | Custom read-only role token | GET `site?fields[site]=name`; **project access only** |
| Webflow Data API v2 | Site ID + site token with sites:read | GET `v2/sites/{siteId}`; ID and custom/canonical website domain must match |

Installation root must use HTTPS, port 443, the exact ownership-verified hostname,
and optional simple path segments for subdirectory installs. Query strings,
embedded credentials, fragments, encoded path segments and arbitrary endpoint
paths are not accepted. A different API/admin hostname must be added and verified
as a separate website. WordPress.com OAuth is not this WordPress adapter.

Hosted API exceptions use fixed vendor roots: Contentful allows only
`https://api.contentful.com/` or `https://api.eu.contentful.com/`, DatoCMS only
`https://site-api.datocms.com/`, and Webflow only `https://api.webflow.com/`.
No arbitrary CMS/admin host exception is accepted. Contentful and DatoCMS do
not expose a trustworthy frontend binding in these selected operations:
`AUTHENTICATED_ACCOUNT` means project access checked, **website binding pending**.
Never use this state as a website, source or edit permission. Webflow requires
the exact verified hostname in customDomains or shortName.webflow.io; no suffix
matching or wildcard domains. Account IDs/collection slugs never become
arbitrary URL paths, HTTP methods or headers.

Shopify is another hostname exception: use `https://store.myshopify.com/`, with
no path, even for a verified custom storefront. The app and store **must belong
to the same Shopify organization** and the app must already be installed. This
is not a CodeBandage public app or third-party merchant OAuth installation flow.
Each explicit check exchanges the encrypted client credentials at the fixed
Shopify OAuth endpoint using form encoding. The temporary token stays in memory;
it is never returned, stored or logged. A later check obtains a new token. The
fixed GraphQL query is `shop { id myshopifyDomain primaryDomain { host } }`, with
no mutation or customer/order fields. Both the canonical hostname and the
verified website's binding to the returned primary/canonical domain must match.
GraphQL errors, missing fields and an actual API-version header other than
`2026-10` fail closed. Re-review Shopify's supported version before October 2027.
Select only necessary app permissions; do not add write permissions for this check.

Joomla needs the API Authentication – Web Services Joomla Token, User – Joomla
API Token, and Web Services – Content plugins. Use a dedicated user with API login
(`core.login.api`) and article-read access, **not Super User**. Joomla may require
an administrator to allow that user's restricted group to generate API tokens.
The token goes in `X-Joomla-Token`, never in the URL. Joomla's list response may
include one article's content: it is discarded, not persisted, logged or sent
to AI. The bounded 64 KiB response limit can reject a large article. Do not
broaden permissions or disable TLS/ownership checks to make a check succeed.

Official references reviewed during implementation:

- [WordPress Application Password authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/)
- [WooCommerce authentication](https://developer.woocommerce.com/docs/apis/rest-api/authentication)
- [WooCommerce key permissions](https://woocommerce.com/document/woocommerce-rest-api/)
- [Ghost token authentication and API versioning](https://docs.ghost.org/admin-api/)
- [Directus users API](https://directus.com/docs/api/users)
- [Directus authentication](https://directus.com/docs/_partials/authentication)
- [Shopify own-organization client credentials grant](https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant)
- [Shopify shop query](https://shopify.dev/docs/api/admin-graphql/2026-10/queries/shop)
- [Shopify API versioning](https://shopify.dev/docs/api/usage/versioning)
- [Joomla web services](https://manual.joomla.org/docs/general-concepts/webservices/)
- [Payload API keys](https://payloadcms.com/docs/authentication/api-keys) and [Me operation](https://payloadcms.com/docs/authentication/operations)
- [Strapi REST responses](https://docs.strapi.io/cms/api/rest) and [API tokens](https://docs.strapi.io/cms/features/api-tokens)
- [PrestaShop authentication/JSON](https://devdocs.prestashop-project.org/9/webservice/getting-started/) and [bounded list parameters](https://devdocs.prestashop-project.org/9/webservice/tutorials/advanced-use/additional-list-parameters/)
- [CS-Cart authentication](https://docs.cs-cart.com/latest/developer_guide/api/index.html) and [products](https://docs.cs-cart.com/latest/developer_guide/api/entities/products.html)
- [Medusa Admin authentication](https://docs.medusajs.com/api/admin/authentication) and [Admin operations](https://docs.medusajs.com/api/admin)
- [Contentful space](https://www.contentful.com/developers/docs/references/content-management-api/spaces/get-a-space/) and [version/EU root](https://www.contentful.com/developers/docs/references/content-management-api/overview/)
- [DatoCMS site and sparse fields](https://www.datocms.com/docs/content-management-api/resources/site/self?language=http)
- [Webflow site](https://developers.webflow.com/data/reference/sites/get)

Ghost integration keys can grant writes at the provider. CodeBandage performs GET
only for Ghost; this does not remove the key's upstream privileges. Use dedicated revocable
credentials, never the hosting owner's password. Do not put credentials in chat.

## Meaning of connection state

1. Verify website ownership in Settings using the existing DNS/HTTP challenge.
2. Save an encrypted credential with explicit 30-day read-check authorization.
   `CONFIGURED` means stored, **not authenticated**.
3. Click Check connection. A request without credentials must receive 401/403,
   (or Payload `/me` must return HTTP 200 with exactly null user),
   then the authenticated request must receive HTTP 200 with the expected JSON
   shape. Otherwise the check fails closed. Public content alone is not proof.
4. `AUTHENTICATED_READ` records only the fixed read operation at `lastCheckedAt`.
   It is not a persistent session or proof of editing/scanning/deployment access.
   Recheck after provider changes; a later failure changes state to needs attention.
5. `AUTHENTICATED_ACCOUNT` proves only the Contentful space or DatoCMS project
   read operation. It does not establish a website binding or unlock an AI tool.
6. Remove access clears ciphertext and prevents future checks. An already-sent
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
  per explicit check, or three fixed POSTs for Shopify (anonymous GraphQL, token
  exchange, authenticated GraphQL). Six mutation requests/minute per client IP, plus existing
  global limits. One database-leased check per saved connector; stale leases
  recover after 60 seconds. Version checks prevent stale replacement/revocation
  and in-flight checks from resurrecting removed credentials.
- One credential per provider per website (at most fourteen). Additive table with
  composite tenant/website foreign key. No existing SSH/vault data is migrated.
- No Docker socket, SSH commands, arbitrary HTTP methods or execution runner.

## Research catalog versus executable adapters

The user supplied `CodeBandage_150_Platform_Connection_Methods.json` (research date
2026-10-09), SHA-256
`b61ee080692702de9e438e5abea37aea46905e002d090a299ea75e470a134b54`.
`apps/api/src/modules/connectors/research.json` is a field-preserving projection
of its title, date, scope and platform guidance. Its own scope says no connector
was tested. All 150 unique entries are searchable as reference; the remaining
136 are explicitly **guide only / not implemented** and cannot collect secrets.
Use Show more platforms to browse all 150 without entering a search term.
Implemented guide entries open the matching setup form. Other entries link to
the existing real support-conversation flow, not a pretend connected state.

OAuth platforms need a registered application, reviewed scopes, redirect URI,
secure token lifecycle and owner-authorized provider testing. Plan-specific or
manual-invitation platforms cannot be turned into a universal API connector.
An API key does not grant server/source access. SSH depends on hosting/account
permissions and is not offered by every hosted builder. More adapters require
individual implementation and testing; do not simply add them to the enum.

## Verification and release

- Unit tests cover the fourteen request formats, Ghost signing, strict target scope,
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
`20261009094000_platform_connectors` and the additive provider-allowlist expansion
`20261009120000_shopify_joomla_connectors` and
`20261009140000_reviewed_rest_connectors` using the exact candidate tools image and
`prisma migrate deploy`. Retain the previous application image/configuration.
Application rollback to the preceding revision is compatible with this additive
table; do not drop the table or restore over new production writes.

Existing dependency/container release gates, restricted-preview access, Owner
MFA, off-server backup requirements and disabled Care capabilities are unchanged.
Recover the existing integration encryption key with the database; never
regenerate it to repair a startup error.
