-- Additive, dormant P1 infrastructure. No provider, executor, queue or flag is enabled.
BEGIN;
CREATE TABLE security_repair_runs (
 id UUID PRIMARY KEY, tenant_id UUID NOT NULL, website_id UUID NOT NULL,
 environment VARCHAR(16) NOT NULL CHECK (environment IN ('STAGING','PRODUCTION')),
 request_key UUID NOT NULL, actor_id UUID NOT NULL, session_id UUID NOT NULL,
 input_digest CHAR(64) NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
 authority_digest CHAR(64) NOT NULL CHECK (authority_digest ~ '^[a-f0-9]{64}$'),
 policy_version VARCHAR(64) NOT NULL DEFAULT 'security-workflow-v1',
 phase VARCHAR(32) NOT NULL DEFAULT 'PLANNING' CHECK (phase IN ('PLANNING','WAITING_FOR_INPUT','AWAITING_APPROVAL','SNAPSHOTTING','CANDIDATE_WORK','VERIFYING','READY_FOR_RELEASE','APPLYING','POST_VERIFYING','COMPLETED','FAILED','CANCELLED','STALE','OUTCOME_UNKNOWN')),
 error_code VARCHAR(80) CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
 allowance_micros INTEGER NOT NULL CHECK (allowance_micros BETWEEN 0 AND 100000000),
 reserved_micros INTEGER NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
 charged_micros INTEGER NOT NULL DEFAULT 0 CHECK (charged_micros >= 0),
 expires_at TIMESTAMPTZ(6) NOT NULL,
 lease_owner_id UUID, lease_version INTEGER NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
 lease_expires_at TIMESTAMPTZ(6), event_version INTEGER NOT NULL DEFAULT 0 CHECK (event_version >= 0),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at TIMESTAMPTZ(6) NOT NULL,
 CONSTRAINT security_repair_runs_budget CHECK (reserved_micros::bigint + charged_micros::bigint <= allowance_micros OR
   (phase = 'FAILED' AND error_code = 'SECURITY_BUDGET_EXCEEDED' AND reserved_micros = 0)),
 CONSTRAINT security_repair_runs_lease CHECK ((lease_owner_id IS NULL) = (lease_expires_at IS NULL)),
 CONSTRAINT security_repair_runs_website_fkey FOREIGN KEY (tenant_id,website_id) REFERENCES websites(tenant_id,id) ON DELETE NO ACTION ON UPDATE CASCADE,
 CONSTRAINT security_repair_runs_scope_key UNIQUE (tenant_id,website_id,environment,id),
 CONSTRAINT security_repair_runs_request_key UNIQUE (tenant_id,website_id,environment,request_key)
);
-- Unknown/stale work retains the website slot, including across environments.
CREATE UNIQUE INDEX security_repair_runs_one_unresolved_site ON security_repair_runs(tenant_id,website_id)
 WHERE phase NOT IN ('COMPLETED','FAILED','CANCELLED');
CREATE INDEX security_repair_runs_history_idx ON security_repair_runs(tenant_id,website_id,created_at DESC,id DESC);
CREATE INDEX security_repair_runs_lease_idx ON security_repair_runs(phase,lease_expires_at);

