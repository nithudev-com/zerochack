CREATE TYPE "AiHealthStatus" AS ENUM ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'UNAVAILABLE');
CREATE TYPE "AiUsageStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REJECTED');

CREATE TABLE "ai_providers" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "name" VARCHAR(120) NOT NULL, "adapter_key" VARCHAR(80) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false, "health_status" "AiHealthStatus" NOT NULL DEFAULT 'UNKNOWN',
  "requests_per_minute" INTEGER NOT NULL DEFAULT 60, "max_concurrent" INTEGER NOT NULL DEFAULT 4,
  "last_health_check_at" TIMESTAMPTZ(6), "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ai_providers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ai_providers_name_key" ON "ai_providers"("name");

CREATE TABLE "ai_credentials" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "provider_id" UUID NOT NULL, "label" VARCHAR(120) NOT NULL,
  "encrypted_secret" TEXT NOT NULL, "key_version" INTEGER NOT NULL DEFAULT 1, "enabled" BOOLEAN NOT NULL DEFAULT true,
  "health_status" "AiHealthStatus" NOT NULL DEFAULT 'UNKNOWN', "last_used_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_credentials_pkey" PRIMARY KEY ("id"), CONSTRAINT "ai_credentials_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ai_credentials_provider_id_label_key" ON "ai_credentials"("provider_id", "label");
CREATE UNIQUE INDEX "ai_credentials_provider_id_id_key" ON "ai_credentials"("provider_id", "id");
CREATE INDEX "ai_credentials_provider_id_enabled_health_status_idx" ON "ai_credentials"("provider_id", "enabled", "health_status");

CREATE TABLE "ai_models" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "provider_id" UUID NOT NULL, "name" VARCHAR(120) NOT NULL,
  "provider_model" VARCHAR(160) NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true, "max_output_tokens" INTEGER NOT NULL DEFAULT 1200,
  "requests_per_minute" INTEGER NOT NULL DEFAULT 30, "max_concurrent" INTEGER NOT NULL DEFAULT 2,
  "input_cost_micros_per_m" INTEGER NOT NULL DEFAULT 0, "output_cost_micros_per_m" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ai_models_pkey" PRIMARY KEY ("id"), CONSTRAINT "ai_models_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ai_models_provider_id_name_key" ON "ai_models"("provider_id", "name");
CREATE UNIQUE INDEX "ai_models_provider_id_id_key" ON "ai_models"("provider_id", "id");
CREATE INDEX "ai_models_provider_id_enabled_idx" ON "ai_models"("provider_id", "enabled");

CREATE TABLE "ai_tenant_policies" (
  "tenant_id" UUID NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false, "requests_per_minute" INTEGER NOT NULL DEFAULT 30,
  "requests_per_user_minute" INTEGER NOT NULL DEFAULT 10, "max_concurrent" INTEGER NOT NULL DEFAULT 2,
  "daily_cost_limit_micros" INTEGER NOT NULL DEFAULT 0, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, CONSTRAINT "ai_tenant_policies_pkey" PRIMARY KEY ("tenant_id"),
  CONSTRAINT "ai_tenant_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ai_usage" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "tenant_id" UUID NOT NULL, "user_id" UUID NOT NULL, "provider_id" UUID NOT NULL,
  "credential_id" UUID NOT NULL, "model_id" UUID NOT NULL, "response_message_id" UUID, "request_id" VARCHAR(100) NOT NULL,
  "idempotency_key" UUID NOT NULL, "prompt_hash" CHAR(64) NOT NULL, "status" "AiUsageStatus" NOT NULL DEFAULT 'PENDING',
  "input_tokens" INTEGER, "output_tokens" INTEGER, "latency_ms" INTEGER, "estimated_cost_micros" INTEGER,
  "provider_request_id" VARCHAR(160), "response_text" TEXT, "error_code" VARCHAR(120), "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6), CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ai_usage_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_usage_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_usage_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "ai_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_usage_credential_id_fkey" FOREIGN KEY ("credential_id") REFERENCES "ai_credentials"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_usage_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "ai_models"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "ai_usage_response_message_id_fkey" FOREIGN KEY ("response_message_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "ai_usage_response_message_id_key" ON "ai_usage"("response_message_id");
CREATE UNIQUE INDEX "ai_usage_tenant_id_user_id_idempotency_key_key" ON "ai_usage"("tenant_id", "user_id", "idempotency_key");
CREATE INDEX "ai_usage_tenant_id_created_at_idx" ON "ai_usage"("tenant_id", "created_at");
CREATE INDEX "ai_usage_provider_id_model_id_created_at_idx" ON "ai_usage"("provider_id", "model_id", "created_at");
CREATE INDEX "ai_usage_request_id_idx" ON "ai_usage"("request_id");
CREATE UNIQUE INDEX "chat_messages_tenant_id_id_key" ON "chat_messages"("tenant_id", "id");
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_tenant_user_membership_fkey" FOREIGN KEY ("tenant_id", "user_id") REFERENCES "tenant_memberships"("tenant_id", "user_id") ON DELETE RESTRICT;
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_provider_credential_fkey" FOREIGN KEY ("provider_id", "credential_id") REFERENCES "ai_credentials"("provider_id", "id") ON DELETE RESTRICT;
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_provider_model_fkey" FOREIGN KEY ("provider_id", "model_id") REFERENCES "ai_models"("provider_id", "id") ON DELETE RESTRICT;
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_tenant_message_fkey" FOREIGN KEY ("tenant_id", "response_message_id") REFERENCES "chat_messages"("tenant_id", "id") ON DELETE RESTRICT;

INSERT INTO "permissions" ("id", "key", "description", "created_at") VALUES
('40000000-0000-4000-8000-000000000001', 'ai.use', 'Use authorized AI capabilities', CURRENT_TIMESTAMP),
('40000000-0000-4000-8000-000000000002', 'ai.security_context', 'Use authorized tenant security context with AI', CURRENT_TIMESTAMP),
('40000000-0000-4000-8000-000000000003', 'ai.providers.manage', 'Manage AI providers, credentials, models, and tenant policies', CURRENT_TIMESTAMP),
('40000000-0000-4000-8000-000000000004', 'ai.usage.read', 'Read AI usage and cost records', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id" FROM "roles" r CROSS JOIN "permissions" p
WHERE (r."name" IN ('Customer', 'Agency', 'Cybersecurity Specialist') AND p."key" IN ('ai.use', 'ai.security_context'))
   OR (r."name" = 'Affiliate' AND p."key" = 'ai.use')
   OR (r."name" = 'Owner' AND p."key" IN ('ai.use', 'ai.security_context', 'ai.providers.manage', 'ai.usage.read'))
ON CONFLICT DO NOTHING;
