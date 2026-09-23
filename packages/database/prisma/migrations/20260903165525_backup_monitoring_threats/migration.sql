CREATE TYPE "BackupPurpose" AS ENUM ('MANUAL','SCHEDULED','PRE_REMEDIATION');
CREATE TYPE "SecurityEventType" AS ENUM ('AVAILABILITY','TLS','DNS','HEADERS','INTEGRITY','SECURITY_INDICATOR');
CREATE TYPE "SecurityEventStatus" AS ENUM ('OPEN','ACKNOWLEDGED','ESCALATED','RESOLVED');
CREATE TYPE "AlertStatus" AS ENUM ('OPEN','ACKNOWLEDGED','RESOLVED','SUPPRESSED');

ALTER TABLE "backups" ADD COLUMN "purpose" "BackupPurpose" NOT NULL DEFAULT 'MANUAL',
  ADD COLUMN "size_bytes" BIGINT, ADD COLUMN "encryption" JSONB, ADD COLUMN "retention_until" TIMESTAMPTZ(6),
  ADD COLUMN "protected_until" TIMESTAMPTZ(6), ADD COLUMN "delete_requested_at" TIMESTAMPTZ(6),
  ADD COLUMN "deleted_at" TIMESTAMPTZ(6), ADD COLUMN "provider_key" VARCHAR(120);

CREATE TABLE "backup_policies" (
  "website_id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false,
  "frequency_hours" INTEGER NOT NULL DEFAULT 24, "retention_days" INTEGER NOT NULL DEFAULT 30,
  "restore_point_limit" INTEGER NOT NULL DEFAULT 30, "next_backup_at" TIMESTAMPTZ(6), "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE, FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "backup_policies_scope_fkey" FOREIGN KEY ("tenant_id","website_id") REFERENCES "websites"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "backup_policies_values_check" CHECK ("frequency_hours" BETWEEN 1 AND 8760 AND "retention_days" BETWEEN 1 AND 3650 AND "restore_point_limit" BETWEEN 1 AND 10000)
);
CREATE INDEX "backup_policies_tenant_id_enabled_next_backup_at_idx" ON "backup_policies"("tenant_id","enabled","next_backup_at");

CREATE TABLE "monitoring_policies" (
  "website_id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false,
  "interval_minutes" INTEGER NOT NULL DEFAULT 60, "alert_cooldown_minutes" INTEGER NOT NULL DEFAULT 60,
  "indicators" JSONB NOT NULL DEFAULT '{}', "next_check_at" TIMESTAMPTZ(6), "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE, FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "monitoring_policies_scope_fkey" FOREIGN KEY ("tenant_id","website_id") REFERENCES "websites"("tenant_id","id") ON DELETE CASCADE,
  CONSTRAINT "monitoring_policies_values_check" CHECK ("interval_minutes" BETWEEN 5 AND 10080 AND "alert_cooldown_minutes" BETWEEN 5 AND 10080)
);
CREATE INDEX "monitoring_policies_tenant_id_enabled_next_check_at_idx" ON "monitoring_policies"("tenant_id","enabled","next_check_at");

CREATE TABLE "monitoring_checks" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL,
  "job_id" VARCHAR(160) NOT NULL UNIQUE, "status" "JobStatus" NOT NULL DEFAULT 'RUNNING', "snapshot" JSONB,
  "snapshot_hash" CHAR(64), "resolved_address" INET, "response_time_ms" INTEGER, "error_code" VARCHAR(120),
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" TIMESTAMPTZ(6),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE, FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE,
  CONSTRAINT "monitoring_checks_scope_fkey" FOREIGN KEY ("tenant_id","website_id") REFERENCES "websites"("tenant_id","id") ON DELETE CASCADE
);
CREATE INDEX "monitoring_checks_tenant_id_website_id_started_at_idx" ON "monitoring_checks"("tenant_id","website_id","started_at");

CREATE TABLE "security_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "check_id" UUID NOT NULL,
  "type" "SecurityEventType" NOT NULL, "severity" "FindingSeverity" NOT NULL, "status" "SecurityEventStatus" NOT NULL DEFAULT 'OPEN',
  "fingerprint" CHAR(64) NOT NULL, "title" VARCHAR(240) NOT NULL, "summary" TEXT NOT NULL,
  "occurrence_count" INTEGER NOT NULL DEFAULT 1, "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolved_at" TIMESTAMPTZ(6),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE, FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE,
  FOREIGN KEY ("check_id") REFERENCES "monitoring_checks"("id") ON DELETE RESTRICT,
  CONSTRAINT "security_events_scope_fkey" FOREIGN KEY ("tenant_id","website_id") REFERENCES "websites"("tenant_id","id") ON DELETE CASCADE
);
CREATE INDEX "security_events_tenant_id_website_id_status_last_seen_at_idx" ON "security_events"("tenant_id","website_id","status","last_seen_at");
CREATE INDEX "security_events_fingerprint_status_idx" ON "security_events"("fingerprint","status");

