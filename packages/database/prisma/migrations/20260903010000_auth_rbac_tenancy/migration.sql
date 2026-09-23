CREATE TYPE "AccountStatus" AS ENUM ('REGISTERED', 'EMAIL_VERIFIED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'SUSPENDED', 'DEACTIVATED');
CREATE TYPE "AuthTokenType" AS ENUM ('EMAIL_VERIFICATION', 'PASSWORD_RESET', 'MFA_CHALLENGE');
CREATE TYPE "AgencyClientStatus" AS ENUM ('PENDING', 'ACTIVE', 'REVOKED');

ALTER TABLE "users"
  ADD COLUMN "status" "AccountStatus" NOT NULL DEFAULT 'REGISTERED',
  ADD COLUMN "email_verified_at" TIMESTAMPTZ(6),
  ADD COLUMN "failed_login_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "locked_until" TIMESTAMPTZ(6),
  ADD COLUMN "mfa_secret_encrypted" TEXT,
  ADD COLUMN "mfa_enabled_at" TIMESTAMPTZ(6);

ALTER TABLE "sessions"
  ADD COLUMN "revoked_reason" VARCHAR(120),
  ADD COLUMN "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "ip_address" INET,
  ADD COLUMN "user_agent" VARCHAR(500),
  ADD COLUMN "mfa_verified_at" TIMESTAMPTZ(6);

ALTER TABLE "audit_logs" ALTER COLUMN "tenant_id" DROP NOT NULL;

ALTER TABLE "user_roles" ADD COLUMN "tenant_id" UUID;
UPDATE "user_roles" ur SET "tenant_id" = r."tenant_id" FROM "roles" r WHERE ur."role_id" = r."id" AND r."tenant_id" IS NOT NULL;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "user_roles" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION 'Existing global role assignments require an explicit tenant before Phase 1 migration';
  END IF;
END $$;
ALTER TABLE "user_roles" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "user_roles" DROP CONSTRAINT "user_roles_pkey";
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_pkey" PRIMARY KEY ("tenant_id", "user_id", "role_id");
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE;
CREATE INDEX "user_roles_tenant_id_user_id_idx" ON "user_roles"("tenant_id", "user_id");
CREATE UNIQUE INDEX "roles_system_name_key" ON "roles"("name") WHERE "tenant_id" IS NULL;

CREATE TABLE "auth_tokens" (
  "id" UUID PRIMARY KEY, "user_id" UUID NOT NULL, "type" "AuthTokenType" NOT NULL,
  "token_hash" CHAR(64) NOT NULL UNIQUE, "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6), "metadata" JSONB, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "auth_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE
);
CREATE INDEX "auth_tokens_user_id_type_idx" ON "auth_tokens"("user_id", "type");
CREATE INDEX "auth_tokens_expires_at_idx" ON "auth_tokens"("expires_at");

CREATE TABLE "mfa_recovery_codes" (
  "id" UUID PRIMARY KEY, "user_id" UUID NOT NULL, "code_hash" CHAR(64) NOT NULL,
  "used_at" TIMESTAMPTZ(6), "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_recovery_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE,
  CONSTRAINT "mfa_recovery_codes_user_id_code_hash_key" UNIQUE ("user_id", "code_hash")
);

CREATE TABLE "agency_client_relationships" (
  "id" UUID PRIMARY KEY, "agency_tenant_id" UUID NOT NULL, "client_tenant_id" UUID NOT NULL,
  "status" "AgencyClientStatus" NOT NULL DEFAULT 'PENDING', "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "agency_client_relationships_agency_tenant_id_fkey" FOREIGN KEY ("agency_tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "agency_client_relationships_client_tenant_id_fkey" FOREIGN KEY ("client_tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "agency_client_relationships_agency_client_key" UNIQUE ("agency_tenant_id", "client_tenant_id"),
  CONSTRAINT "agency_client_relationships_distinct_tenants" CHECK ("agency_tenant_id" <> "client_tenant_id")
);
CREATE INDEX "agency_client_relationships_client_status_idx" ON "agency_client_relationships"("client_tenant_id", "status");

INSERT INTO "roles" ("id", "name", "description", "created_at", "updated_at") VALUES
('10000000-0000-4000-8000-000000000001', 'Customer', 'Customer tenant member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000002', 'Agency', 'Approved agency member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000003', 'Affiliate', 'Approved affiliate member', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000004', 'Cybersecurity Specialist', 'Approved remediation specialist', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('10000000-0000-4000-8000-000000000005', 'Owner', 'Platform owner requiring MFA', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

INSERT INTO "permissions" ("id", "key", "description", "created_at") VALUES
('20000000-0000-4000-8000-000000000001', 'profile.read', 'Read own profile', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000002', 'profile.update', 'Update own profile', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000003', 'sessions.read', 'List own sessions', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000004', 'sessions.revoke', 'Revoke own sessions', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000005', 'tickets.create', 'Create tenant tickets', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000006', 'tickets.read', 'Read authorized tenant tickets', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000007', 'tickets.assign', 'Assign authorized tickets', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000008', 'tickets.remediate', 'Remediate authorized tickets', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000009', 'billing.read', 'Read authorized billing data', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-00000000000a', 'billing.manage', 'Manage platform billing', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-00000000000b', 'users.read', 'Read users in authorized scope', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-00000000000c', 'users.approve', 'Approve or reject accounts', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-00000000000d', 'users.suspend', 'Suspend or deactivate accounts', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-00000000000e', 'audit.read', 'Read audit records', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-00000000000f', 'ai.manage', 'Manage AI configuration', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000010', 'roles.manage', 'Manage RBAC assignments', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000011', 'tenants.manage', 'Manage tenants and agency grants', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000012', 'referrals.read', 'Read own affiliate referrals', CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000013', 'referrals.create', 'Create affiliate referrals', CURRENT_TIMESTAMP);

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r JOIN "permissions" p ON
  (r."name" = 'Customer' AND p."key" IN ('profile.read','profile.update','sessions.read','sessions.revoke','tickets.create','tickets.read','billing.read')) OR
  (r."name" = 'Agency' AND p."key" IN ('profile.read','profile.update','sessions.read','sessions.revoke','users.read','tickets.create','tickets.read','tickets.assign','billing.read')) OR
  (r."name" = 'Affiliate' AND p."key" IN ('profile.read','profile.update','sessions.read','sessions.revoke','referrals.read','referrals.create','billing.read')) OR
  (r."name" = 'Cybersecurity Specialist' AND p."key" IN ('profile.read','profile.update','sessions.read','sessions.revoke','tickets.read','tickets.assign','tickets.remediate')) OR
  (r."name" = 'Owner');
