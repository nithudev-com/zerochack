-- Additive product bindings. Legacy runs stay non-mutating; no activation or data reset.
BEGIN;
ALTER TABLE security_repair_runs
 ADD COLUMN admission_artifact_id UUID,
 ADD COLUMN admission_digest CHAR(64),
 ADD COLUMN execution_profile VARCHAR(64),
 ADD CONSTRAINT security_repair_runs_admission_fkey FOREIGN KEY (tenant_id,website_id,admission_artifact_id)
 REFERENCES care_artifacts(tenant_id,website_id,id) ON DELETE NO ACTION ON UPDATE CASCADE,
 ADD CONSTRAINT security_repair_runs_admission_binding CHECK (
  (admission_artifact_id IS NULL AND admission_digest IS NULL AND execution_profile IS NULL) OR
  (environment='STAGING' AND admission_artifact_id IS NOT NULL AND admission_digest IS NOT NULL
   AND execution_profile IS NOT NULL AND admission_digest ~ '^[a-f0-9]{64}$'
   AND execution_profile='MANAGED_STATIC_PERMISSION_V1'));
CREATE INDEX security_repair_runs_admission_idx ON security_repair_runs(tenant_id,website_id,admission_artifact_id);
ALTER TABLE security_repair_attempts DROP CONSTRAINT security_repair_attempts_kind_check;
ALTER TABLE security_repair_attempts ADD CONSTRAINT security_repair_attempts_kind_check
 CHECK (kind IN ('READ','MODEL','SANDBOX','PRODUCTION_WRITE','RECOVERY_WRITE','STAGING_WRITE','STAGING_RECOVERY'));
ALTER TABLE security_repair_decisions DROP CONSTRAINT security_repair_decisions_kind_check;
ALTER TABLE security_repair_decisions ADD CONSTRAINT security_repair_decisions_kind_check
 CHECK (kind IN ('CANDIDATE','PRODUCTION'));
COMMIT;
