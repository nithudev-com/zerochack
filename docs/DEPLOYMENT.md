# Deployment

This repository does not provision or claim a production deployment. The multi-stage, non-root Dockerfiles and capability-restricted, loopback-bound Compose topology are for repeatable development and image validation.

A production pipeline should build immutable multi-stage images, generate an SBOM, scan dependencies and containers, sign artifacts, run migrations as a controlled one-off job, deploy with readiness checks and rollback support, and verify smoke tests. Runtime workloads should be non-root, read-only where practical, resource-limited, and independently scalable.

Required external services are managed PostgreSQL, managed Redis compatible with BullMQ semantics, a secret manager, TLS/DNS/load balancing, container registry, centralized logs, metrics/tracing/alerts, backup storage, and an incident notification system. Email, object storage, payments, dependency/CVE data, and malware analysis providers are deliberately unselected. AI supports an authorized adapter but no provider account, credential, model, price, or tenant policy is preconfigured.

Production must inject independent `SESSION_SECRET`, `MFA_ENCRYPTION_KEY`, `AI_CREDENTIAL_ENCRYPTION_KEY`, `PAYMENT_CREDENTIAL_ENCRYPTION_KEY`, `INTEGRATION_CREDENTIAL_ENCRYPTION_KEY`, `REPORT_SIGNING_KEY`, and `METRICS_TOKEN` values from a secret manager. Before enabling AI, complete provider legal/security review, set current cost metadata and limits, and validate data residency and retention requirements.

Rollback uses the last signed application images while preserving forward-compatible database changes. Stop new worker consumers first, drain or quarantine unsafe jobs, route traffic to the previous web/API images, and verify health and authorization smoke tests. Never reverse a destructive migration without a reviewed recovery plan; prefer a forward repair or the tested managed-database point-in-time recovery process.

Before release, document RTO/RPO, data residency, retention/deletion, subprocessors, key rotation, restore results, on-call ownership, and rollback procedures.

Phase 12 built the four Dockerfiles and started the API, web, and worker images individually. Full Compose orchestration must still be run in an environment with the Docker Compose v2 plugin; the review host returned `docker: unknown command: docker compose`.
