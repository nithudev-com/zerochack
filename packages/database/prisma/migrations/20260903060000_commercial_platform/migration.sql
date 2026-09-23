ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'PAUSED';
CREATE TYPE "BillingInterval" AS ENUM ('MONTHLY','QUARTERLY','YEARLY');
CREATE TYPE "PaymentHealthStatus" AS ENUM ('UNKNOWN','HEALTHY','DEGRADED','UNAVAILABLE');
CREATE TYPE "PaymentTransactionStatus" AS ENUM ('PENDING','SUCCEEDED','FAILED','CANCELLED','REFUNDED','PARTIALLY_REFUNDED');
CREATE TYPE "RefundStatus" AS ENUM ('PENDING','SUCCEEDED','FAILED');
CREATE TYPE "PaymentEventStatus" AS ENUM ('RECEIVED','PROCESSED','IGNORED','FAILED');
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT','SENT','VIEWED','ACCEPTED','REJECTED','EXPIRED','CANCELLED');

CREATE TABLE "commercial_packages" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "key" VARCHAR(80) NOT NULL UNIQUE,
  "archived_at" TIMESTAMPTZ(6), "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "package_versions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "package_id" UUID NOT NULL, "version" INTEGER NOT NULL,
  "name" VARCHAR(120) NOT NULL, "description" TEXT NOT NULL, "price_minor" INTEGER NOT NULL, "currency" CHAR(3) NOT NULL,
  "billing_interval" "BillingInterval" NOT NULL, "trial_days" INTEGER NOT NULL DEFAULT 0, "website_limit" INTEGER NOT NULL,
  "scan_limit" INTEGER NOT NULL, "monitoring_interval_minutes" INTEGER NOT NULL, "backup_frequency_hours" INTEGER NOT NULL,
  "backup_retention_days" INTEGER NOT NULL, "warranty_days" INTEGER NOT NULL, "ai_request_limit" INTEGER NOT NULL,
  "ai_cost_limit_micros" INTEGER NOT NULL, "support_level" VARCHAR(80) NOT NULL, "feature_entitlements" JSONB NOT NULL,
  "published_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "package_versions_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "commercial_packages"("id") ON DELETE RESTRICT,
  CONSTRAINT "package_versions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "package_versions_nonnegative" CHECK ("price_minor">=0 AND "trial_days">=0 AND "website_limit">=0 AND "scan_limit">=0 AND "monitoring_interval_minutes">=1 AND "backup_frequency_hours">=1 AND "backup_retention_days">=0 AND "warranty_days">=0 AND "ai_request_limit">=0 AND "ai_cost_limit_micros">=0)
);
CREATE UNIQUE INDEX "package_versions_package_id_version_key" ON "package_versions"("package_id","version");
CREATE INDEX "package_versions_package_id_published_at_idx" ON "package_versions"("package_id","published_at");

CREATE TABLE "payment_provider_configs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "name" VARCHAR(120) NOT NULL, "adapter_key" VARCHAR(80) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false, "encrypted_credentials" TEXT, "health_status" "PaymentHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
  "last_health_check_at" TIMESTAMPTZ(6), "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "payment_provider_configs_enabled_health_status_idx" ON "payment_provider_configs"("enabled","health_status");

ALTER TABLE "subscriptions" ADD COLUMN "package_version_id" UUID, ADD COLUMN "provider_config_id" UUID,
  ADD COLUMN "price_minor" INTEGER, ADD COLUMN "currency" CHAR(3), ADD COLUMN "billing_interval" "BillingInterval",
  ADD COLUMN "terms_snapshot" JSONB, ADD COLUMN "trial_ends_at" TIMESTAMPTZ(6), ADD COLUMN "cancelled_at" TIMESTAMPTZ(6), ADD COLUMN "idempotency_key" UUID;
CREATE UNIQUE INDEX "subscriptions_idempotency_key_key" ON "subscriptions"("idempotency_key");
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_package_version_id_fkey" FOREIGN KEY ("package_version_id") REFERENCES "package_versions"("id") ON DELETE RESTRICT;
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_provider_config_id_fkey" FOREIGN KEY ("provider_config_id") REFERENCES "payment_provider_configs"("id") ON DELETE RESTRICT;

ALTER TABLE "invoices" ADD COLUMN "subscription_id" UUID, ADD COLUMN "package_version_id" UUID, ADD COLUMN "provider_config_id" UUID,
  ADD COLUMN "invoice_number" VARCHAR(80), ADD COLUMN "line_items" JSONB, ADD COLUMN "terms_snapshot" JSONB,
  ADD COLUMN "due_at" TIMESTAMPTZ(6), ADD COLUMN "paid_at" TIMESTAMPTZ(6), ADD COLUMN "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE UNIQUE INDEX "invoices_invoice_number_key" ON "invoices"("invoice_number");
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_package_version_id_fkey" FOREIGN KEY ("package_version_id") REFERENCES "package_versions"("id") ON DELETE RESTRICT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_provider_config_id_fkey" FOREIGN KEY ("provider_config_id") REFERENCES "payment_provider_configs"("id") ON DELETE RESTRICT;

