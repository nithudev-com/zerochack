-- Self-serve, approval-only reversible fixes applied by the customer-facing
-- agent. One row per applied (or rolled-back) safe fix, with the undo token
-- captured at apply time so every change can be reverted.
CREATE TABLE "security_fix_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "website_id" UUID NOT NULL,
    "finding_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action_key" VARCHAR(64) NOT NULL,
    "target_path" VARCHAR(2048) NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "undo_token" VARCHAR(2048) NOT NULL DEFAULT '',
    "detail" VARCHAR(500),
    "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rolled_back_at" TIMESTAMPTZ(6),

    CONSTRAINT "security_fix_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "security_fix_runs_tenant_id_website_id_finding_id_idx" ON "security_fix_runs"("tenant_id", "website_id", "finding_id");

ALTER TABLE "security_fix_runs" ADD CONSTRAINT "security_fix_runs_website_id_fkey" FOREIGN KEY ("website_id") REFERENCES "websites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "security_fix_runs" ADD CONSTRAINT "security_fix_runs_finding_id_fkey" FOREIGN KEY ("finding_id") REFERENCES "security_findings"("id") ON DELETE CASCADE ON UPDATE CASCADE;
