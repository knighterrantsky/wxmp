import { timingSafeEqual } from 'node:crypto'

import type {
  InitializeUploadRequest,
  InitializeUploadResponse,
  UploadPartPlan,
} from '@wx-upload/contracts'
import type { Pool, PoolClient } from 'pg'

import type { AuthRequestContext } from '../auth/auth-repository.js'
import { ApiError } from '../http/errors.js'
import type { Clock } from '../lib/clock.js'
import type { IdGenerator } from '../lib/id.js'

export type InitializeUploadData = InitializeUploadResponse['data']

export interface InitializeUploadDraft {
  userId: string
  sessionId: string
  idempotencyKey: string
  requestHash: Buffer
  mediaId: string
  uploadId: string
  bucket: string
  objectKey: string
  fileName: string
  kind: InitializeUploadRequest['kind']
  mimeType: InitializeUploadRequest['mimeType']
  sizeBytes: number
  canonicalExtension: string
  parts: UploadPartPlan[]
  createdAt: Date
  expiresAt: Date
  lockedUntil: Date
  idempotencyExpiresAt: Date
  context: AuthRequestContext
  data: InitializeUploadData
}

export type BeginInitializationResult =
  | { kind: 'created' }
  | { kind: 'replay_success'; data: InitializeUploadData }
  | {
      kind: 'replay_failure'
      code: 'STORAGE_UNAVAILABLE'
      statusCode: 503
      retryable: true
    }
  | { kind: 'in_progress' }
  | { kind: 'key_reused' }

export interface UploadRepository {
  beginInitialization(draft: InitializeUploadDraft): Promise<BeginInitializationResult>
  completeInitialization(input: { draft: InitializeUploadDraft; r2UploadId: string }): Promise<void>
  failInitialization(input: {
    draft: InitializeUploadDraft
    code: 'STORAGE_UNAVAILABLE'
  }): Promise<void>
}

interface IdempotencyRow {
  request_hash: Buffer
  status: 'in_progress' | 'completed' | 'failed'
  resource_id: string | null
  response_status: number | null
  response_body: unknown
}

interface UserRow {
  status: 'active' | 'disabled' | 'deleted'
  nickname: string | null
  nickname_confirmed_at: Date | string | null
}

interface LockedInitializationState {
  mediaStatus: string
  uploadStatus: string
  idempotencyStatus: string
}

function rollback(client: PoolClient): Promise<void> {
  return client.query('rollback').then(
    () => undefined,
    () => undefined,
  )
}

function apiError(
  code: 'UNAUTHORIZED' | 'USER_DISABLED' | 'NICKNAME_REQUIRED' | 'UPLOAD_SESSION_LIMIT',
  statusCode: number,
  retryable = false,
): ApiError {
  return new ApiError({ code, message: code, statusCode, retryable })
}

