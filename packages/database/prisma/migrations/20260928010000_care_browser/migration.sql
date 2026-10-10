CREATE TABLE "care_browser_runs" (
 "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "website_id" UUID NOT NULL,
 "job_id" UUID NOT NULL, "actor_id" UUID NOT NULL, "request_key" UUID NOT NULL,
 "tool_id" VARCHAR(8) NOT NULL CHECK ("tool_id" IN ('T25','T26','T27','T28')),
 "input_digest" CHAR(64) NOT NULL, "source_binding" CHAR(64) NOT NULL,
 "state" VARCHAR(32) NOT NULL CHECK ("state" IN ('RUNNING','COMPLETED','FAILED','INTERRUPTED')),
 "error_code" VARCHAR(100), "result_artifact_id" UUID, "screenshot_artifact_id" UUID,
 "expires_at" TIMESTAMPTZ(6) NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "completed_at" TIMESTAMPTZ(6),
 CONSTRAINT "care_browser_job_scope_fkey" FOREIGN KEY ("tenant_id","website_id","job_id") REFERENCES "care_jobs"("tenant_id","website_id","id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "care_browser_artifact_scope_fkey" FOREIGN KEY ("tenant_id","website_id","result_artifact_id") REFERENCES "care_artifacts"("tenant_id","website_id","id") ON DELETE NO ACTION ON UPDATE CASCADE,
 CONSTRAINT "care_browser_screenshot_scope_fkey" FOREIGN KEY ("tenant_id","website_id","screenshot_artifact_id") REFERENCES "care_artifacts"("tenant_id","website_id","id") ON DELETE NO ACTION ON UPDATE CASCADE,
 CONSTRAINT "care_browser_screenshot_tool" CHECK ("screenshot_artifact_id" IS NULL OR "tool_id" = 'T27'),
 CONSTRAINT "care_browser_screenshot_required" CHECK ("state" <> 'COMPLETED' OR "tool_id" <> 'T27' OR "screenshot_artifact_id" IS NOT NULL),
 CONSTRAINT "care_browser_result_required" CHECK ("state" <> 'COMPLETED' OR ("result_artifact_id" IS NOT NULL AND "completed_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "care_browser_runs_job_id_request_key_key" ON "care_browser_runs"("job_id","request_key");
CREATE INDEX "care_browser_runs_tenant_id_website_id_state_idx" ON "care_browser_runs"("tenant_id","website_id","state");
CREATE UNIQUE INDEX "care_browsers_one_active_per_website" ON "care_browser_runs"("tenant_id","website_id") WHERE "state" = 'RUNNING';
CREATE INDEX "care_browser_history_idx" ON "care_browser_runs"("tenant_id","website_id","job_id","created_at" DESC,"id" DESC);
