# Local development

## Prerequisites

Node.js 22+, npm 10+, Docker Engine, and the Docker Compose plugin.

## Host applications with container dependencies

```bash
cp .env.example .env
npm install
docker compose -f infrastructure/docker/docker-compose.yml up -d postgres redis
npm run db:generate
npm run db:migrate
npm run dev
```

Stop dependencies with `docker compose -f infrastructure/docker/docker-compose.yml down`. Add `-v` only when you intentionally want to delete local database and Redis volumes.

## Full container environment

```bash
npm run docker:up
```

Compose starts PostgreSQL and Redis, applies migrations once, then starts API, worker, and web. The Compose credentials are local-only and must never be used in production.

Mailpit captures local verification and password-reset email at `http://localhost:8025`; it does not deliver mail externally.

Provision the first Owner through the non-public CLI after migrations:

```bash
OWNER_EMAIL=owner@example.com OWNER_PASSWORD='replace-strong-password' OWNER_NAME='Platform Owner' npm run owner:create -w @zerochack/api
```

The first Owner login enters MFA enrollment and returns recovery codes once after confirmation.

If conventional host ports are occupied, set `WEB_HOST_PORT`, `API_HOST_PORT`, `POSTGRES_HOST_PORT`, or `REDIS_HOST_PORT` before invoking Compose. Container-to-container ports do not change.

Environment parsing occurs when API and worker processes start. Copy `.env.test.example` to `.env.test` only for local test services; never commit populated environment files.

Generate an MFA encryption key with `openssl rand -base64 32`. Production startup rejects the documented development key, localhost application/SMTP endpoints, and the local sender address.