function sameHash(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function replayData(value: unknown): InitializeUploadData {
  if (!isRecord(value)) throw new Error('idempotency response is invalid')
  const upload = value['upload']
  const parts = value['parts']
  if (typeof upload !== 'object' || upload === null || !Array.isArray(parts)) {
    throw new Error('idempotency response is invalid')
  }
  return value as InitializeUploadData
}

function replayResult(row: IdempotencyRow, requestHash: Buffer): BeginInitializationResult {
  if (!sameHash(row.request_hash, requestHash)) return { kind: 'key_reused' }
  if (row.status === 'in_progress') return { kind: 'in_progress' }
  if (row.status === 'completed' && row.response_status === 201) {
    return { kind: 'replay_success', data: replayData(row.response_body) }
  }
  if (row.status === 'failed' && row.response_status === 503) {
    const body = row.response_body
    if (!isRecord(body) || body['code'] !== 'STORAGE_UNAVAILABLE' || body['retryable'] !== true) {
      throw new Error('idempotency failure response is invalid')
    }
    return {
      kind: 'replay_failure',
      code: 'STORAGE_UNAVAILABLE',
      statusCode: 503,
      retryable: true,
    }
  }
  throw new Error('idempotency record is in an invalid state')
}

export class PostgresUploadRepository implements UploadRepository {
  readonly #pool: Pool
  readonly #clock: Clock
  readonly #ids: IdGenerator

  constructor(deps: { pool: Pool; clock: Clock; ids: IdGenerator }) {
    this.#pool = deps.pool
    this.#clock = deps.clock
    this.#ids = deps.ids
  }

  async beginInitialization(draft: InitializeUploadDraft): Promise<BeginInitializationResult> {
    const client = await this.#pool.connect()
    try {
      await client.query('begin')
      const inserted = await client.query(
        `insert into media_app.idempotency_records(
           id, principal_type, principal_id, operation, idempotency_key,
           request_hash, status, locked_until, expires_at, created_at, updated_at
         ) values ($1, 'user', $2, 'upload.initialize', $3, $4,
                   'in_progress', $5, $6, $7, $7)
         on conflict (principal_type, principal_id, operation, idempotency_key) do nothing
         returning id`,
        [
          this.#ids.next(),
          draft.userId,
          draft.idempotencyKey,
          draft.requestHash,
          draft.lockedUntil,
          draft.idempotencyExpiresAt,
          draft.createdAt,
        ],
      )
      let existingResult: BeginInitializationResult | undefined
      if (inserted.rowCount !== 1) {
        const existing = await client.query<IdempotencyRow>(
          `select request_hash, status, resource_id, response_status, response_body
             from media_app.idempotency_records
            where principal_type = 'user' and principal_id = $1
              and operation = 'upload.initialize' and idempotency_key = $2
            for update`,
          [draft.userId, draft.idempotencyKey],
        )
        const row = existing.rows[0]
        if (row === undefined) throw new Error('idempotency conflict could not be loaded')
        existingResult = replayResult(row, draft.requestHash)
      }

      const selectedUser = await client.query<UserRow>(
        `select status, nickname, nickname_confirmed_at
           from media_app.users where id = $1 for update`,
        [draft.userId],
      )
      const user = selectedUser.rows[0]
      if (user === undefined || user.status === 'deleted') {
        throw apiError('UNAUTHORIZED', 401)
      }
      if (user.status === 'disabled') throw apiError('USER_DISABLED', 403)
      if (user.nickname_confirmed_at === null || user.nickname === null) {
        throw apiError('NICKNAME_REQUIRED', 428)
      }
      if (existingResult !== undefined) {
        await client.query('commit')
        return existingResult
      }

      const unfinished = await client.query<{ count: string }>(
        `select count(*)::text as count
           from media_app.upload_sessions
          where user_id = $1
            and status in ('initiating', 'uploading', 'completing', 'aborting')`,
        [draft.userId],
      )
      if (Number(unfinished.rows[0]?.count ?? 0) >= 5) {
        throw apiError('UPLOAD_SESSION_LIMIT', 429, true)
      }

      await client.query(
        `insert into media_app.media_objects(
           id, user_id, kind, storage_status, original_filename,
           uploader_nickname_snapshot, declared_content_type, canonical_extension,
           declared_size_bytes, r2_bucket, object_key, create_idempotency_key,
           created_at, updated_at
         ) values ($1, $2, $3, 'pending_upload', $4, $5, $6, $7,
                   $8, $9, $10, $11, $12, $12)`,
        [
          draft.mediaId,
          draft.userId,
          draft.kind,
          draft.fileName,
          user.nickname,
          draft.mimeType,
          draft.canonicalExtension,
          draft.sizeBytes,
          draft.bucket,
          draft.objectKey,
          draft.idempotencyKey,
          draft.createdAt,
        ],
      )
      await client.query(
        `insert into media_app.upload_sessions(
           id, media_object_id, user_id, status, expected_size_bytes,
           expires_at, last_activity_at, created_at, updated_at
         ) values ($1, $2, $3, 'initiating', $4, $5, $6, $6, $6)`,
        [
          draft.uploadId,
          draft.mediaId,
          draft.userId,
          draft.sizeBytes,
          draft.expiresAt,
          draft.createdAt,
        ],
      )
      const linkedIdempotency = await client.query(
        `update media_app.idempotency_records
            set resource_type = 'upload_session', resource_id = $4, locked_until = $5
          where principal_type = 'user' and principal_id = $1
            and operation = 'upload.initialize' and idempotency_key = $2
            and request_hash = $3 and status = 'in_progress'`,
        [
          draft.userId,
          draft.idempotencyKey,
          draft.requestHash,
          draft.uploadId,
          new Date(this.#clock.now().getTime() + 60_000),
        ],
      )
      if (linkedIdempotency.rowCount !== 1) {
        throw new Error('upload initialization idempotency link was not updated')
      }
      await this.#insertAudit(client, {
        eventType: 'upload.initialize_started',
        draft,
        metadata: {
          kind: draft.kind,
          sizeBytes: draft.sizeBytes,
          partCount: draft.parts.length,
        },
      })
      await client.query('commit')
      return { kind: 'created' }
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async completeInitialization(input: {
    draft: InitializeUploadDraft
    r2UploadId: string
  }): Promise<void> {
    const client = await this.#pool.connect()
    const now = this.#clock.now()
    try {
      await client.query('begin')
      const state = await this.#lockInitialization(client, input.draft)
      if (
        state.mediaStatus !== 'pending_upload' ||
        state.uploadStatus !== 'initiating' ||
        state.idempotencyStatus !== 'in_progress'
      ) {
        throw new Error('upload initialization is no longer completable')
      }
      const updatedUpload = await client.query(
        `update media_app.upload_sessions
            set r2_upload_id = $2, status = 'uploading', last_activity_at = $3
          where id = $1 and status = 'initiating'`,
        [input.draft.uploadId, input.r2UploadId, now],
      )
      if (updatedUpload.rowCount !== 1) {
        throw new Error('upload initialization session was not updated')
      }
      for (const part of input.draft.parts) {
        await client.query(
          `insert into media_app.upload_parts(
             upload_session_id, part_number, status, offset_bytes,
             expected_size_bytes, created_at, updated_at
           ) values ($1, $2, 'pending', $3, $4, $5, $5)`,
          [input.draft.uploadId, part.partNumber, part.offsetBytes, part.sizeBytes, now],
        )
      }
      const completedIdempotency = await client.query(
        `update media_app.idempotency_records
            set status = 'completed', locked_until = null, response_status = 201,
                response_body = $5::jsonb, expires_at = $6
          where principal_type = 'user' and principal_id = $1
            and operation = 'upload.initialize' and idempotency_key = $2
            and resource_id = $3 and status = 'in_progress' and request_hash = $4`,
        [
          input.draft.userId,
          input.draft.idempotencyKey,
          input.draft.uploadId,
          input.draft.requestHash,
          JSON.stringify(input.draft.data),
          new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000),
        ],
      )
      if (completedIdempotency.rowCount !== 1) {
        throw new Error('upload initialization idempotency result was not completed')
      }
      await this.#insertAudit(client, {
        eventType: 'upload.initialized',
        draft: input.draft,
        metadata: { partCount: input.draft.parts.length },
      })
      await client.query('commit')
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async failInitialization(input: {
    draft: InitializeUploadDraft
    code: 'STORAGE_UNAVAILABLE'
  }): Promise<void> {
    const client = await this.#pool.connect()
    const now = this.#clock.now()
    try {
      await client.query('begin')
      const state = await this.#lockInitialization(client, input.draft)
      if (
        state.uploadStatus === 'failed' &&
        state.mediaStatus === 'failed' &&
        state.idempotencyStatus === 'failed'
      ) {
        await client.query('commit')
        return
      }
      if (
        state.uploadStatus !== 'initiating' ||
        state.mediaStatus !== 'pending_upload' ||
        state.idempotencyStatus !== 'in_progress'
      ) {
        throw new Error('upload initialization is no longer fail-able')
      }
      const failedUpload = await client.query(
        `update media_app.upload_sessions
            set status = 'failed', failed_at = $2, failure_code = $3
          where id = $1 and status = 'initiating'`,
        [input.draft.uploadId, now, input.code],
      )
      if (failedUpload.rowCount !== 1) {
        throw new Error('upload initialization session was not failed')
      }
      const failedMedia = await client.query(
        `update media_app.media_objects
            set storage_status = 'failed', failed_at = $2, failure_code = $3
          where id = $1 and storage_status = 'pending_upload'`,
        [input.draft.mediaId, now, input.code],
      )
      if (failedMedia.rowCount !== 1) {
        throw new Error('upload initialization media record was not failed')
      }
      const failedIdempotency = await client.query(
        `update media_app.idempotency_records
            set status = 'failed', locked_until = null, response_status = 503,
                response_body = $4::jsonb, expires_at = $5
          where principal_type = 'user' and principal_id = $1
            and operation = 'upload.initialize' and idempotency_key = $2
            and resource_id = $3 and status = 'in_progress'`,
        [
          input.draft.userId,
          input.draft.idempotencyKey,
          input.draft.uploadId,
          JSON.stringify({ code: input.code, retryable: true }),
          new Date(now.getTime() + 7 * 24 * 60 * 60 * 1_000),
        ],
      )
      if (failedIdempotency.rowCount !== 1) {
        throw new Error('upload initialization idempotency result was not failed')
      }
      await this.#insertAudit(client, {
        eventType: 'upload.initialize_failed',
        draft: input.draft,
        metadata: { code: input.code },
      })
      await client.query('commit')
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async #lockInitialization(
    client: PoolClient,
    draft: InitializeUploadDraft,
  ): Promise<LockedInitializationState> {
    const media = await client.query<{ storage_status: string }>(
      `select storage_status
         from media_app.media_objects
        where id = $1 and user_id = $2
        for update`,
      [draft.mediaId, draft.userId],
    )
    const mediaRow = media.rows[0]
    if (mediaRow === undefined) throw new Error('upload initialization media record is missing')

    const upload = await client.query<{ status: string }>(
      `select status
         from media_app.upload_sessions
        where id = $1 and media_object_id = $2 and user_id = $3
        for update`,
      [draft.uploadId, draft.mediaId, draft.userId],
    )
    const uploadRow = upload.rows[0]
    if (uploadRow === undefined) throw new Error('upload initialization session is missing')

    const idempotency = await client.query<{ status: string }>(
      `select status
         from media_app.idempotency_records
        where principal_type = 'user' and principal_id = $1
          and operation = 'upload.initialize' and idempotency_key = $2
          and resource_type = 'upload_session' and resource_id = $3
          and request_hash = $4
        for update`,
      [draft.userId, draft.idempotencyKey, draft.uploadId, draft.requestHash],
    )
    const idempotencyRow = idempotency.rows[0]
    if (idempotencyRow === undefined) {
      throw new Error('upload initialization idempotency record is missing')
    }
    return {
      mediaStatus: mediaRow.storage_status,
      uploadStatus: uploadRow.status,
      idempotencyStatus: idempotencyRow.status,
    }
  }

  async #insertAudit(
    client: PoolClient,
    input: {
      eventType: string
      draft: InitializeUploadDraft
      metadata: Record<string, unknown>
    },
  ): Promise<void> {
    await client.query(
      `insert into media_app.audit_events(
         event_id, actor_type, actor_user_id, actor_session_id, request_id,
         event_type, entity_type, entity_id, source_ip, metadata
       ) values ($1, 'user', $2, $3, $4, $5, 'upload_session', $6, $7, $8::jsonb)`,
      [
        this.#ids.next(),
        input.draft.userId,
        input.draft.sessionId,
        input.draft.context.requestId,
        input.eventType,
        input.draft.uploadId,
        input.draft.context.sourceIp ?? null,
        JSON.stringify(input.metadata),
      ],
    )
  }
}
