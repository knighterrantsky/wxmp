CREATE SCHEMA IF NOT EXISTS media_app;
SET search_path = media_app, public;

CREATE TYPE user_status AS ENUM (
  'active', 'disabled', 'deleted'
);

CREATE TYPE identity_provider AS ENUM (
  'wechat_miniprogram'
);

CREATE TYPE media_kind AS ENUM (
  'image', 'video'
);

CREATE TYPE media_storage_status AS ENUM (
  'pending_upload', 'ready', 'failed', 'aborted', 'purged'
);

CREATE TYPE upload_session_status AS ENUM (
  'initiating', 'uploading', 'completing', 'completed',
  'aborting', 'aborted', 'expired', 'failed'
);

CREATE TYPE upload_part_status AS ENUM (
  'pending', 'uploaded', 'verified'
);

CREATE TYPE idempotency_status AS ENUM (
  'in_progress', 'completed', 'failed'
);

CREATE TYPE audit_actor_type AS ENUM (
  'user', 'system', 'admin'
);

CREATE TABLE users (
  id                     uuid PRIMARY KEY,
  status                 user_status NOT NULL DEFAULT 'active',
  nickname               text,
  nickname_confirmed_at  timestamptz,
  last_seen_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version            bigint NOT NULL DEFAULT 0,

  CONSTRAINT ck_users_nickname CHECK (
    nickname IS NULL OR (
      char_length(btrim(nickname)) >= 1
      AND octet_length(nickname) <= 128
    )
  ),
  CONSTRAINT ck_users_nickname_confirmation CHECK (
    nickname_confirmed_at IS NULL OR nickname IS NOT NULL
  ),
  CONSTRAINT ck_users_version CHECK (row_version >= 0)
);

CREATE TABLE user_identities (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  provider       identity_provider NOT NULL,
  app_id         varchar(64) COLLATE "C" NOT NULL,
  openid         varchar(128) COLLATE "C" NOT NULL,
  unionid        varchar(128) COLLATE "C",
  last_login_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at     timestamptz NOT NULL DEFAULT clock_timestamp(),

  CONSTRAINT uq_identity_subject UNIQUE (provider, app_id, openid),
  CONSTRAINT uq_identity_user_app UNIQUE (user_id, provider, app_id),
  CONSTRAINT ck_identity_app_id CHECK (
    char_length(btrim(app_id)) BETWEEN 1 AND 64
  ),
  CONSTRAINT ck_identity_openid CHECK (
    char_length(btrim(openid)) BETWEEN 1 AND 128
  ),
  CONSTRAINT ck_identity_unionid CHECK (
    unionid IS NULL OR char_length(btrim(unionid)) BETWEEN 1 AND 128
  )
);

CREATE INDEX ix_user_identities_user ON user_identities (user_id);

CREATE TABLE user_sessions (
  id                        uuid PRIMARY KEY,
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_family_id           uuid NOT NULL,
  rotated_from_session_id   uuid REFERENCES user_sessions(id) ON DELETE SET NULL,
  refresh_token_hash        bytea NOT NULL,
  device_id                 varchar(128),
  issued_at                 timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at                timestamptz NOT NULL,
  last_used_at              timestamptz,
  revoked_at                timestamptz,
  revoke_reason             varchar(64),
  reuse_detected_at         timestamptz,
  source_ip                 inet,
  user_agent                text,

  CONSTRAINT uq_session_refresh_hash UNIQUE (refresh_token_hash),
  CONSTRAINT ck_session_hash CHECK (octet_length(refresh_token_hash) = 32),
  CONSTRAINT ck_session_expiry CHECK (expires_at > issued_at),
  CONSTRAINT ck_session_revoked CHECK (
    revoked_at IS NULL OR revoked_at >= issued_at
  ),
  CONSTRAINT ck_session_reuse CHECK (
    reuse_detected_at IS NULL OR reuse_detected_at >= issued_at
  )
);

CREATE INDEX ix_user_sessions_active
  ON user_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

CREATE INDEX ix_user_sessions_family
  ON user_sessions (token_family_id);

