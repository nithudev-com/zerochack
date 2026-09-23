CREATE TYPE "TicketStatus_new" AS ENUM ('CREATED','QUEUED','ASSIGNED','ACCEPTED','AWAITING_AUTHORIZATION','AUTHORIZED','BACKUP_PENDING','READY','IN_PROGRESS','AWAITING_CUSTOMER','POST_SCAN','RESOLVED','CLOSED','ESCALATED','CANCELLED');
ALTER TABLE "tickets" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "tickets" ALTER COLUMN "status" TYPE "TicketStatus_new" USING (CASE WHEN "status"::text = 'OPEN' THEN 'CREATED' ELSE "status"::text END)::"TicketStatus_new";
DROP TYPE "TicketStatus";
ALTER TYPE "TicketStatus_new" RENAME TO "TicketStatus";
ALTER TABLE "tickets" ALTER COLUMN "status" SET DEFAULT 'CREATED';
ALTER TABLE "tickets" ADD COLUMN "assigned_specialist_id" UUID, ADD COLUMN "assignment_expires_at" TIMESTAMPTZ(6), ADD COLUMN "accepted_at" TIMESTAMPTZ(6), ADD COLUMN "escalated_at" TIMESTAMPTZ(6);
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assigned_specialist_id_fkey" FOREIGN KEY ("assigned_specialist_id") REFERENCES "users"("id") ON DELETE SET NULL;
CREATE INDEX "tickets_status_assignment_expires_at_idx" ON "tickets"("status", "assignment_expires_at");

ALTER TABLE "backups" ADD COLUMN "ticket_id" UUID, ADD COLUMN "verified_at" TIMESTAMPTZ(6), ADD COLUMN "restore_reference" VARCHAR(500), ADD COLUMN "integrity_hash" CHAR(64);
ALTER TABLE "backups" ADD CONSTRAINT "backups_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT;

CREATE TYPE "RemediationSessionStatus" AS ENUM ('ACTIVE','EXPIRED','REVOKED','COMPLETED');
CREATE TYPE "RemediationRunStatus" AS ENUM ('PENDING','RUNNING','AWAITING_POST_SCAN','SUCCEEDED','FAILED','CANCELLED');
CREATE TYPE "WarrantyClaimStatus" AS ENUM ('SUBMITTED','REVIEWING','APPROVED','REJECTED','RESOLVED');

CREATE TABLE "remediation_authorizations" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "ticket_id" UUID NOT NULL,
 "authorized_by_user_id" UUID NOT NULL, "scope" TEXT[] NOT NULL, "authorized_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "expires_at" TIMESTAMPTZ(6) NOT NULL, "revoked_at" TIMESTAMPTZ(6),
 CONSTRAINT "remediation_authorizations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
 CONSTRAINT "remediation_authorizations_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT,
 CONSTRAINT "remediation_authorizations_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT,
 CONSTRAINT "remediation_authorizations_authorized_by_user_id_fkey" FOREIGN KEY ("authorized_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
 CONSTRAINT "remediation_authorizations_tenant_ticket_fkey" FOREIGN KEY ("tenant_id","website_id","ticket_id") REFERENCES "tickets"("tenant_id","website_id","id") ON DELETE RESTRICT
);
CREATE INDEX "remediation_authorizations_tenant_id_website_id_ticket_id_expires_at_idx" ON "remediation_authorizations"("tenant_id","website_id","ticket_id","expires_at");

