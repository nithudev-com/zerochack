# Deployment foundation

No production environment is provisioned in Phase 0. A future deployment must provide managed PostgreSQL and Redis, secret management, TLS termination, image signing/scanning, backups, network policies, workload identity, and independently scalable web, API, and worker workloads. Do not deploy the development Compose file to production.
