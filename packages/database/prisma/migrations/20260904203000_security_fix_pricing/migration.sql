CREATE TYPE "SecurityFixScope" AS ENUM ('ISSUE', 'TASK', 'PROJECT');
CREATE TYPE "SecurityFixOrderStatus" AS ENUM ('CHECKOUT_PENDING', 'PAID', 'QUEUED', 'IN_PROGRESS', 'COMPLETED', 'FAILED', 'CANCELLED');

CREATE TABLE "security_fix_prices" (
  "id" UUID NOT NULL,
  "key" VARCHAR(80) NOT NULL,
  "name" VARCHAR(120) NOT NULL,
  "description" TEXT NOT NULL,
  "scope" "SecurityFixScope" NOT NULL,
  "severity" "FindingSeverity",
  "owasp_category" VARCHAR(64),
  "cwe" VARCHAR(32),
  "match_terms" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "included_work" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "price_minor" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "estimated_hours" INTEGER,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "archived_at" TIMESTAMPTZ(6),
  "created_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "security_fix_prices_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "security_fix_prices_price_minor_check" CHECK ("price_minor" >= 0),
  CONSTRAINT "security_fix_prices_estimated_hours_check" CHECK ("estimated_hours" IS NULL OR "estimated_hours" > 0)
);

CREATE TABLE "security_fix_orders" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "website_id" UUID NOT NULL,
  "finding_id" UUID,
  "price_id" UUID NOT NULL,
  "provider_config_id" UUID NOT NULL,
  "ticket_id" UUID,
  "idempotency_key" UUID NOT NULL,
  "scope" "SecurityFixScope" NOT NULL,
  "title" VARCHAR(240) NOT NULL,
  "description" TEXT NOT NULL,
  "included_work" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "finding_snapshot" JSONB,
  "match_reason" VARCHAR(500) NOT NULL,
  "amount_minor" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "status" "SecurityFixOrderStatus" NOT NULL DEFAULT 'CHECKOUT_PENDING',
  "provider_payment_reference" VARCHAR(255),
  "checkout_reference" VARCHAR(255),
  "checkout_url" VARCHAR(2048),
  "invoice_id" UUID,
  "failure_code" VARCHAR(120),
  "paid_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "security_fix_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "security_fix_orders_amount_minor_check" CHECK ("amount_minor" >= 0)
);

CREATE UNIQUE INDEX "security_fix_prices_key_key" ON "security_fix_prices"("key");
CREATE INDEX "security_fix_prices_active_scope_priority_idx" ON "security_fix_prices"("active", "scope", "priority");
CREATE UNIQUE INDEX "security_fix_orders_ticket_id_key" ON "security_fix_orders"("ticket_id");
CREATE UNIQUE INDEX "security_fix_orders_provider_payment_reference_key" ON "security_fix_orders"("provider_payment_reference");
CREATE UNIQUE INDEX "security_fix_orders_checkout_reference_key" ON "security_fix_orders"("checkout_reference");
CREATE UNIQUE INDEX "security_fix_orders_invoice_id_key" ON "security_fix_orders"("invoice_id");
CREATE UNIQUE INDEX "security_fix_orders_tenant_id_idempotency_key_key" ON "security_fix_orders"("tenant_id", "idempotency_key");
CREATE INDEX "security_fix_orders_tenant_id_website_id_status_idx" ON "security_fix_orders"("tenant_id", "website_id", "status");
CREATE INDEX "security_fix_orders_finding_id_status_idx" ON "security_fix_orders"("finding_id", "status");

ALTER TABLE "security_fix_prices" ADD CONSTRAINT "security_fix_prices_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "security_fix_orders" ADD CONSTRAINT "security_fix_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "security_fix_orders" ADD CONSTRAINT "security_fix_orders_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "security_fix_orders" ADD CONSTRAINT "security_fix_orders_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "security_findings"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "security_fix_orders" ADD CONSTRAINT "security_fix_orders_price_id_fkey" FOREIGN KEY ("price_id") REFERENCES "security_fix_prices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "security_fix_orders" ADD CONSTRAINT "security_fix_orders_provider_config_id_fkey" FOREIGN KEY ("provider_config_id") REFERENCES "payment_provider_configs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "security_fix_orders" ADD CONSTRAINT "security_fix_orders_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "tickets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "security_fix_orders" ADD CONSTRAINT "security_fix_orders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
