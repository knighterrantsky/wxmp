CREATE INDEX ix_audit_session
  ON media_app.audit_events (actor_session_id)
  WHERE actor_session_id IS NOT NULL;

CREATE INDEX ix_audit_retention
  ON media_app.audit_events (occurred_at, id);

CREATE INDEX ix_user_sessions_rotated_from
  ON media_app.user_sessions (rotated_from_session_id)
  WHERE rotated_from_session_id IS NOT NULL;

CREATE INDEX ix_idempotency_resource
  ON media_app.idempotency_records (resource_type, resource_id)
  WHERE resource_id IS NOT NULL;

CREATE INDEX ix_idempotency_stable_retention
  ON media_app.idempotency_records (expires_at, id)
  WHERE status IN ('completed', 'failed');

CREATE INDEX ix_user_sessions_expired_retention
  ON media_app.user_sessions (expires_at, id);

CREATE INDEX ix_user_sessions_revoked_retention
  ON media_app.user_sessions (revoked_at, id)
  WHERE revoked_at IS NOT NULL;

CREATE INDEX ix_upload_terminal_retention
  ON media_app.upload_sessions (
    (
      CASE status
        WHEN 'completed' THEN completed_at
        WHEN 'aborted' THEN aborted_at
        WHEN 'expired' THEN expired_at
        WHEN 'failed' THEN failed_at
      END
    ),
    id
  )
  WHERE status IN ('completed', 'aborted', 'expired', 'failed');