CREATE TABLE media_objects (
  id                          uuid PRIMARY KEY,
  user_id                     uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind                        media_kind NOT NULL,
  storage_status              media_storage_status NOT NULL DEFAULT 'pending_upload',

  original_filename           varchar(255) NOT NULL,
  uploader_nickname_snapshot  text NOT NULL,
  declared_content_type       varchar(127) NOT NULL,
  verified_content_type       varchar(127),
  canonical_extension         varchar(16) NOT NULL,
  declared_size_bytes         bigint NOT NULL,
  verified_size_bytes         bigint,

  r2_bucket                   varchar(255) COLLATE "C" NOT NULL,
  object_key                  varchar(1024) COLLATE "C" NOT NULL,
  object_etag                 varchar(1024),

  create_idempotency_key      varchar(128) COLLATE "C" NOT NULL,
  uploaded_at                 timestamptz,
  failed_at                   timestamptz,
  failure_code                varchar(64),
  purged_at                   timestamptz,
  created_at                  timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at                  timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version                 bigint NOT NULL DEFAULT 0,

  CONSTRAINT uq_media_object_key UNIQUE (r2_bucket, object_key),
  CONSTRAINT uq_media_user_idempotency UNIQUE (user_id, create_idempotency_key),
  CONSTRAINT uq_media_id_user UNIQUE (id, user_id),
  CONSTRAINT ck_media_filename CHECK (
    char_length(btrim(original_filename)) >= 1
    AND octet_length(original_filename) <= 255
  ),
  CONSTRAINT ck_media_nickname_snapshot CHECK (
    char_length(btrim(uploader_nickname_snapshot)) >= 1
    AND octet_length(uploader_nickname_snapshot) <= 128
  ),
  CONSTRAINT ck_media_size CHECK (
    declared_size_bytes BETWEEN 12 AND 209715200
    AND (
      verified_size_bytes IS NULL
      OR verified_size_bytes BETWEEN 12 AND 209715200
    )
  ),
  CONSTRAINT ck_media_declared_type CHECK (
    (kind = 'image' AND declared_content_type LIKE 'image/%')
    OR (kind = 'video' AND declared_content_type LIKE 'video/%')
  ),
  CONSTRAINT ck_media_verified_type CHECK (
    verified_content_type IS NULL
    OR (kind = 'image' AND verified_content_type LIKE 'image/%')
    OR (kind = 'video' AND verified_content_type LIKE 'video/%')
  ),
  CONSTRAINT ck_media_extension CHECK (
    canonical_extension ~ '^\.[a-z0-9]{1,10}$'
  ),
  CONSTRAINT ck_media_object_key CHECK (
    octet_length(object_key) BETWEEN 1 AND 1024
    AND object_key !~ '(^/|[[:cntrl:]])'
    AND object_key !~ '(^|/)\.\.(/|$)'
  ),
  CONSTRAINT ck_media_ready_fields CHECK (
    storage_status <> 'ready'
    OR (
      verified_content_type IS NOT NULL
      AND verified_size_bytes IS NOT NULL
      AND object_etag IS NOT NULL
      AND uploaded_at IS NOT NULL
    )
  ),
  CONSTRAINT ck_media_failed_fields CHECK (
    storage_status <> 'failed'
    OR (failed_at IS NOT NULL AND failure_code IS NOT NULL)
  ),
  CONSTRAINT ck_media_purged CHECK (
    (storage_status = 'purged') = (purged_at IS NOT NULL)
  ),
  CONSTRAINT ck_media_version CHECK (row_version >= 0)
);

CREATE INDEX ix_media_user_history
  ON media_objects (user_id, created_at DESC, id DESC);

CREATE INDEX ix_media_storage_status
  ON media_objects (storage_status, created_at)
  WHERE storage_status IN ('pending_upload', 'failed');