CREATE TABLE security_repair_attempts (
 id UUID PRIMARY KEY, tenant_id UUID NOT NULL, website_id UUID NOT NULL,
 environment VARCHAR(16) NOT NULL, run_id UUID NOT NULL,
 step_key VARCHAR(96) NOT NULL CHECK (step_key ~ '^[a-z][a-z0-9_.:-]{0,95}$'),
 kind VARCHAR(20) NOT NULL CHECK (kind IN ('READ','MODEL','SANDBOX','PRODUCTION_WRITE','RECOVERY_WRITE')),
 input_digest CHAR(64) NOT NULL CHECK (input_digest ~ '^[a-f0-9]{64}$'),
 attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number BETWEEN 1 AND 3),
 state VARCHAR(24) NOT NULL DEFAULT 'STARTED' CHECK (state IN ('STARTED','SUCCEEDED','OUTCOME_UNKNOWN')),
 lease_version INTEGER NOT NULL CHECK (lease_version > 0),
 reserve_micros INTEGER NOT NULL CHECK (reserve_micros BETWEEN 0 AND 100000000),
 cost_micros INTEGER CHECK (cost_micros BETWEEN 0 AND 100000000),
 artifact_id UUID, artifact_digest CHAR(64) CHECK (artifact_digest IS NULL OR artifact_digest ~ '^[a-f0-9]{64}$'),
 error_code VARCHAR(80) CHECK (error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
 started_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, completed_at TIMESTAMPTZ(6),
 CONSTRAINT security_repair_attempts_completion CHECK (
   (state = 'SUCCEEDED' AND artifact_id IS NOT NULL AND artifact_digest IS NOT NULL AND cost_micros IS NOT NULL AND completed_at IS NOT NULL) OR
   (state = 'STARTED' AND artifact_id IS NULL AND artifact_digest IS NULL AND cost_micros IS NULL AND completed_at IS NULL) OR
   (state = 'OUTCOME_UNKNOWN' AND artifact_id IS NULL AND artifact_digest IS NULL AND cost_micros IS NULL AND completed_at IS NOT NULL)),
 CONSTRAINT security_repair_attempts_run_fkey FOREIGN KEY (tenant_id,website_id,environment,run_id) REFERENCES security_repair_runs(tenant_id,website_id,environment,id) ON DELETE NO ACTION ON UPDATE CASCADE,
 CONSTRAINT security_repair_attempts_artifact_fkey FOREIGN KEY (tenant_id,website_id,artifact_id) REFERENCES care_artifacts(tenant_id,website_id,id) ON DELETE NO ACTION ON UPDATE CASCADE,
 CONSTRAINT security_repair_attempts_scope_key UNIQUE (tenant_id,website_id,environment,run_id,id),
 CONSTRAINT security_repair_attempts_step_key UNIQUE (run_id,step_key,attempt_number)
);
CREATE INDEX security_repair_attempts_run_idx ON security_repair_attempts(tenant_id,website_id,environment,run_id,state);
CREATE INDEX security_repair_attempts_artifact_idx ON security_repair_attempts(tenant_id,website_id,artifact_id);

CREATE TABLE security_repair_cost_entries (
 id UUID PRIMARY KEY, tenant_id UUID NOT NULL, website_id UUID NOT NULL,
 environment VARCHAR(16) NOT NULL, run_id UUID NOT NULL, attempt_id UUID NOT NULL,
 kind VARCHAR(16) NOT NULL CHECK (kind IN ('RESERVE','SETTLE','UNKNOWN')),
 reserved_delta_micros INTEGER NOT NULL, charged_delta_micros INTEGER NOT NULL,
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT security_repair_cost_entries_delta CHECK (
   (kind = 'RESERVE' AND reserved_delta_micros BETWEEN 0 AND 100000000 AND charged_delta_micros = 0) OR
   (kind = 'SETTLE' AND reserved_delta_micros BETWEEN -100000000 AND 0 AND charged_delta_micros BETWEEN 0 AND 100000000) OR
   (kind = 'UNKNOWN' AND reserved_delta_micros = 0 AND charged_delta_micros = 0)),
 CONSTRAINT security_repair_cost_entries_run_fkey FOREIGN KEY (tenant_id,website_id,environment,run_id) REFERENCES security_repair_runs(tenant_id,website_id,environment,id) ON DELETE NO ACTION ON UPDATE CASCADE,
 CONSTRAINT security_repair_cost_entries_attempt_fkey FOREIGN KEY (tenant_id,website_id,environment,run_id,attempt_id) REFERENCES security_repair_attempts(tenant_id,website_id,environment,run_id,id) ON DELETE NO ACTION ON UPDATE CASCADE,
 CONSTRAINT security_repair_cost_entries_once_key UNIQUE (attempt_id,kind)
);
CREATE INDEX security_repair_cost_entries_run_idx ON security_repair_cost_entries(tenant_id,website_id,environment,run_id);

CREATE TABLE security_repair_decisions (
 id UUID PRIMARY KEY, tenant_id UUID NOT NULL, website_id UUID NOT NULL,
 environment VARCHAR(16) NOT NULL, run_id UUID NOT NULL, request_key UUID NOT NULL,
 kind VARCHAR(16) NOT NULL DEFAULT 'CANDIDATE' CHECK (kind = 'CANDIDATE'),
 artifact_id UUID NOT NULL, digest CHAR(64) NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
 actor_id UUID NOT NULL, session_id UUID NOT NULL,
 status VARCHAR(16) NOT NULL CHECK (status IN ('APPROVED','DENIED')),
 expires_at TIMESTAMPTZ(6) NOT NULL, created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT security_repair_decisions_expiry CHECK (expires_at > created_at),
 CONSTRAINT security_repair_decisions_run_fkey FOREIGN KEY (tenant_id,website_id,environment,run_id) REFERENCES security_repair_runs(tenant_id,website_id,environment,id) ON DELETE NO ACTION ON UPDATE CASCADE,
 CONSTRAINT security_repair_decisions_artifact_fkey FOREIGN KEY (tenant_id,website_id,artifact_id) REFERENCES care_artifacts(tenant_id,website_id,id) ON DELETE NO ACTION ON UPDATE CASCADE,
 CONSTRAINT security_repair_decisions_request_key UNIQUE (tenant_id,website_id,environment,run_id,request_key),
 CONSTRAINT security_repair_decisions_first_key UNIQUE (run_id,kind,artifact_id)
);
CREATE INDEX security_repair_decisions_artifact_idx ON security_repair_decisions(tenant_id,website_id,artifact_id);

