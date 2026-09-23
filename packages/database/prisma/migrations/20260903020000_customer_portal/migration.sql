CREATE TYPE "WebsiteLifecycle" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "ConnectionStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED');
CREATE TYPE "SecurityStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'ATTENTION', 'CRITICAL');
CREATE TYPE "ServiceStatus" AS ENUM ('NOT_CONFIGURED', 'PENDING', 'ACTIVE', 'PAUSED', 'ERROR');
CREATE TYPE "FindingSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "FindingStatus" AS ENUM ('OPEN', 'RESOLVED', 'ACCEPTED');
CREATE TYPE "JobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');
CREATE TYPE "ChatMessageType" AS ENUM ('CUSTOMER', 'AI', 'SPECIALIST', 'SYSTEM');
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED');
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'OPEN', 'PAID', 'VOID', 'UNCOLLECTIBLE');
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'EXPIRED');

CREATE TABLE "websites" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "name" VARCHAR(120) NOT NULL, "url" VARCHAR(2048) NOT NULL,
  "normalized_host" VARCHAR(253) NOT NULL, "lifecycle" "WebsiteLifecycle" NOT NULL DEFAULT 'ACTIVE',
  "connection_status" "ConnectionStatus" NOT NULL DEFAULT 'PENDING', "security_status" "SecurityStatus" NOT NULL DEFAULT 'UNKNOWN',
  "monitoring_status" "ServiceStatus" NOT NULL DEFAULT 'NOT_CONFIGURED', "backup_status" "ServiceStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "last_scan_at" TIMESTAMPTZ(6), "archived_at" TIMESTAMPTZ(6), "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL, CONSTRAINT "websites_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "websites_tenant_id_normalized_host_key" ON "websites"("tenant_id", "normalized_host");
CREATE UNIQUE INDEX "websites_tenant_id_id_key" ON "websites"("tenant_id", "id");
CREATE INDEX "websites_tenant_id_lifecycle_idx" ON "websites"("tenant_id", "lifecycle");

CREATE TABLE "website_verifications" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "token_hash" CHAR(64) NOT NULL,
  "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING', "expires_at" TIMESTAMPTZ(6) NOT NULL, "verified_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "website_verifications_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "website_verifications_token_hash_key" ON "website_verifications"("token_hash");
CREATE INDEX "website_verifications_tenant_id_website_id_status_idx" ON "website_verifications"("tenant_id", "website_id", "status");
ALTER TABLE "website_verifications" ADD CONSTRAINT "website_verifications_tenant_website_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE;

CREATE TABLE "security_findings" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "title" VARCHAR(240) NOT NULL,
  "description" TEXT, "severity" "FindingSeverity" NOT NULL, "status" "FindingStatus" NOT NULL DEFAULT 'OPEN',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "security_findings_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE
);
CREATE INDEX "security_findings_tenant_id_website_id_status_idx" ON "security_findings"("tenant_id", "website_id", "status");
CREATE UNIQUE INDEX "security_findings_tenant_id_website_id_id_key" ON "security_findings"("tenant_id", "website_id", "id");
ALTER TABLE "security_findings" ADD CONSTRAINT "security_findings_tenant_website_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE;

CREATE TABLE "scans" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
  "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "started_at" TIMESTAMPTZ(6), "completed_at" TIMESTAMPTZ(6), "error_code" VARCHAR(120),
  CONSTRAINT "scans_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE
);
CREATE INDEX "scans_tenant_id_website_id_requested_at_idx" ON "scans"("tenant_id", "website_id", "requested_at");
ALTER TABLE "scans" ADD CONSTRAINT "scans_tenant_website_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE;

CREATE TABLE "tickets" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "finding_id" UUID, "title" VARCHAR(240) NOT NULL,
  "description" TEXT, "status" "TicketStatus" NOT NULL DEFAULT 'OPEN', "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "tickets_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE,
  CONSTRAINT "tickets_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "security_findings"("id") ON DELETE SET NULL
);
CREATE INDEX "tickets_tenant_id_website_id_status_idx" ON "tickets"("tenant_id", "website_id", "status");
CREATE UNIQUE INDEX "tickets_tenant_id_website_id_id_key" ON "tickets"("tenant_id", "website_id", "id");
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_website_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE;
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_tenant_website_finding_fkey" FOREIGN KEY ("tenant_id", "website_id", "finding_id") REFERENCES "security_findings"("tenant_id", "website_id", "id");