CREATE TABLE "payment_transactions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" UUID NOT NULL, "subscription_id" UUID, "invoice_id" UUID,
  "provider_config_id" UUID NOT NULL, "package_version_id" UUID NOT NULL, "idempotency_key" UUID NOT NULL, "provider_payment_reference" VARCHAR(255),
  "checkout_reference" VARCHAR(255), "checkout_url" VARCHAR(2048), "amount_minor" INTEGER NOT NULL, "currency" CHAR(3) NOT NULL,
  "status" "PaymentTransactionStatus" NOT NULL DEFAULT 'PENDING', "failure_code" VARCHAR(120),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completed_at" TIMESTAMPTZ(6),
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("provider_config_id") REFERENCES "payment_provider_configs"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("package_version_id") REFERENCES "package_versions"("id") ON DELETE RESTRICT,
  CONSTRAINT "payment_transactions_amount_nonnegative" CHECK ("amount_minor">=0)
);
CREATE UNIQUE INDEX "payment_transactions_tenant_id_idempotency_key_key" ON "payment_transactions"("tenant_id","idempotency_key");
CREATE UNIQUE INDEX "payment_transactions_provider_payment_reference_key" ON "payment_transactions"("provider_payment_reference");
CREATE UNIQUE INDEX "payment_transactions_checkout_reference_key" ON "payment_transactions"("checkout_reference");
CREATE INDEX "payment_transactions_tenant_id_created_at_idx" ON "payment_transactions"("tenant_id","created_at");
CREATE INDEX "payment_transactions_status_created_at_idx" ON "payment_transactions"("status","created_at");

CREATE TABLE "payment_refunds" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "transaction_id" UUID NOT NULL, "idempotency_key" UUID NOT NULL UNIQUE,
  "provider_refund_reference" VARCHAR(255) UNIQUE, "amount_minor" INTEGER NOT NULL, "reason" VARCHAR(500),
  "status" "RefundStatus" NOT NULL DEFAULT 'PENDING', "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6), FOREIGN KEY ("transaction_id") REFERENCES "payment_transactions"("id") ON DELETE RESTRICT,
  CONSTRAINT "payment_refunds_amount_positive" CHECK ("amount_minor">0)
);
CREATE INDEX "payment_refunds_transaction_id_created_at_idx" ON "payment_refunds"("transaction_id","created_at");

CREATE TABLE "payment_webhook_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "provider_config_id" UUID NOT NULL, "provider_event_id" VARCHAR(255) NOT NULL,
  "event_type" VARCHAR(160) NOT NULL, "payload_hash" CHAR(64) NOT NULL, "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "status" "PaymentEventStatus" NOT NULL DEFAULT 'RECEIVED', "error_code" VARCHAR(120),
  "received_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "processed_at" TIMESTAMPTZ(6),
  FOREIGN KEY ("provider_config_id") REFERENCES "payment_provider_configs"("id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "payment_webhook_events_provider_config_id_provider_event_id_key" ON "payment_webhook_events"("provider_config_id","provider_event_id");
CREATE INDEX "payment_webhook_events_provider_config_id_received_at_idx" ON "payment_webhook_events"("provider_config_id","received_at");
CREATE INDEX "payment_webhook_events_status_received_at_idx" ON "payment_webhook_events"("status","received_at");

CREATE TABLE "quotes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "tenant_id" UUID NOT NULL, "package_version_id" UUID,
  "quote_number" VARCHAR(80) NOT NULL UNIQUE, "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT', "currency" CHAR(3) NOT NULL,
  "subtotal_minor" INTEGER NOT NULL, "discount_minor" INTEGER NOT NULL DEFAULT 0, "tax_minor" INTEGER NOT NULL DEFAULT 0,
  "total_minor" INTEGER NOT NULL, "terms_snapshot" JSONB NOT NULL, "valid_until" TIMESTAMPTZ(6) NOT NULL,
  "sent_at" TIMESTAMPTZ(6), "viewed_at" TIMESTAMPTZ(6), "accepted_at" TIMESTAMPTZ(6),
  "created_by_user_id" UUID NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("package_version_id") REFERENCES "package_versions"("id") ON DELETE RESTRICT,
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT,
  CONSTRAINT "quotes_amounts_valid" CHECK ("subtotal_minor">=0 AND "discount_minor">=0 AND "tax_minor">=0 AND "total_minor">=0)
);
CREATE INDEX "quotes_tenant_id_status_created_at_idx" ON "quotes"("tenant_id","status","created_at");
CREATE TABLE "quote_line_items" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "quote_id" UUID NOT NULL, "description" VARCHAR(500) NOT NULL,
  "quantity" INTEGER NOT NULL, "unit_minor" INTEGER NOT NULL, "total_minor" INTEGER NOT NULL, "sort_order" INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT,
  CONSTRAINT "quote_line_items_amounts_valid" CHECK ("quantity">0 AND "unit_minor">=0 AND "total_minor">=0)
);
CREATE INDEX "quote_line_items_quote_id_sort_order_idx" ON "quote_line_items"("quote_id","sort_order");

INSERT INTO "permissions" ("id","key","description","created_at") VALUES
('60000000-0000-4000-8000-000000000001','billing.checkout','Create and verify tenant checkouts',CURRENT_TIMESTAMP),
('60000000-0000-4000-8000-000000000002','billing.cancel','Cancel tenant subscriptions',CURRENT_TIMESTAMP),
('60000000-0000-4000-8000-000000000003','commercial.manage','Manage packages, providers, refunds, and quotes',CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
INSERT INTO "role_permissions" ("role_id","permission_id") SELECT r."id",p."id" FROM "roles" r CROSS JOIN "permissions" p WHERE
(r."name"='Customer' AND p."key" IN ('billing.checkout','billing.cancel')) OR
(r."name"='Owner' AND p."key" IN ('billing.checkout','billing.cancel','commercial.manage')) ON CONFLICT DO NOTHING;
