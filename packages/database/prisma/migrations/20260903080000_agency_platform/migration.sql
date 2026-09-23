CREATE TYPE "AgencyClientPermission" AS ENUM ('CLIENT_READ','WEBSITES_READ','SECURITY_READ','TICKETS_READ','SUBSCRIPTIONS_READ','BILLING_READ','QUOTES_READ','QUOTES_MANAGE');

ALTER TABLE "agency_client_relationships"
  ADD COLUMN "permissions" "AgencyClientPermission"[] NOT NULL DEFAULT ARRAY[]::"AgencyClientPermission"[],
  ADD COLUMN "activated_at" TIMESTAMPTZ(6),
  ADD COLUMN "revoked_at" TIMESTAMPTZ(6);

UPDATE "agency_client_relationships"
SET "permissions" = ARRAY['CLIENT_READ','WEBSITES_READ','SECURITY_READ','TICKETS_READ','SUBSCRIPTIONS_READ','BILLING_READ','QUOTES_READ']::"AgencyClientPermission"[],
    "activated_at" = COALESCE("activated_at", "updated_at")
WHERE "status" = 'ACTIVE';

ALTER TABLE "quotes"
  ADD COLUMN "agency_tenant_id" UUID,
  ADD COLUMN "relationship_id" UUID;

CREATE TABLE "agency_commerce_policies" (
  "id" UUID NOT NULL,
  "agency_tenant_id" UUID NOT NULL,
  "markup_basis_points" INTEGER NOT NULL DEFAULT 0,
  "max_discount_basis_points" INTEGER NOT NULL DEFAULT 0,
  "revenue_share_basis_points" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "agency_commerce_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agency_commerce_policy_rates_check" CHECK ("markup_basis_points" BETWEEN 0 AND 10000 AND "max_discount_basis_points" BETWEEN 0 AND 10000 AND "revenue_share_basis_points" BETWEEN 0 AND 10000)
);

CREATE TABLE "agency_package_entitlements" (
  "id" UUID NOT NULL,
  "agency_tenant_id" UUID NOT NULL,
  "package_version_id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "agency_package_entitlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agency_commerce_policies_agency_tenant_id_key" ON "agency_commerce_policies"("agency_tenant_id");
CREATE UNIQUE INDEX "agency_package_entitlements_agency_tenant_id_package_version_id_key" ON "agency_package_entitlements"("agency_tenant_id", "package_version_id");
CREATE INDEX "agency_package_entitlements_package_version_id_enabled_idx" ON "agency_package_entitlements"("package_version_id", "enabled");
CREATE INDEX "quotes_agency_tenant_id_status_created_at_idx" ON "quotes"("agency_tenant_id", "status", "created_at");

ALTER TABLE "agency_commerce_policies" ADD CONSTRAINT "agency_commerce_policies_agency_tenant_id_fkey" FOREIGN KEY ("agency_tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agency_package_entitlements" ADD CONSTRAINT "agency_package_entitlements_agency_tenant_id_fkey" FOREIGN KEY ("agency_tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agency_package_entitlements" ADD CONSTRAINT "agency_package_entitlements_package_version_id_fkey" FOREIGN KEY ("package_version_id") REFERENCES "package_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_agency_tenant_id_fkey" FOREIGN KEY ("agency_tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_relationship_id_fkey" FOREIGN KEY ("relationship_id") REFERENCES "agency_client_relationships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "permissions" ("id","key","description","created_at") VALUES
('20000000-0000-4000-8000-000000000051','agency.clients.read','Read explicitly authorized agency clients',CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000052','agency.websites.read','Read websites for explicitly authorized clients',CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000053','agency.security.read','Read permitted client security summaries',CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000054','agency.commerce.read','Read permitted client commercial information',CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000055','agency.quotes.manage','Create and manage permitted client quotes',CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id","permission_id")
SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p
WHERE r."name" = 'Agency' AND p."key" IN ('agency.clients.read','agency.websites.read','agency.security.read','agency.commerce.read','agency.quotes.manage')
ON CONFLICT DO NOTHING;