CREATE TABLE upload_sessions (
  id                       uuid PRIMARY KEY,
  media_object_id          uuid NOT NULL,
  user_id                  uuid NOT NULL,
  status                   upload_session_status NOT NULL DEFAULT 'initiating',
  r2_upload_id             varchar(1024) COLLATE "C",

  expected_size_bytes      bigint NOT NULL,
  part_size_bytes          integer NOT NULL DEFAULT 8388608,
  expected_part_count      smallint GENERATED ALWAYS AS (
    ((expected_size_bytes + part_size_bytes - 1) / part_size_bytes)::smallint
  ) STORED,
  confirmed_size_bytes     bigint NOT NULL DEFAULT 0,
  confirmed_part_count     smallint NOT NULL DEFAULT 0,
  finalize_attempt_count   integer NOT NULL DEFAULT 0,
  next_finalize_at         timestamptz,
  last_finalize_error_code varchar(64),
  last_finalize_error_at   timestamptz,
  abort_reason             varchar(32),
  abort_attempt_count      integer NOT NULL DEFAULT 0,
  next_abort_at            timestamptz,
  last_abort_error_code    varchar(64),
  last_abort_error_at      timestamptz,

  expires_at               timestamptz NOT NULL,
  last_activity_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at             timestamptz,
  aborted_at               timestamptz,
  expired_at               timestamptz,
  failed_at                timestamptz,
  failure_code             varchar(64),
  failure_detail           varchar(1000),
  created_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at               timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version              bigint NOT NULL DEFAULT 0,

  CONSTRAINT fk_upload_media_owner
    FOREIGN KEY (media_object_id, user_id)
    REFERENCES media_objects (id, user_id)
    ON DELETE CASCADE,
  CONSTRAINT uq_upload_media UNIQUE (media_object_id),
  CONSTRAINT uq_upload_r2_id UNIQUE (r2_upload_id),
  CONSTRAINT ck_upload_size CHECK (
    expected_size_bytes BETWEEN 12 AND 209715200
  ),
  CONSTRAINT ck_upload_part_size CHECK (part_size_bytes = 8388608),
  CONSTRAINT ck_upload_part_count CHECK (expected_part_count BETWEEN 1 AND 25),
  CONSTRAINT ck_upload_confirmed_progress CHECK (
    confirmed_size_bytes BETWEEN 0 AND expected_size_bytes
    AND confirmed_part_count BETWEEN 0 AND expected_part_count
  ),
  CONSTRAINT ck_upload_finalize_attempts CHECK (finalize_attempt_count >= 0),
  CONSTRAINT ck_upload_finalize_schedule CHECK (
    (status = 'completing') = (next_finalize_at IS NOT NULL)
  ),
  CONSTRAINT ck_upload_finalize_error CHECK (
    (last_finalize_error_code IS NULL) = (last_finalize_error_at IS NULL)
  ),
  CONSTRAINT ck_upload_abort_attempts CHECK (abort_attempt_count >= 0),
  CONSTRAINT ck_upload_abort_schedule CHECK (
    (status = 'aborting') = (next_abort_at IS NOT NULL)
  ),
  CONSTRAINT ck_upload_abort_error CHECK (
    (last_abort_error_code IS NULL) = (last_abort_error_at IS NULL)
  ),
  CONSTRAINT ck_upload_abort_reason CHECK (
    abort_reason IS NULL OR abort_reason IN (
      'userCancelled', 'replaced', 'expired', 'validationFailed'
    )
  ),
  CONSTRAINT ck_upload_abort_reason_state CHECK (
    (status = 'aborting' AND abort_reason IS NOT NULL)
    OR (status = 'aborted' AND abort_reason IN ('userCancelled', 'replaced'))
    OR (status = 'expired' AND abort_reason = 'expired')
    OR (status = 'failed' AND (abort_reason IS NULL OR abort_reason = 'validationFailed'))
    OR (status NOT IN ('aborting', 'aborted', 'expired', 'failed') AND abort_reason IS NULL)
  ),
  CONSTRAINT ck_upload_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_upload_r2_required CHECK (
    status NOT IN ('uploading', 'completing', 'completed')
    OR r2_upload_id IS NOT NULL
  ),
  CONSTRAINT ck_upload_completed CHECK (
    ((status = 'completed') = (completed_at IS NOT NULL))
    AND (
      status <> 'completed'
      OR (
        confirmed_size_bytes = expected_size_bytes
        AND confirmed_part_count = expected_part_count
      )
    )
  ),
  CONSTRAINT ck_upload_aborted CHECK (
    (status = 'aborted') = (aborted_at IS NOT NULL)
  ),
  CONSTRAINT ck_upload_expired CHECK (
    (status = 'expired') = (expired_at IS NOT NULL)
  ),
  CONSTRAINT ck_upload_failed CHECK (
    status <> 'failed' OR (failed_at IS NOT NULL AND failure_code IS NOT NULL)
  ),
  CONSTRAINT ck_upload_version CHECK (row_version >= 0)
);

