CREATE TABLE "website_connectors" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "website_id" UUID NOT NULL,
  "provider" VARCHAR(24) NOT NULL,
  "endpoint" VARCHAR(2048) NOT NULL,
  "website_url" VARCHAR(2048) NOT NULL,
  "encrypted_secret" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" VARCHAR(32) NOT NULL DEFAULT 'CONFIGURED',
  "authorized_by" UUID NOT NULL,
  "authorization_expires_at" TIMESTAMPTZ(6) NOT NULL,
  "last_checked_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(64),
  "check_started_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "website_connectors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "website_connectors_website_fkey" FOREIGN KEY ("tenant_id", "website_id") REFERENCES "websites"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "website_connectors_provider_check" CHECK ("provider" IN ('wordpress','woocommerce','ghost','directus'))
);
CREATE UNIQUE INDEX "website_connectors_tenant_id_website_id_provider_key" ON "website_connectors"("tenant_id", "website_id", "provider");