CREATE TABLE "security_event_evidence" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "event_id" UUID NOT NULL, "observed_at" TIMESTAMPTZ(6) NOT NULL,
  "engine" VARCHAR(120) NOT NULL, "engine_version" VARCHAR(40) NOT NULL, "summary" TEXT NOT NULL, "metadata" JSONB NOT NULL,
  "integrity_hash" CHAR(64) NOT NULL, FOREIGN KEY ("event_id") REFERENCES "security_events"("id") ON DELETE CASCADE
);
CREATE INDEX "security_event_evidence_event_id_observed_at_idx" ON "security_event_evidence"("event_id","observed_at");

CREATE TABLE "security_alerts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "event_id" UUID NOT NULL,
  "deduplication_key" CHAR(64) NOT NULL, "severity" "FindingSeverity" NOT NULL, "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
  "suppressed_count" INTEGER NOT NULL DEFAULT 0, "cooldown_until" TIMESTAMPTZ(6) NOT NULL,
  "notification_id" UUID UNIQUE, "specialist_ticket_id" UUID UNIQUE,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE, FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE,
  FOREIGN KEY ("event_id") REFERENCES "security_events"("id") ON DELETE CASCADE, FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE SET NULL,
  FOREIGN KEY ("specialist_ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL,
  CONSTRAINT "security_alerts_scope_fkey" FOREIGN KEY ("tenant_id","website_id") REFERENCES "websites"("tenant_id","id") ON DELETE CASCADE
);
CREATE INDEX "security_alerts_tenant_id_website_id_status_created_at_idx" ON "security_alerts"("tenant_id","website_id","status","created_at");
CREATE INDEX "security_alerts_deduplication_key_cooldown_until_idx" ON "security_alerts"("deduplication_key","cooldown_until");

CREATE TABLE "restore_authorizations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "backup_id" UUID NOT NULL,
  "authorized_by_user_id" UUID NOT NULL, "expires_at" TIMESTAMPTZ(6) NOT NULL, "used_at" TIMESTAMPTZ(6), "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT, FOREIGN KEY ("backup_id") REFERENCES "backups"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("authorized_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "restore_authorizations_scope_fkey" FOREIGN KEY ("tenant_id","website_id") REFERENCES "websites"("tenant_id","id") ON DELETE RESTRICT
);
CREATE INDEX "restore_authorizations_tenant_id_website_id_backup_id_expires_at_idx" ON "restore_authorizations"("tenant_id","website_id","backup_id","expires_at");

CREATE TABLE "restore_operations" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "backup_id" UUID NOT NULL,
  "authorization_id" UUID NOT NULL, "status" "JobStatus" NOT NULL DEFAULT 'QUEUED', "error_code" VARCHAR(120),
  "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" TIMESTAMPTZ(6),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT, FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("backup_id") REFERENCES "backups"("id") ON DELETE RESTRICT, FOREIGN KEY ("authorization_id") REFERENCES "restore_authorizations"("id") ON DELETE RESTRICT,
  CONSTRAINT "restore_operations_scope_fkey" FOREIGN KEY ("tenant_id","website_id") REFERENCES "websites"("tenant_id","id") ON DELETE RESTRICT
);
CREATE INDEX "restore_operations_tenant_id_website_id_requested_at_idx" ON "restore_operations"("tenant_id","website_id","requested_at");

CREATE TABLE "developer_mode_settings" (
  "tenant_id" UUID PRIMARY KEY, "enabled" BOOLEAN NOT NULL DEFAULT false, "enabled_by_user_id" UUID NOT NULL,
  "enabled_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "expires_at" TIMESTAMPTZ(6), "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE, FOREIGN KEY ("enabled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT
);

INSERT INTO "permissions" ("id","key","description","created_at") VALUES
('70000000-0000-4000-8000-000000000001','monitoring.configure','Configure monitoring policies',CURRENT_TIMESTAMP),
('70000000-0000-4000-8000-000000000002','backups.configure','Configure backup policies and retention',CURRENT_TIMESTAMP),
('70000000-0000-4000-8000-000000000003','alerts.manage','Manage security events and alerts',CURRENT_TIMESTAMP),
('70000000-0000-4000-8000-000000000004','developer_mode.manage','Manage tenant developer diagnostics',CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("role_id","permission_id") SELECT r."id",p."id" FROM "roles" r CROSS JOIN "permissions" p WHERE
(r."name"='Customer' AND p."key" IN ('developer_mode.manage')) OR
(r."name"='Owner' AND p."key" IN ('monitoring.configure','backups.configure','alerts.manage','developer_mode.manage')) OR
(r."name"='Cybersecurity Specialist' AND p."key" IN ('alerts.manage')) ON CONFLICT DO NOTHING;
