CREATE TYPE "CommunicationEventType" AS ENUM ('REGISTRATION','EMAIL_VERIFICATION','APPROVAL','SUSPENSION','SCAN_STARTED','SCAN_COMPLETED','CRITICAL_FINDING','MONITORING_ALERT','BACKUP_SUCCESS','BACKUP_FAILURE','TICKET_CREATED','SPECIALIST_ASSIGNED','AUTHORIZATION_REQUESTED','REMEDIATION_STARTED','REMEDIATION_COMPLETED','POST_SCAN','WARRANTY','SUBSCRIPTION','PAYMENT','INVOICE','AFFILIATE_COMMISSION','PAYOUT');
CREATE TYPE "EmailDeliveryStatus" AS ENUM ('QUEUED','SENDING','RETRYING','DELIVERED','FAILED','SUPPRESSED');
CREATE TYPE "ReportType" AS ENUM ('SECURITY_SCAN','REMEDIATION','MONITORING','BEFORE_AFTER');

ALTER TABLE "notifications"
  ADD COLUMN "recipient_user_id" UUID,
  ADD COLUMN "event_id" UUID,
  ADD COLUMN "event_type" "CommunicationEventType";
CREATE UNIQUE INDEX "notifications_event_id_key" ON "notifications"("event_id");
CREATE INDEX "notifications_recipient_user_id_read_at_created_at_idx" ON "notifications"("recipient_user_id","read_at","created_at");
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE;

CREATE TABLE "notification_preferences" (
  "id" UUID PRIMARY KEY,
  "tenant_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "event_type" "CommunicationEventType" NOT NULL,
  "in_app_enabled" BOOLEAN NOT NULL DEFAULT true,
  "email_enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "notification_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "notification_preferences_tenant_id_user_id_event_type_key" ON "notification_preferences"("tenant_id","user_id","event_type");
CREATE INDEX "notification_preferences_user_id_idx" ON "notification_preferences"("user_id");

CREATE TABLE "communication_events" (
  "id" UUID PRIMARY KEY,
  "tenant_id" UUID NOT NULL,
  "recipient_user_id" UUID NOT NULL,
  "event_type" "CommunicationEventType" NOT NULL,
  "deduplication_key" VARCHAR(200) NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at" TIMESTAMPTZ(6),
  CONSTRAINT "communication_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "communication_events_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "communication_events_deduplication_key_key" ON "communication_events"("deduplication_key");
CREATE INDEX "communication_events_tenant_id_recipient_user_id_created_at_idx" ON "communication_events"("tenant_id","recipient_user_id","created_at");
CREATE INDEX "communication_events_processed_at_created_at_idx" ON "communication_events"("processed_at","created_at");

CREATE TABLE "email_template_versions" (
  "id" UUID PRIMARY KEY,
  "event_type" "CommunicationEventType" NOT NULL,
  "version" INTEGER NOT NULL,
  "subject_template" VARCHAR(240) NOT NULL,
  "body_template" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "email_template_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "email_template_versions_event_type_version_key" ON "email_template_versions"("event_type","version");
CREATE INDEX "email_template_versions_event_type_enabled_version_idx" ON "email_template_versions"("event_type","enabled","version");
CREATE UNIQUE INDEX "email_template_versions_one_enabled_per_event" ON "email_template_versions"("event_type") WHERE "enabled" = true;

CREATE TABLE "email_deliveries" (
  "id" UUID PRIMARY KEY,
  "tenant_id" UUID NOT NULL,
  "recipient_user_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "template_version_id" UUID NOT NULL,
  "recipient_email" VARCHAR(320) NOT NULL,
  "idempotency_key" VARCHAR(200) NOT NULL,
  "status" "EmailDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "provider_message_id" VARCHAR(255),
  "last_error_code" VARCHAR(120),
  "next_attempt_at" TIMESTAMPTZ(6),
  "attempt_started_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivered_at" TIMESTAMPTZ(6),
  CONSTRAINT "email_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "email_deliveries_recipient_user_id_fkey" FOREIGN KEY ("recipient_user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "email_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "communication_events"("id") ON DELETE CASCADE,
  CONSTRAINT "email_deliveries_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "email_template_versions"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "email_deliveries_event_id_key" ON "email_deliveries"("event_id");
CREATE UNIQUE INDEX "email_deliveries_idempotency_key_key" ON "email_deliveries"("idempotency_key");
CREATE INDEX "email_deliveries_tenant_id_status_created_at_idx" ON "email_deliveries"("tenant_id","status","created_at");
CREATE INDEX "email_deliveries_status_next_attempt_at_idx" ON "email_deliveries"("status","next_attempt_at");

ALTER TABLE "notifications" ADD CONSTRAINT "notifications_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "communication_events"("id") ON DELETE CASCADE;

ALTER TABLE "reports"
  ADD COLUMN "requested_by_user_id" UUID,
  ADD COLUMN "type" "ReportType" NOT NULL DEFAULT 'SECURITY_SCAN',
  ADD COLUMN "source_id" UUID,
  ADD COLUMN "content" JSONB,
  ADD COLUMN "integrity_hash" CHAR(64),
  ADD COLUMN "signature" VARCHAR(128),
  ADD COLUMN "error_code" VARCHAR(120),
  ADD COLUMN "generated_at" TIMESTAMPTZ(6);
ALTER TABLE "reports" ADD CONSTRAINT "reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
ALTER TABLE "reports" ADD CONSTRAINT "reports_requested_by_user_id_fkey" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;

INSERT INTO "permissions" ("id","key","description","created_at") VALUES
('b0000000-0000-4000-8000-000000000001','notifications.manage','Manage personal notification preferences',CURRENT_TIMESTAMP),
('b0000000-0000-4000-8000-000000000002','email.templates.manage','Manage versioned email templates',CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("role_id","permission_id")
SELECT r."id",p."id" FROM "roles" r CROSS JOIN "permissions" p
WHERE (p."key"='notifications.manage' AND r."name" IN ('Customer','Agency','Affiliate','Cybersecurity Specialist','Owner'))
   OR (p."key"='email.templates.manage' AND r."name"='Owner')
ON CONFLICT DO NOTHING;

INSERT INTO "email_template_versions" ("id","event_type","version","subject_template","body_template","enabled","created_at")
SELECT gen_random_uuid(), event_type, 1, 'ZeroRoot: {{title}}', E'Hello {{recipientName}},\n\n{{message}}\n\nOpen ZeroRoot: {{actionUrl}}', true, CURRENT_TIMESTAMP
FROM unnest(enum_range(NULL::"CommunicationEventType")) AS event_type;
