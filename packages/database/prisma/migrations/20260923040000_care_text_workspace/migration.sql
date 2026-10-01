-- Manual text drafts incur no model spend. Preserve the positive-budget rule for
-- model revisions; zero-budget drafts cannot carry approval or usage records.
ALTER TABLE care_revisions DROP CONSTRAINT care_revision_budget;
ALTER TABLE care_revisions ADD CONSTRAINT care_revision_budget CHECK (
  charged_micros >= 0 AND (
    budget_micros > 0 OR (
      budget_micros = 0 AND charged_micros = 0
      AND COALESCE(plan->>'policy', '') = 'source-workspace-v1'
      AND state = 'DRAFT' AND budget_state = 'UNRESERVED'
      AND approved_by IS NULL AND approval_expires_at IS NULL AND usage_id IS NULL
    )
  )
);