CREATE INDEX ix_upload_user_history
  ON upload_sessions (user_id, created_at DESC, id DESC);

CREATE INDEX ix_upload_expiry
  ON upload_sessions (expires_at)
  WHERE status IN ('initiating', 'uploading');

CREATE INDEX ix_upload_finalize_due
  ON upload_sessions (next_finalize_at, id)
  WHERE status = 'completing';

CREATE INDEX ix_upload_abort_due
  ON upload_sessions (next_abort_at, id)
  WHERE status = 'aborting';

CREATE INDEX ix_upload_reconcile_stuck
  ON upload_sessions (status, last_activity_at, id)
  WHERE status IN ('initiating', 'completing', 'aborting');

CREATE TABLE upload_parts (
  upload_session_id    uuid NOT NULL
                         REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_number          smallint NOT NULL,
  status               upload_part_status NOT NULL DEFAULT 'pending',
  offset_bytes         bigint NOT NULL,
  expected_size_bytes  integer NOT NULL,
  actual_size_bytes    integer,
  checksum_sha256      bytea,
  r2_etag              varchar(1024),
  attempt_count        integer NOT NULL DEFAULT 0,
  uploaded_at          timestamptz,
  verified_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version          bigint NOT NULL DEFAULT 0,

  PRIMARY KEY (upload_session_id, part_number),
  CONSTRAINT ck_part_number CHECK (part_number BETWEEN 1 AND 25),
  CONSTRAINT ck_part_offset CHECK (offset_bytes >= 0),
  CONSTRAINT ck_part_expected_size CHECK (
    expected_size_bytes BETWEEN 1 AND 8388608
  ),
  CONSTRAINT ck_part_actual_size CHECK (
    actual_size_bytes IS NULL
    OR actual_size_bytes BETWEEN 1 AND 8388608
  ),
  CONSTRAINT ck_part_checksum CHECK (
    checksum_sha256 IS NULL OR octet_length(checksum_sha256) = 32
  ),
  CONSTRAINT ck_part_attempts CHECK (attempt_count >= 0),
  CONSTRAINT ck_part_uploaded_fields CHECK (
    status = 'pending'
    OR (
      actual_size_bytes IS NOT NULL
      AND checksum_sha256 IS NOT NULL
      AND r2_etag IS NOT NULL
      AND uploaded_at IS NOT NULL
    )
  ),
  CONSTRAINT ck_part_verified_fields CHECK (
    status <> 'verified' OR verified_at IS NOT NULL
  ),
  CONSTRAINT ck_part_version CHECK (row_version >= 0)
);

CREATE INDEX ix_upload_parts_status
  ON upload_parts (upload_session_id, status, part_number);

