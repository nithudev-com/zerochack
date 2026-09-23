# Threat model

## Scope and assets

Protected assets include account credentials, MFA material, session tokens, tenant security evidence, temporary remediation access, backup ciphertext, AI/provider credentials, payment state, affiliate balances, reports, and audit records.

```mermaid
flowchart LR
    subgraph client ["Untrusted Clients"]
        user["Browser User"]
        attacker["Internet Attacker"]
    end
    subgraph gateway ["Trust Boundary"]
        ingress["TLS Ingress"]
    end
    subgraph service ["Trusted Services"]
        api["Authenticated API"]
        worker["Isolated Worker"]
    end
    subgraph datastore ["Protected State"]
        postgres["PostgreSQL"]
        redis["Redis"]
        storage["Encrypted Object Storage"]
    end
    subgraph external ["Third Parties"]
        providers["Email AI Payment Providers"]
    end
    subgraph async ["Job Boundary"]
        queue["BullMQ"]
    end

    user -->|"HTTPS"| ingress
    attacker -->|"Hostile input"| ingress
    ingress -->|"Validated requests"| api
    api -->|"Scoped queries"| postgres
    worker -->|"Scoped job state"| postgres
    api -->|"Limits and streams"| redis
    worker -->|"Encrypted objects"| storage
    api -.->|"Authorized jobs"| queue
    queue -.->|"Bound jobs"| worker
    api -.->|"API: Provider calls"| providers
```

## Principal threats and controls

| Threat | Primary controls | Residual risk |
|---|---|---|
| Credential theft | Argon2id, HttpOnly Secure SameSite cookies, hashed opaque tokens, Owner TOTP | Endpoint compromise and phishing require operational detection |
| Horizontal access | Session-derived tenant ID, tenant predicates, composite foreign keys, negative integration tests | No PostgreSQL RLS defense in depth |
| Privilege escalation | Server-side permissions, role verification, Owner MFA step-up | RBAC changes require migration review |
| SSRF | Protocol/port allowlist, public-address checks, DNS pinning, per-redirect revalidation, hostname binding | Production egress policy must also be deployed |
| XSS and CSRF | React escaping, CSP, strict cookies, Origin and Fetch Metadata checks | CSP permits inline styles for framework compatibility |
| Queue forgery/replay | Resource bindings reloaded from PostgreSQL, deterministic IDs, state claims | Redis requires TLS, authentication, and network isolation |
| AI leakage/injection | Backend-only credentials, tenant-scoped context, redaction, untrusted-context instructions, quotas | Model behavior is probabilistic; minimize sensitive context |
| Payment forgery | Exact raw-body verification, freshness window, event idempotency and collision checks | Real provider adapter and reconciliation are deployment dependencies |
| Backup disclosure | AES-256-GCM before storage, tenant-bound AAD, integrity verification | No runtime backup source/provider is installed |
| Remediation abuse | Bound authorization, verified backup, scoped temporary token, approved playbooks, expiration and revocation | Real connector/playbook execution is not installed |
| Audit tampering | No mutation API, restricted Owner reads, secret redaction | Database append-only role and immutable external export are not implemented |

## Assumptions

TLS terminates at a trusted proxy; PostgreSQL and Redis are private; production secrets come from a secret manager; workers run with controlled outbound egress; provider webhooks arrive without browser cookies. Deployment review must verify each assumption.
