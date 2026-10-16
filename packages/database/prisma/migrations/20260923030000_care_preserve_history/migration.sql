-- Care evidence belongs to the saved case. Closing a session or the passage of
-- time must not erase it. Already erased legacy artifacts cannot be restored.
ALTER TABLE care_artifacts ALTER COLUMN expires_at DROP NOT NULL;
UPDATE care_artifacts SET expires_at = NULL WHERE status = 'ACCEPTED';
CREATE INDEX care_jobs_history_idx ON care_jobs (tenant_id, website_id, environment, created_at DESC, id DESC);
CREATE INDEX chat_messages_history_idx ON chat_messages (tenant_id, website_id, environment, created_at DESC, id DESC);
