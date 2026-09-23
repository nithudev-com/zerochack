-- AlterTable
ALTER TABLE "website_access_credentials" ADD COLUMN     "vault_credential_id" UUID;

-- CreateTable
CREATE TABLE "care_credentials" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "environment" VARCHAR(16) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "host" VARCHAR(253) NOT NULL,
    "port" INTEGER NOT NULL DEFAULT 22,
    "username" VARCHAR(120) NOT NULL,
    "auth_method" VARCHAR(20) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "encrypted_envelope" TEXT NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'STORED',
    "authorized_by" UUID NOT NULL,
    "authorization_expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "care_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_access_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "credential_version" INTEGER NOT NULL,
    "specialist_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,
    "reason" VARCHAR(1000) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "decided_by" UUID,
    "decided_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "care_access_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_jobs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "request_key" UUID NOT NULL,
    "environment" VARCHAR(16) NOT NULL DEFAULT 'STAGING',
    "kind" VARCHAR(16) NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    "summary" VARCHAR(1000) NOT NULL,
    "expected_behavior" VARCHAR(4000),
    "plan_version" INTEGER NOT NULL DEFAULT 1,
    "approved_version" INTEGER,
    "approved_by" UUID,
    "approval_expires_at" TIMESTAMPTZ(6),
    "source_revision" VARCHAR(64),
    "candidate_digest" CHAR(64),
    "preview_url" VARCHAR(2048),
    "error_code" VARCHAR(100),
    "result_message_id" UUID,
    "lease_version" INTEGER NOT NULL DEFAULT 0,
    "heartbeat_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "care_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_agent_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "role_id" VARCHAR(8) NOT NULL,
    "role_version" INTEGER NOT NULL DEFAULT 1,
    "task" VARCHAR(1000) NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'QUEUED',
    "result_message_id" UUID,
    "heartbeat_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "care_agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_events" (
    "sequence" SERIAL NOT NULL,
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "environment" VARCHAR(16) NOT NULL,
    "job_id" UUID,
    "agent_run_id" UUID,
    "event_type" VARCHAR(64) NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "summary" VARCHAR(1000) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "care_events_pkey" PRIMARY KEY ("sequence")
);

-- CreateIndex
CREATE INDEX "care_credentials_tenant_id_website_id_environment_status_idx" ON "care_credentials"("tenant_id", "website_id", "environment", "status");

-- CreateIndex
CREATE UNIQUE INDEX "care_credentials_tenant_id_website_id_id_key" ON "care_credentials"("tenant_id", "website_id", "id");

-- CreateIndex
CREATE INDEX "care_access_requests_tenant_id_website_id_status_idx" ON "care_access_requests"("tenant_id", "website_id", "status");

-- CreateIndex
CREATE INDEX "care_access_requests_specialist_id_status_expires_at_idx" ON "care_access_requests"("specialist_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "care_jobs_tenant_id_website_id_state_idx" ON "care_jobs"("tenant_id", "website_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "care_jobs_tenant_id_website_id_request_key_key" ON "care_jobs"("tenant_id", "website_id", "request_key");

-- CreateIndex
CREATE UNIQUE INDEX "care_jobs_tenant_id_website_id_id_key" ON "care_jobs"("tenant_id", "website_id", "id");

-- CreateIndex
CREATE INDEX "care_agent_runs_tenant_id_website_id_job_id_idx" ON "care_agent_runs"("tenant_id", "website_id", "job_id");

-- CreateIndex
CREATE UNIQUE INDEX "care_events_id_key" ON "care_events"("id");

-- CreateIndex
CREATE INDEX "care_events_tenant_id_website_id_sequence_idx" ON "care_events"("tenant_id", "website_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "websites_tenant_id_id_key" ON "websites"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "website_access_credentials_vault_credential_id_key" ON "website_access_credentials"("vault_credential_id");

-- AddForeignKey
ALTER TABLE "care_credentials" ADD CONSTRAINT "care_credentials_tenant_id_website_id_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_access_requests" ADD CONSTRAINT "care_access_requests_tenant_id_website_id_credential_id_fkey" FOREIGN KEY ("tenant_id", "website_id", "credential_id") REFERENCES "care_credentials"("tenant_id", "website_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_jobs" ADD CONSTRAINT "care_jobs_tenant_id_website_id_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_agent_runs" ADD CONSTRAINT "care_agent_runs_tenant_id_website_id_job_id_fkey" FOREIGN KEY ("tenant_id", "website_id", "job_id") REFERENCES "care_jobs"("tenant_id", "website_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_events" ADD CONSTRAINT "care_events_tenant_id_website_id_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "website_access_credentials" ADD CONSTRAINT "website_access_credentials_vault_credential_id_fkey" FOREIGN KEY ("vault_credential_id") REFERENCES "care_credentials"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Preserve resource bindings at the database boundary, including legacy unmanaged composite keys.
ALTER TABLE "care_access_requests" ADD CONSTRAINT "care_access_ticket_scope_fkey" FOREIGN KEY ("tenant_id", "website_id", "ticket_id") REFERENCES "tickets"("tenant_id", "website_id", "id") ON DELETE CASCADE;
ALTER TABLE "care_access_requests" ADD CONSTRAINT "care_access_specialist_fkey" FOREIGN KEY ("specialist_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "care_credentials" ADD CONSTRAINT "care_credential_actor_fkey" FOREIGN KEY ("authorized_by") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "care_jobs" ADD CONSTRAINT "care_job_actor_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
ALTER TABLE "care_credentials" ADD CONSTRAINT "care_credential_environment_check" CHECK ("environment" IN ('PRODUCTION','STAGING'));
ALTER TABLE "care_credentials" ADD CONSTRAINT "care_credential_status_check" CHECK ("status" IN ('STORED','REVOKED','EXPIRED'));
ALTER TABLE "care_credentials" ADD CONSTRAINT "care_credential_port_check" CHECK ("port" BETWEEN 1 AND 65535);
ALTER TABLE "care_access_requests" ADD CONSTRAINT "care_access_status_check" CHECK ("status" IN ('PENDING','APPROVED','DENIED','REVOKED','EXPIRED'));

ALTER TABLE "chat_messages" ADD COLUMN "environment" VARCHAR(16) NOT NULL DEFAULT 'PRODUCTION';