CREATE TABLE "remediation_sessions" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "ticket_id" UUID NOT NULL,
 "specialist_id" UUID NOT NULL, "authorization_id" UUID NOT NULL, "token_hash" CHAR(64) NOT NULL, "scope" TEXT[] NOT NULL,
 "status" "RemediationSessionStatus" NOT NULL DEFAULT 'ACTIVE', "expires_at" TIMESTAMPTZ(6) NOT NULL, "revoked_at" TIMESTAMPTZ(6),
 "revoked_reason" VARCHAR(160), "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "remediation_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
 CONSTRAINT "remediation_sessions_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT,
 CONSTRAINT "remediation_sessions_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT,
 CONSTRAINT "remediation_sessions_specialist_id_fkey" FOREIGN KEY ("specialist_id") REFERENCES "users"("id") ON DELETE RESTRICT,
 CONSTRAINT "remediation_sessions_authorization_id_fkey" FOREIGN KEY ("authorization_id") REFERENCES "remediation_authorizations"("id") ON DELETE RESTRICT,
 CONSTRAINT "remediation_sessions_tenant_ticket_fkey" FOREIGN KEY ("tenant_id","website_id","ticket_id") REFERENCES "tickets"("tenant_id","website_id","id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "remediation_sessions_token_hash_key" ON "remediation_sessions"("token_hash");
CREATE INDEX "remediation_sessions_specialist_id_status_expires_at_idx" ON "remediation_sessions"("specialist_id","status","expires_at");
CREATE INDEX "remediation_sessions_tenant_id_website_id_ticket_id_idx" ON "remediation_sessions"("tenant_id","website_id","ticket_id");

CREATE TABLE "remediation_playbooks" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "name" VARCHAR(160) NOT NULL, "version" INTEGER NOT NULL, "description" TEXT,
 "enabled" BOOLEAN NOT NULL DEFAULT false, "action_keys" TEXT[] NOT NULL, "required_scopes" TEXT[] NOT NULL,
 "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "remediation_playbooks_name_version_key" ON "remediation_playbooks"("name","version");

CREATE TABLE "remediation_runs" (
 "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "ticket_id" UUID NOT NULL,
 "specialist_id" UUID NOT NULL, "authorization_id" UUID NOT NULL, "session_id" UUID NOT NULL, "backup_id" UUID NOT NULL, "playbook_id" UUID NOT NULL,
 "status" "RemediationRunStatus" NOT NULL DEFAULT 'PENDING', "executed_actions" TEXT[] NOT NULL, "before_scan_id" UUID, "post_scan_id" UUID,
 "comparison" JSONB, "error_code" VARCHAR(120), "started_at" TIMESTAMPTZ(6), "completed_at" TIMESTAMPTZ(6), "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT, FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT,
 FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT, FOREIGN KEY ("specialist_id") REFERENCES "users"("id") ON DELETE RESTRICT,
 FOREIGN KEY ("authorization_id") REFERENCES "remediation_authorizations"("id") ON DELETE RESTRICT, FOREIGN KEY ("session_id") REFERENCES "remediation_sessions"("id") ON DELETE RESTRICT,
 FOREIGN KEY ("backup_id") REFERENCES "backups"("id") ON DELETE RESTRICT, FOREIGN KEY ("playbook_id") REFERENCES "remediation_playbooks"("id") ON DELETE RESTRICT,
 CONSTRAINT "remediation_runs_tenant_ticket_fkey" FOREIGN KEY ("tenant_id","website_id","ticket_id") REFERENCES "tickets"("tenant_id","website_id","id") ON DELETE RESTRICT
);
CREATE INDEX "remediation_runs_tenant_id_ticket_id_created_at_idx" ON "remediation_runs"("tenant_id","ticket_id","created_at");

CREATE TABLE "warranty_policies" ("tenant_id" UUID PRIMARY KEY, "duration_days" INTEGER NOT NULL, "eligible_severities" TEXT[] NOT NULL, "exclusions" TEXT[] NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false, "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE);
CREATE TABLE "warranty_claims" ("id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL, "ticket_id" UUID NOT NULL, "submitted_by_user_id" UUID NOT NULL, "finding_id" UUID, "reason" TEXT NOT NULL, "status" "WarrantyClaimStatus" NOT NULL DEFAULT 'SUBMITTED', "submitted_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolved_at" TIMESTAMPTZ(6), FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT, FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT, FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT, FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT, CONSTRAINT "warranty_claims_tenant_ticket_fkey" FOREIGN KEY ("tenant_id","website_id","ticket_id") REFERENCES "tickets"("tenant_id","website_id","id") ON DELETE RESTRICT);
CREATE INDEX "warranty_claims_tenant_id_status_submitted_at_idx" ON "warranty_claims"("tenant_id","status","submitted_at");

INSERT INTO "permissions" ("id","key","description","created_at") VALUES
('50000000-0000-4000-8000-000000000001','specialist.jobs.read','Read available specialist jobs',CURRENT_TIMESTAMP),
('50000000-0000-4000-8000-000000000002','specialist.jobs.accept','Accept and manage specialist jobs',CURRENT_TIMESTAMP),
('50000000-0000-4000-8000-000000000003','remediation.authorize','Authorize scoped remediation',CURRENT_TIMESTAMP),
('50000000-0000-4000-8000-000000000004','remediation.execute','Execute approved remediation playbooks',CURRENT_TIMESTAMP),
('50000000-0000-4000-8000-000000000005','remediation.manage','Manage remediation playbooks and assignments',CURRENT_TIMESTAMP),
('50000000-0000-4000-8000-000000000006','warranty.manage','Manage warranty policy and claims',CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("role_id","permission_id") SELECT r."id",p."id" FROM "roles" r CROSS JOIN "permissions" p WHERE
(r."name"='Customer' AND p."key" IN ('remediation.authorize')) OR
(r."name"='Cybersecurity Specialist' AND p."key" IN ('specialist.jobs.read','specialist.jobs.accept','remediation.execute')) OR
(r."name"='Owner' AND p."key" IN ('specialist.jobs.read','specialist.jobs.accept','remediation.authorize','remediation.execute','remediation.manage','warranty.manage')) ON CONFLICT DO NOTHING;
