# Central AI Gateway

## Request path

All model traffic follows `web -> /v1 API -> @zerochack/ai-gateway -> registered provider adapter -> provider`. Browser code sends only the prompt, references, and an idempotency UUID. It never receives a provider credential. The implemented adapter uses a server-side Responses endpoint with provider-side response storage disabled.

Provider, credential, model, tenant policy, and usage records are database-backed. Provider credentials are encrypted with AES-256-GCM using `AI_CREDENTIAL_ENCRYPTION_KEY`; list and mutation responses never return ciphertext or plaintext. A production secret manager must inject a unique key. Rotation increments the credential key version, but migrating ciphertext between master keys requires a controlled external procedure.

AI is deny-by-default. An Owner with recent MFA and `ai.providers.manage` must create a provider, encrypted credential, model, and enabled tenant policy. Management endpoints are under `/v1/owner/ai`. Only adapter keys compiled into the backend are accepted; arbitrary provider URLs are not.

The Owner AI Gateway screen has four separate setup steps. A saved key is not activation: enable its provider, add a provider-compatible model with current nonzero USD prices per million tokens, and explicitly save the intended customer's tenant policy. Step 4 searches organization names and shows enabled/disabled state; it never enables every customer or the Owner's organization implicitly. Enabling a tenant requires a positive estimated daily spending threshold. The listing and policy mutation require recent Owner MFA and are private/no-store.

The UTC-day spending threshold is an estimate based on completed successful usage, not an atomic reservation or a hard billing cap. In-flight requests and failed tool turns can cost money beyond that estimate. Use conservative concurrency/output limits and provider-side spending controls; do not represent a $1 threshold as a guaranteed $1 invoice cap. Chat activation does not enable assessment, repair, browser execution or production release.

## Authorization and isolation

The API derives tenant and roles from the authenticated session. Website, finding, evidence, and ticket queries combine IDs with that tenant and website. Client tenant headers and query values are ignored. Customer, Agency, Specialist, and Owner policies may use security context when RBAC also allows it. Affiliate may use only general AI and cannot reach website security endpoints or receive security context.

Security context is minimized, secret-redacted, serialized as data, and enclosed in `<untrusted_security_context>`. Trusted instructions say website content, scanner output, evidence, and uploads are untrusted and must never be followed as instructions. This reduces prompt-injection risk; it is not a mathematical guarantee. Finding explanations are validated for the five required sections and remain ordinary AI chat messages. Severity, evidence, and status remain authoritative database fields.

## Agent tools

Security chat may receive a small, request-scoped set of server-side function tools. The Responses adapter executes at most four model turns, disables parallel tool calls, validates tool names against the application registry, returns sanitized failures, and sends tool outputs back to the model for a final user-facing answer.

The initial tools are `check_ssh_access`, `run_read_only_security_assessment`, and `request_live_access_specialist`. They operate only on the authenticated tenant and website already bound to the API route. A successful SSH check is followed by the read-only assessment in the same agent turn. Missing or failed access stops assessment and produces corrective guidance; a customer who does not know the access details can explicitly request immediate live-specialist handoff. SSH secrets stay encrypted at rest, are decrypted only inside the server-side SSH operation, and are never included in model input or tool output. The assessment can record verified findings but cannot change server files. Remediation remains unavailable to AI and requires the existing payment, specialist, authorization, backup, and time-limited-session controls.

## Limits, retries, and accounting

Redis enforces tenant, user, provider, and model request limits plus tenant, provider, and model concurrency semaphores. A daily tenant cost ceiling uses persisted successful usage. Estimated cost comes from Owner-configured per-million-token prices; it is an estimate, not billing truth. Usage captures tenant, user, provider, credential reference, model, tokens, latency, status, request ID, errors, and estimated cost without plaintext credentials.

Idempotency is unique per tenant, user, and UUID. Completed requests return the existing result. Retryable network or provider 5xx failures receive one retry with the same credential. HTTP 429 is not retried and never causes credential switching.

## Operations

- Configure current model prices and limits; no pricing is seeded.
- Review `/v1/owner/ai/usage` and provider health state.
- Successful calls mark the selected provider and credential healthy; provider failures mark them degraded.
- Keep provider processing, retention, regional, and incident-response terms under review.
- No provider is preconfigured, and default tests make no live provider call.

### Approved single-tenant server setup

`apps/api/src/scripts/configure-tenant-ai.ts` is a one-off maintenance CLI for an explicitly approved server administrator, not a replacement login, customer endpoint, or a fabricated Owner session. Normal dashboard changes still require recent Owner MFA. Run it in the tools image with production configuration, the existing trust mounts, and a mode-600 JSON approval file mounted outside `/workspace`. Set `AI_SETUP_APPROVAL` to the approval reference in that file. The CLI loads production validation, uses the existing encrypted credential, verifies the exact model via Anthropic's Models API (no paid generation), and appends an `ai.tenant_setup_applied` audit event with source `approved-server-maintenance` and no impersonated user.

Required JSON fields: `approvalReference`, `tenantId`, `providerId`, `credentialId`, `name`, `providerModel`, `maxOutputTokens`, `requestsPerMinute`, `requestsPerUserMinute`, `maxConcurrent`, `dailyCostLimitMicros`, `inputCostMicrosPerM`, `outputCostMicrosPerM`. UUIDs and prices are non-secret configuration; never put a provider API key in this file. Obtain model IDs from the actual key's Models API and review current official standard prices. The script activates only the named tenant and provider/model, refuses conflicting existing settings, preserves credential ciphertext/key version, and is a no-op on an identical rerun. It does not change Care flags, create users/sessions, or claim a successful chat generation from a model-discovery check.

To disable a tenant later, use Step 4 in the Owner portal; do not erase its policy, usage or encrypted key to resolve a provider error. A revoked key, missing credits, unsupported model or provider failure must be repaired at its actual boundary.
