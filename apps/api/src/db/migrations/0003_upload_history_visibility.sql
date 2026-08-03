ALTER TABLE media_app.upload_sessions
  ADD COLUMN history_hidden_at timestamptz;

ALTER TABLE media_app.upload_sessions
  ADD CONSTRAINT ck_upload_history_hidden CHECK (
    history_hidden_at IS NULL OR status = 'completed'
  );

CREATE INDEX ix_upload_visible_history
  ON media_app.upload_sessions (user_id, created_at DESC, id DESC)
  WHERE history_hidden_at IS NULL;
