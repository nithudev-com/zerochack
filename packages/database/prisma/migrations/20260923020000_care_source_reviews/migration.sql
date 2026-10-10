ALTER TABLE care_agent_runs
  ADD COLUMN result_artifact_id uuid,
  ADD COLUMN usage_id uuid,
  ADD COLUMN error_code varchar(100),
  ADD COLUMN step_index integer,
  ADD COLUMN depends_on text[] NOT NULL DEFAULT '{}';
CREATE UNIQUE INDEX care_agent_runs_job_id_step_index_key ON care_agent_runs(job_id, step_index);
ALTER TABLE care_agent_runs ADD CONSTRAINT care_agent_result_scope_fk
  FOREIGN KEY (tenant_id, website_id, result_artifact_id)
  REFERENCES care_artifacts(tenant_id, website_id, id);
CREATE INDEX care_jobs_review_queue_idx ON care_jobs(kind, state, updated_at);