CREATE TABLE idempotency_records (
  id                  uuid PRIMARY KEY,
  principal_type      varchar(32) NOT NULL,
  principal_id        varchar(128) COLLATE "C" NOT NULL,
  operation           varchar(128) COLLATE "C" NOT NULL,
  idempotency_key     varchar(128) COLLATE "C" NOT NULL,
  request_hash        bytea NOT NULL,
  status              idempotency_status NOT NULL DEFAULT 'in_progress',
  locked_until        timestamptz,
  resource_type       varchar(64),
  resource_id         uuid,
  response_status     smallint,
  response_body       jsonb,
  expires_at          timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at          timestamptz NOT NULL DEFAULT clock_timestamp(),
  row_version         bigint NOT NULL DEFAULT 0,

  CONSTRAINT uq_idempotency_scope UNIQUE (
    principal_type, principal_id, operation, idempotency_key
  ),
  CONSTRAINT ck_idempotency_principal CHECK (
    principal_type IN ('user', 'system')
  ),
  CONSTRAINT ck_idempotency_key CHECK (
    char_length(idempotency_key) BETWEEN 16 AND 128
  ),
  CONSTRAINT ck_idempotency_hash CHECK (octet_length(request_hash) = 32),
  CONSTRAINT ck_idempotency_expiry CHECK (expires_at > created_at),
  CONSTRAINT ck_idempotency_response CHECK (
    (status = 'in_progress' AND locked_until IS NOT NULL AND response_status IS NULL)
    OR
    (status IN ('completed', 'failed') AND locked_until IS NULL
      AND response_status IS NOT NULL
      AND response_status BETWEEN 100 AND 599)
  ),
  CONSTRAINT ck_idempotency_body CHECK (
    response_body IS NULL OR jsonb_typeof(response_body) = 'object'
  ),
  CONSTRAINT ck_idempotency_version CHECK (row_version >= 0)
);

CREATE INDEX ix_idempotency_expiry ON idempotency_records (expires_at);

CREATE TABLE audit_events (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id          uuid NOT NULL,
  occurred_at       timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_type        audit_actor_type NOT NULL,
  actor_user_id     uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_session_id  uuid REFERENCES user_sessions(id) ON DELETE SET NULL,
  actor_service     varchar(128),
  request_id        uuid,
  event_type        varchar(128) NOT NULL,
  entity_type       varchar(64) NOT NULL,
  entity_id         uuid,
  source_ip         inet,
  old_state         jsonb,
  new_state         jsonb,
  metadata          jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT uq_audit_event_id UNIQUE (event_id),
  CONSTRAINT ck_audit_actor CHECK (
    (actor_type IN ('user', 'admin') AND actor_user_id IS NOT NULL)
    OR (actor_type = 'system' AND actor_service IS NOT NULL)
  ),
  CONSTRAINT ck_audit_event_type CHECK (
    char_length(btrim(event_type)) BETWEEN 1 AND 128
  ),
  CONSTRAINT ck_audit_entity_type CHECK (
    char_length(btrim(entity_type)) BETWEEN 1 AND 64
  ),
  CONSTRAINT ck_audit_json CHECK (
    (old_state IS NULL OR jsonb_typeof(old_state) = 'object')
    AND (new_state IS NULL OR jsonb_typeof(new_state) = 'object')
    AND jsonb_typeof(metadata) = 'object'
  )
);

CREATE INDEX ix_audit_entity
  ON audit_events (entity_type, entity_id, occurred_at DESC);

CREATE INDEX ix_audit_user
  ON audit_events (actor_user_id, occurred_at DESC)
  WHERE actor_user_id IS NOT NULL;

CREATE INDEX ix_audit_request
  ON audit_events (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX ix_audit_time_brin
  ON audit_events USING brin (occurred_at);

CREATE FUNCTION touch_versioned_row()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  NEW.row_version := OLD.row_version + 1;
  RETURN NEW;
END;
$$;

CREATE TRIGGER touch_users
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION touch_versioned_row();

CREATE TRIGGER touch_media_objects
BEFORE UPDATE ON media_objects
FOR EACH ROW EXECUTE FUNCTION touch_versioned_row();

CREATE TRIGGER touch_upload_sessions
BEFORE UPDATE ON upload_sessions
FOR EACH ROW EXECUTE FUNCTION touch_versioned_row();

CREATE TRIGGER touch_upload_parts
BEFORE UPDATE ON upload_parts
FOR EACH ROW EXECUTE FUNCTION touch_versioned_row();

CREATE TRIGGER touch_idempotency_records
BEFORE UPDATE ON idempotency_records
FOR EACH ROW EXECUTE FUNCTION touch_versioned_row();
