-- Version stock templates; never rewrite sent emails, customized templates, or applied migrations.
BEGIN;
LOCK TABLE email_template_versions IN SHARE ROW EXCLUSIVE MODE;
WITH stock AS (
  SELECT t.id, t.event_type,
    (SELECT COALESCE(MAX(v.version),0)+1 FROM email_template_versions v WHERE v.event_type=t.event_type) AS next_version
  FROM email_template_versions t
  WHERE t.enabled=true AND t.created_by_user_id IS NULL
    AND t.subject_template='ZeroRoot: {{title}}'
    AND t.body_template=E'Hello {{recipientName}},\n\n{{message}}\n\nOpen ZeroRoot: {{actionUrl}}'
), disabled AS (
  UPDATE email_template_versions t SET enabled=false FROM stock s WHERE t.id=s.id
  RETURNING t.event_type
)
INSERT INTO email_template_versions (id,event_type,version,subject_template,body_template,enabled,created_by_user_id,created_at)
SELECT gen_random_uuid(), s.event_type, s.next_version, 'CodeBandage: {{title}}',
 E'Hello {{recipientName}},\n\n{{message}}\n\nOpen CodeBandage: {{actionUrl}}', true, NULL, CURRENT_TIMESTAMP
FROM stock s JOIN disabled d ON d.event_type=s.event_type;
COMMIT;