CREATE TABLE security_repair_outbox (
 id UUID PRIMARY KEY, tenant_id UUID NOT NULL, website_id UUID NOT NULL,
 environment VARCHAR(16) NOT NULL, run_id UUID NOT NULL,
 event_key VARCHAR(96) NOT NULL, event_type VARCHAR(64) NOT NULL,
 phase VARCHAR(32) NOT NULL, error_code VARCHAR(80),
 dispatch_version INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_version >= 0),
 dispatch_owner_id UUID, dispatch_expires_at TIMESTAMPTZ(6),
 dispatch_attempts INTEGER NOT NULL DEFAULT 0 CHECK (dispatch_attempts >= 0), published_at TIMESTAMPTZ(6),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT security_repair_outbox_lease CHECK ((dispatch_owner_id IS NULL) = (dispatch_expires_at IS NULL)),
 CONSTRAINT security_repair_outbox_run_fkey FOREIGN KEY (tenant_id,website_id,environment,run_id) REFERENCES security_repair_runs(tenant_id,website_id,environment,id) ON DELETE NO ACTION ON UPDATE CASCADE,
 CONSTRAINT security_repair_outbox_event_key UNIQUE (run_id,event_key)
);
CREATE INDEX security_repair_outbox_run_idx ON security_repair_outbox(tenant_id,website_id,environment,run_id);
CREATE INDEX security_repair_outbox_dispatch_idx ON security_repair_outbox(published_at,dispatch_expires_at,created_at);

CREATE TABLE security_graph_checkpoints (
 id UUID NOT NULL, tenant_id UUID NOT NULL, website_id UUID NOT NULL,
 environment VARCHAR(16) NOT NULL, run_id UUID NOT NULL,
 checkpoint_ns VARCHAR(96) NOT NULL, parent_id UUID,
 encrypted_envelope TEXT NOT NULL CHECK (octet_length(encrypted_envelope) BETWEEN 1 AND 1048576),
 digest CHAR(64) NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY (run_id,checkpoint_ns,id),
 CONSTRAINT security_graph_checkpoints_scope_key UNIQUE (tenant_id,website_id,environment,run_id,checkpoint_ns,id),
 CONSTRAINT security_graph_checkpoints_run_fkey FOREIGN KEY (tenant_id,website_id,environment,run_id) REFERENCES security_repair_runs(tenant_id,website_id,environment,id) ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX security_graph_checkpoints_run_idx ON security_graph_checkpoints(tenant_id,website_id,environment,run_id,created_at DESC);
CREATE TABLE security_graph_writes (
 id UUID PRIMARY KEY, tenant_id UUID NOT NULL, website_id UUID NOT NULL,
 environment VARCHAR(16) NOT NULL, run_id UUID NOT NULL,
 checkpoint_ns VARCHAR(96) NOT NULL, checkpoint_id UUID NOT NULL, task_id UUID NOT NULL,
 idx INTEGER NOT NULL CHECK (idx BETWEEN -16 AND 1024), task_path VARCHAR(512) NOT NULL,
 encrypted_envelope TEXT NOT NULL CHECK (octet_length(encrypted_envelope) BETWEEN 1 AND 1048576),
 digest CHAR(64) NOT NULL CHECK (digest ~ '^[a-f0-9]{64}$'),
 created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT security_graph_writes_once_key UNIQUE (run_id,checkpoint_ns,checkpoint_id,task_id,idx),
 CONSTRAINT security_graph_writes_run_fkey FOREIGN KEY (tenant_id,website_id,environment,run_id) REFERENCES security_repair_runs(tenant_id,website_id,environment,id) ON DELETE NO ACTION ON UPDATE CASCADE
);
CREATE INDEX security_graph_writes_checkpoint_idx ON security_graph_writes(tenant_id,website_id,environment,run_id,checkpoint_ns,checkpoint_id);
COMMIT;
