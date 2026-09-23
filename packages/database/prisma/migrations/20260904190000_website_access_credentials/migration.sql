CREATE TABLE "website_access_credentials" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "website_id" UUID NOT NULL,
  "host" VARCHAR(253) NOT NULL,
  "port" INTEGER NOT NULL DEFAULT 22,
  "username" VARCHAR(120) NOT NULL,
  "auth_method" VARCHAR(20) NOT NULL,
  "encrypted_secret" TEXT NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'CONFIGURED',
  "last_checked_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(120),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "website_access_credentials_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE,
  CONSTRAINT "website_access_credentials_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE,
  CONSTRAINT "website_access_credentials_port_check" CHECK ("port" BETWEEN 1 AND 65535),
  CONSTRAINT "website_access_credentials_auth_method_check" CHECK ("auth_method" IN ('PASSWORD', 'SSH_KEY'))
);
CREATE UNIQUE INDEX "website_access_credentials_website_id_key" ON "website_access_credentials"("website_id");
CREATE INDEX "website_access_credentials_tenant_id_status_idx" ON "website_access_credentials"("tenant_id", "status");
