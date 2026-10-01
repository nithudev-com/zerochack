CREATE TABLE "care_tool_observations" (
 "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL,
 "job_id" UUID NOT NULL, "actor_id" UUID NOT NULL, "request_key" UUID NOT NULL,
 "tool_id" VARCHAR(8) NOT NULL CHECK ("tool_id" IN ('T20','T23','T24')),
 "input_digest" CHAR(64) NOT NULL, "target_binding" CHAR(64) NOT NULL,
 "state" VARCHAR(32) NOT NULL CHECK ("state" IN ('RUNNING','COMPLETED','FAILED','INTERRUPTED')),
 "error_code" VARCHAR(100), "result_artifact_id" UUID,
 "expires_at" TIMESTAMPTZ(6) NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "completed_at" TIMESTAMPTZ(6),
 CONSTRAINT "care_observation_job_scope_fkey" FOREIGN KEY ("tenant_id","website_id","job_id") REFERENCES "care_jobs"("tenant_id","website_id","id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "care_observation_artifact_scope_fkey" FOREIGN KEY ("tenant_id","website_id","result_artifact_id") REFERENCES "care_artifacts"("tenant_id","website_id","id") ON DELETE NO ACTION ON UPDATE CASCADE,
 CONSTRAINT "care_observation_result_required" CHECK ("state" <> 'COMPLETED' OR ("result_artifact_id" IS NOT NULL AND "completed_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "care_tool_observations_job_id_request_key_key" ON "care_tool_observations"("job_id","request_key");
CREATE INDEX "care_tool_observations_tenant_id_website_id_state_idx" ON "care_tool_observations"("tenant_id","website_id","state");
CREATE UNIQUE INDEX "care_observations_one_active_per_website" ON "care_tool_observations"("tenant_id","website_id") WHERE "state" = 'RUNNING';
