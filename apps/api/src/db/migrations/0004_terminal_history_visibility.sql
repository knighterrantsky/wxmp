ALTER TABLE media_app.upload_sessions
  DROP CONSTRAINT ck_upload_history_hidden;

ALTER TABLE media_app.upload_sessions
  ADD CONSTRAINT ck_upload_history_hidden CHECK (
    history_hidden_at IS NULL
    OR status IN ('completing', 'completed', 'aborted', 'expired', 'failed')
  );