CREATE TABLE "backups" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "status" "JobStatus" NOT NULL DEFAULT 'QUEUED',
  "requested_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" TIMESTAMPTZ(6), "error_code" VARCHAR(120),
  CONSTRAINT "backups_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE
);
CREATE INDEX "backups_tenant_id_website_id_requested_at_idx" ON "backups"("tenant_id", "website_id", "requested_at");
ALTER TABLE "backups" ADD CONSTRAINT "backups_tenant_website_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE;

CREATE TABLE "reports" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "title" VARCHAR(240) NOT NULL,
  "status" "JobStatus" NOT NULL DEFAULT 'QUEUED', "storage_key" VARCHAR(1024), "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "reports_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE
);
CREATE INDEX "reports_tenant_id_website_id_created_at_idx" ON "reports"("tenant_id", "website_id", "created_at");
ALTER TABLE "reports" ADD CONSTRAINT "reports_tenant_website_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE;

CREATE TABLE "chat_messages" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "author_user_id" UUID,
  "type" "ChatMessageType" NOT NULL, "content" VARCHAR(4000) NOT NULL, "finding_id" UUID, "ticket_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "chat_messages_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE,
  CONSTRAINT "chat_messages_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL,
  CONSTRAINT "chat_messages_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "security_findings"("id") ON DELETE SET NULL,
  CONSTRAINT "chat_messages_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE SET NULL
);
CREATE INDEX "chat_messages_tenant_id_website_id_created_at_idx" ON "chat_messages"("tenant_id", "website_id", "created_at");
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_tenant_website_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE;
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_tenant_website_finding_fkey" FOREIGN KEY ("tenant_id", "website_id", "finding_id") REFERENCES "security_findings"("tenant_id", "website_id", "id");
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_tenant_website_ticket_fkey" FOREIGN KEY ("tenant_id", "website_id", "ticket_id") REFERENCES "tickets"("tenant_id", "website_id", "id");

CREATE TABLE "subscriptions" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "provider_reference" VARCHAR(255), "plan_name" VARCHAR(120) NOT NULL,
  "status" "SubscriptionStatus" NOT NULL, "current_period_end" TIMESTAMPTZ(6), "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "subscriptions_provider_reference_key" ON "subscriptions"("provider_reference");
CREATE INDEX "subscriptions_tenant_id_status_idx" ON "subscriptions"("tenant_id", "status");

CREATE TABLE "invoices" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "provider_reference" VARCHAR(255), "amount_minor" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL, "status" "InvoiceStatus" NOT NULL, "issued_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "invoices_provider_reference_key" ON "invoices"("provider_reference");
CREATE INDEX "invoices_tenant_id_issued_at_idx" ON "invoices"("tenant_id", "issued_at");

CREATE TABLE "notifications" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "title" VARCHAR(240) NOT NULL, "body" TEXT NOT NULL,
  "read_at" TIMESTAMPTZ(6), "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE
);
CREATE INDEX "notifications_tenant_id_read_at_created_at_idx" ON "notifications"("tenant_id", "read_at", "created_at");

INSERT INTO "permissions" ("id", "key", "description", "created_at") VALUES
('20000000-0000-4000-8000-000000000020', 'websites.read', 'Read websites in authorized tenant', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000021', 'websites.manage', 'Manage websites in authorized tenant', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000022', 'findings.read', 'Read findings in authorized tenant', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000023', 'scans.read', 'Read scans in authorized tenant', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000024', 'scans.run', 'Request scans in authorized tenant', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000025', 'monitoring.manage', 'Manage monitoring in authorized tenant', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000026', 'backups.manage', 'Manage backups in authorized tenant', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000027', 'reports.read', 'Read and request reports in authorized tenant', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000028', 'chat.read', 'Read authorized website chat', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000029', 'chat.write', 'Write authorized website chat', CURRENT_TIMESTAMP);

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p
WHERE (r."name" = 'Customer' AND p."key" IN ('websites.read','websites.manage','findings.read','scans.read','scans.run','monitoring.manage','backups.manage','reports.read','chat.read','chat.write'))
   OR (r."name" = 'Cybersecurity Specialist' AND p."key" IN ('websites.read','findings.read','scans.read','reports.read','chat.read','chat.write'))
   OR (r."name" = 'Owner' AND p."key" IN ('websites.read','websites.manage','findings.read','scans.read','scans.run','monitoring.manage','backups.manage','reports.read','chat.read','chat.write'));
