CREATE TYPE "IntegrationType" AS ENUM ('EMAIL','STORAGE','SECURITY_ENGINE','WEBSOCKET');
CREATE TYPE "IntegrationHealthStatus" AS ENUM ('NOT_CONFIGURED','HEALTHY','DEGRADED','FAILED','UNKNOWN');

CREATE TABLE "platform_integrations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "type" "IntegrationType" NOT NULL, "name" VARCHAR(120) NOT NULL,
  "adapter_key" VARCHAR(100) NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT false, "encrypted_credentials" TEXT,
  "configuration" JSONB NOT NULL DEFAULT '{}', "health_status" "IntegrationHealthStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
  "last_health_check_at" TIMESTAMPTZ(6), "changed_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "platform_integrations_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "system_settings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "key" VARCHAR(120) NOT NULL, "value" JSONB NOT NULL,
  "description" VARCHAR(500) NOT NULL, "security_invariant" BOOLEAN NOT NULL DEFAULT false, "changed_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "platform_integrations_type_name_key" ON "platform_integrations"("type","name");
CREATE INDEX "platform_integrations_type_enabled_health_status_idx" ON "platform_integrations"("type","enabled","health_status");
CREATE UNIQUE INDEX "system_settings_key_key" ON "system_settings"("key");
ALTER TABLE "platform_integrations" ADD CONSTRAINT "platform_integrations_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_changed_by_user_id_fkey" FOREIGN KEY ("changed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "permissions"("id","key","description","created_at") VALUES
('20000000-0000-4000-8000-000000000071','system.health.read','Read platform dependency health',CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000072','integrations.manage','Manage encrypted platform integrations',CURRENT_TIMESTAMP),
('20000000-0000-4000-8000-000000000073','settings.manage','Manage permitted platform settings',CURRENT_TIMESTAMP)
ON CONFLICT("key") DO NOTHING;
INSERT INTO "role_permissions"("role_id","permission_id") SELECT r."id",p."id" FROM "roles" r CROSS JOIN "permissions" p WHERE r."name"='Owner' AND p."key" IN ('system.health.read','integrations.manage','settings.manage') ON CONFLICT DO NOTHING;
