-- AlterTable
ALTER TABLE "care_jobs" ADD COLUMN     "lease_expires_at" TIMESTAMPTZ(6),
ADD COLUMN     "lease_owner" UUID;

-- CreateTable
CREATE TABLE "care_artifacts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "job_id" UUID,
    "environment" VARCHAR(16) NOT NULL,
    "kind" VARCHAR(20) NOT NULL,
    "filename" VARCHAR(120) NOT NULL,
    "content_type" VARCHAR(100) NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'QUARANTINED',
    "digest" CHAR(64) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "encrypted_body" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "care_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_revisions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "source_id" UUID NOT NULL,
    "source_digest" CHAR(64) NOT NULL,
    "candidate_id" UUID,
    "candidate_digest" CHAR(64),
    "state" VARCHAR(32) NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "plan" JSONB NOT NULL,
    "verification" JSONB,
    "approved_by" UUID,
    "approval_expires_at" TIMESTAMPTZ(6),
    "budget_micros" INTEGER NOT NULL,
    "charged_micros" INTEGER NOT NULL DEFAULT 0,
    "budget_state" VARCHAR(16) NOT NULL DEFAULT 'UNRESERVED',
    "usage_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "care_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "care_releases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "revision_id" UUID NOT NULL,
    "request_key" UUID NOT NULL,
    "credential_id" UUID NOT NULL,
    "credential_version" INTEGER NOT NULL,
    "remote_path" VARCHAR(1024) NOT NULL,
    "source_digest" CHAR(64) NOT NULL,
    "candidate_digest" CHAR(64) NOT NULL,
    "backup_id" UUID,
    "state" VARCHAR(32) NOT NULL DEFAULT 'AWAITING_APPROVAL',
    "approved_by" UUID,
    "approval_expires_at" TIMESTAMPTZ(6),
    "heartbeat_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error_code" VARCHAR(100),
    "evidence" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "care_releases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "care_artifacts_tenant_id_website_id_environment_status_idx" ON "care_artifacts"("tenant_id", "website_id", "environment", "status");

-- CreateIndex
CREATE UNIQUE INDEX "care_artifacts_tenant_id_website_id_id_key" ON "care_artifacts"("tenant_id", "website_id", "id");

-- CreateIndex
CREATE INDEX "care_revisions_tenant_id_budget_state_created_at_idx" ON "care_revisions"("tenant_id", "budget_state", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "care_revisions_tenant_id_website_id_id_key" ON "care_revisions"("tenant_id", "website_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "care_revisions_job_id_version_key" ON "care_revisions"("job_id", "version");

-- CreateIndex
CREATE INDEX "care_releases_tenant_id_website_id_state_idx" ON "care_releases"("tenant_id", "website_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "care_releases_tenant_id_website_id_request_key_key" ON "care_releases"("tenant_id", "website_id", "request_key");

-- AddForeignKey
ALTER TABLE "care_artifacts" ADD CONSTRAINT "care_artifacts_tenant_id_website_id_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_revisions" ADD CONSTRAINT "care_revisions_tenant_id_website_id_job_id_fkey" FOREIGN KEY ("tenant_id", "website_id", "job_id") REFERENCES "care_jobs"("tenant_id", "website_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "care_releases" ADD CONSTRAINT "care_releases_tenant_id_website_id_job_id_fkey" FOREIGN KEY ("tenant_id", "website_id", "job_id") REFERENCES "care_jobs"("tenant_id", "website_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE care_artifacts ADD CONSTRAINT care_artifact_job_scope FOREIGN KEY (tenant_id,website_id,job_id) REFERENCES care_jobs(tenant_id,website_id,id) ON DELETE CASCADE;
ALTER TABLE care_revisions ADD CONSTRAINT care_revision_source_scope FOREIGN KEY (tenant_id,website_id,source_id) REFERENCES care_artifacts(tenant_id,website_id,id) ON DELETE CASCADE;
ALTER TABLE care_revisions ADD CONSTRAINT care_revision_candidate_scope FOREIGN KEY (tenant_id,website_id,candidate_id) REFERENCES care_artifacts(tenant_id,website_id,id) ON DELETE CASCADE;
ALTER TABLE care_releases ADD CONSTRAINT care_release_revision_scope FOREIGN KEY (tenant_id,website_id,revision_id) REFERENCES care_revisions(tenant_id,website_id,id) ON DELETE CASCADE;
ALTER TABLE care_releases ADD CONSTRAINT care_release_credential_scope FOREIGN KEY (tenant_id,website_id,credential_id) REFERENCES care_credentials(tenant_id,website_id,id) ON DELETE CASCADE;
ALTER TABLE care_releases ADD CONSTRAINT care_release_backup_scope FOREIGN KEY (tenant_id,website_id,backup_id) REFERENCES care_artifacts(tenant_id,website_id,id) ON DELETE CASCADE;
CREATE UNIQUE INDEX care_single_active_release ON care_releases(tenant_id,website_id) WHERE state IN ('QUEUED','RUNNING','VERIFYING','OUTCOME_UNKNOWN');
ALTER TABLE care_artifacts ADD CONSTRAINT care_artifact_environment CHECK (environment IN ('PRODUCTION','STAGING'));
ALTER TABLE care_artifacts ADD CONSTRAINT care_artifact_size CHECK (size_bytes >= 0 AND size_bytes <= 4000000);
ALTER TABLE care_revisions ADD CONSTRAINT care_revision_budget CHECK (budget_micros > 0 AND charged_micros >= 0);

ALTER TABLE ai_usage ADD COLUMN purpose VARCHAR(32) NOT NULL DEFAULT 'CHAT';

CREATE UNIQUE INDEX care_single_running_repair ON care_jobs(tenant_id,website_id) WHERE kind = 'REPAIR' AND state IN ('RUNNING','VERIFYING');
