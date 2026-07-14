import { timingSafeEqual } from 'node:crypto'

import type {
  ErrorCode,
  InitializeUploadRequest,
  InitializeUploadResponse,
  UploadDetailResponse,
  UploadPartResponse,
  UploadPartPlan,
} from '@wx-upload/contracts'
import type { Pool, PoolClient } from 'pg'

import type { AuthRequestContext } from '../auth/auth-repository.js'
import { ApiError, PUBLIC_ERROR_MESSAGES } from '../http/errors.js'
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
  assertPartOwnership(input: { userId: string; uploadId: string }): Promise<void>
  preparePart(input: PrepareUploadPartInput): Promise<PreparedUploadPart>
  confirmPart(input: ConfirmUploadPartInput): Promise<UploadPartResponse['data']>
  scheduleValidationAbort(input: ScheduleValidationAbortInput): Promise<void>
  getDetail(input: { userId: string; uploadId: string }): Promise<UploadDetailResponse['data']>
}

export interface PartRequestContext extends AuthRequestContext {
  sessionId: string
}

export interface PrepareUploadPartInput {
  userId: string
  uploadId: string
  partNumber: number
  expectedSha256: Buffer
  context: PartRequestContext
}

export interface PreparedPartIdentity {
  uploadId: string
  mediaId: string
  userId: string
  partNumber: number
  bucket: string
  objectKey: string
  r2UploadId: string
  expectedSizeBytes: number
  expectedTotalBytes: number
  expectedPartCount: number
  mimeType: InitializeUploadRequest['mimeType']
  canonicalExtension: string
}

export type PreparedUploadPart =
  | { kind: 'ready'; part: PreparedPartIdentity }
  | { kind: 'replay'; data: UploadPartResponse['data'] }

export interface ConfirmUploadPartInput {
  prepared: PreparedPartIdentity
  actualSizeBytes: number
  checksumSha256: Buffer
  etag: string
  context: PartRequestContext
}

export interface ScheduleValidationAbortInput {
  prepared: PreparedPartIdentity
  context: PartRequestContext
  failureCode: 'FILE_TOO_SMALL' | 'MIME_MISMATCH'
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

interface PreparedMediaRow {
  media_id: string
  r2_bucket: string
  object_key: string
  declared_content_type: InitializeUploadRequest['mimeType']
  canonical_extension: string
}

interface PreparedSessionRow {
  status: string
  r2_upload_id: string | null
  expected_size_bytes: string
  expected_part_count: number
  confirmed_size_bytes: string
  confirmed_part_count: number
  expires_at: Date | string
}

interface PreparedPartRow {
  status: 'pending' | 'uploaded' | 'verified'
  expected_size_bytes: number
  actual_size_bytes: number | null
  checksum_sha256: Buffer | null
  uploaded_at: Date | string | null
}

interface UploadDetailRow {
  upload_id: string
  media_id: string
  upload_status: string
  media_status: string
  original_filename: string
  kind: InitializeUploadRequest['kind']
  declared_content_type: InitializeUploadRequest['mimeType']
  expected_size_bytes: string
  expected_part_count: number
  confirmed_size_bytes: string
  confirmed_part_count: number
  expires_at: Date | string
  failure_code: string | null
  failed_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

interface UploadDetailPartRow {
  part_number: number
  offset_bytes: string
  expected_size_bytes: number
  status: 'pending' | 'uploaded' | 'verified'
  checksum_sha256: Buffer | null
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

function uploadError(
  code:
    | 'FIRST_PART_REQUIRED'
    | 'PART_NUMBER_INVALID'
    | 'UPLOAD_EXPIRED'
    | 'UPLOAD_NOT_FOUND'
    | 'UPLOAD_NOT_WRITABLE',
  statusCode: number,
): ApiError {
  return new ApiError({ code, message: code, statusCode })
}

function assertActiveUser(user: Pick<UserRow, 'status'> | undefined): void {
  if (user === undefined || user.status === 'deleted') throw apiError('UNAUTHORIZED', 401)
  if (user.status === 'disabled') throw apiError('USER_DISABLED', 403)
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function percent(confirmedBytes: number, totalBytes: number): number {
  return Math.min(100, Math.round((confirmedBytes / totalBytes) * 10_000) / 100)
}

function detailedProgress(input: {
  confirmedBytes: number
  totalBytes: number
  uploadedParts: number
  totalParts: number
}): UploadPartResponse['data']['progress'] {
  return {
    ...input,
    percent: percent(input.confirmedBytes, input.totalBytes),
  }
}

function publicUploadStatus(uploadStatus: string, mediaStatus: string) {
  if (uploadStatus === 'completing') return 'finalizing' as const
  if (uploadStatus === 'aborting') return 'cancelling' as const
  if (uploadStatus === 'completed' && mediaStatus === 'ready') return 'uploaded' as const
  if (uploadStatus === 'aborted') return 'aborted' as const
  if (uploadStatus === 'expired') return 'expired' as const
  if (uploadStatus === 'failed' || mediaStatus === 'failed') return 'upload_failed' as const
  return 'uploading' as const
}

const PUBLIC_FAILURE_CODES = new Set<ErrorCode>([
  'FILE_TOO_SMALL',
  'MIME_MISMATCH',
  'STORAGE_UNAVAILABLE',
  'STORAGE_OBJECT_SIZE_MISMATCH',
])

function publicFailure(
  status: string,
  code: string | null,
  failedAt: Date | string | null,
): UploadDetailResponse['data']['upload']['failure'] {
  if (status !== 'upload_failed' || code === null || failedAt === null) return null
  const safeCode: ErrorCode = PUBLIC_FAILURE_CODES.has(code as ErrorCode)
    ? (code as ErrorCode)
    : 'STORAGE_UNAVAILABLE'
  return {
    stage: safeCode === 'MIME_MISMATCH' || safeCode === 'FILE_TOO_SMALL' ? 'validation' : 'storage',
    code: safeCode,
    message: PUBLIC_ERROR_MESSAGES[safeCode],
    failedAt: asDate(failedAt).toISOString(),
  }
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
           from media_app.users where id = $1 for no key update`,
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
      const selectedUser = await client.query<Pick<UserRow, 'status'>>(
        `select status from media_app.users where id = $1 for share`,
        [input.draft.userId],
      )
      assertActiveUser(selectedUser.rows[0])
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

  async assertPartOwnership(input: { userId: string; uploadId: string }): Promise<void> {
    const selectedUser = await this.#pool.query<Pick<UserRow, 'status'>>(
      `select status from media_app.users where id = $1`,
      [input.userId],
    )
    assertActiveUser(selectedUser.rows[0])
    const selected = await this.#pool.query(
      `select 1 from media_app.upload_sessions
        where id = $1 and user_id = $2`,
      [input.uploadId, input.userId],
    )
    if (selected.rowCount !== 1) throw uploadError('UPLOAD_NOT_FOUND', 404)
  }

  async preparePart(input: PrepareUploadPartInput): Promise<PreparedUploadPart> {
    const client = await this.#pool.connect()
    let committed = false
    try {
      await client.query('begin')
      const selectedUser = await client.query<Pick<UserRow, 'status'>>(
        `select status from media_app.users where id = $1 for share`,
        [input.userId],
      )
      assertActiveUser(selectedUser.rows[0])
      const selectedMedia = await client.query<PreparedMediaRow>(
        `select m.id as media_id, m.r2_bucket, m.object_key,
                m.declared_content_type, m.canonical_extension
           from media_app.media_objects m
           join media_app.upload_sessions u on u.media_object_id = m.id
          where u.id = $1 and u.user_id = $2
          for update of m`,
        [input.uploadId, input.userId],
      )
      const media = selectedMedia.rows[0]
      if (media === undefined) throw uploadError('UPLOAD_NOT_FOUND', 404)

      const selectedUpload = await client.query<PreparedSessionRow>(
        `select status, r2_upload_id, expected_size_bytes::text,
                expected_part_count, confirmed_size_bytes::text,
                confirmed_part_count, expires_at
           from media_app.upload_sessions
          where id = $1 and media_object_id = $2 and user_id = $3
          for update`,
        [input.uploadId, media.media_id, input.userId],
      )
      const upload = selectedUpload.rows[0]
      if (upload === undefined) throw uploadError('UPLOAD_NOT_FOUND', 404)

      const now = this.#clock.now()
      if (upload.status === 'uploading' && now >= asDate(upload.expires_at)) {
        const expired = await client.query(
          `update media_app.upload_sessions
              set status = 'aborting', abort_reason = 'expired',
                  abort_attempt_count = 0, next_abort_at = $2,
                  last_activity_at = $2
            where id = $1 and status = 'uploading'`,
          [input.uploadId, now],
        )
        if (expired.rowCount !== 1) throw new Error('expired upload was not scheduled for abort')
        await this.#insertPartAudit(client, {
          context: input.context,
          eventType: 'upload.expired',
          uploadId: input.uploadId,
          userId: input.userId,
          metadata: { partNumber: input.partNumber },
        })
        await client.query('commit')
        committed = true
        throw uploadError('UPLOAD_EXPIRED', 410)
      }
      if (upload.status !== 'uploading' || upload.r2_upload_id === null) {
        throw uploadError('UPLOAD_NOT_WRITABLE', 409)
      }

      const selectedPart = await client.query<PreparedPartRow>(
        `select status, expected_size_bytes, actual_size_bytes,
                checksum_sha256, uploaded_at
           from media_app.upload_parts
          where upload_session_id = $1 and part_number = $2
          for update`,
        [input.uploadId, input.partNumber],
      )
      const part = selectedPart.rows[0]
      if (part === undefined) throw uploadError('PART_NUMBER_INVALID', 422)

      if (input.partNumber > 1) {
        const firstPart = await client.query<{ status: string }>(
          `select status from media_app.upload_parts
            where upload_session_id = $1 and part_number = 1`,
          [input.uploadId],
        )
        if (!['uploaded', 'verified'].includes(firstPart.rows[0]?.status ?? '')) {
          throw uploadError('FIRST_PART_REQUIRED', 409)
        }
      }

      const expectedTotalBytes = Number(upload.expected_size_bytes)
      if (!Number.isSafeInteger(expectedTotalBytes)) {
        throw new Error('upload expected size is invalid')
      }
      if (
        (part.status === 'uploaded' || part.status === 'verified') &&
        part.actual_size_bytes === part.expected_size_bytes &&
        part.checksum_sha256 !== null &&
        sameHash(part.checksum_sha256, input.expectedSha256) &&
        part.uploaded_at !== null
      ) {
        const aggregate = await this.#aggregateProgress(client, input.uploadId)
        await client.query('commit')
        committed = true
        return {
          kind: 'replay',
          data: {
            part: {
              partNumber: input.partNumber,
              sizeBytes: part.actual_size_bytes,
              sha256: part.checksum_sha256.toString('hex'),
              status: 'uploaded',
              uploadedAt: asDate(part.uploaded_at).toISOString(),
            },
            progress: detailedProgress({
              confirmedBytes: aggregate.confirmedBytes,
              totalBytes: expectedTotalBytes,
              uploadedParts: aggregate.confirmedParts,
              totalParts: upload.expected_part_count,
            }),
            replayed: true,
          },
        }
      }
      if (part.status === 'verified') throw uploadError('UPLOAD_NOT_WRITABLE', 409)

      await client.query('commit')
      committed = true
      return {
        kind: 'ready',
        part: {
          uploadId: input.uploadId,
          mediaId: media.media_id,
          userId: input.userId,
          partNumber: input.partNumber,
          bucket: media.r2_bucket,
          objectKey: media.object_key,
          r2UploadId: upload.r2_upload_id,
          expectedSizeBytes: part.expected_size_bytes,
          expectedTotalBytes,
          expectedPartCount: upload.expected_part_count,
          mimeType: media.declared_content_type,
          canonicalExtension: media.canonical_extension,
        },
      }
    } catch (error) {
      if (!committed) await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async confirmPart(input: ConfirmUploadPartInput): Promise<UploadPartResponse['data']> {
    const client = await this.#pool.connect()
    const now = this.#clock.now()
    try {
      await client.query('begin')
      const selectedUser = await client.query<Pick<UserRow, 'status'>>(
        `select status from media_app.users where id = $1 for share`,
        [input.prepared.userId],
      )
      assertActiveUser(selectedUser.rows[0])
      const media = await client.query(
        `select id from media_app.media_objects
          where id = $1 and user_id = $2
          for update`,
        [input.prepared.mediaId, input.prepared.userId],
      )
      if (media.rowCount !== 1) throw uploadError('UPLOAD_NOT_FOUND', 404)

      const upload = await client.query<{ status: string }>(
        `select status from media_app.upload_sessions
          where id = $1 and media_object_id = $2 and user_id = $3
          for update`,
        [input.prepared.uploadId, input.prepared.mediaId, input.prepared.userId],
      )
      if (upload.rows[0]?.status !== 'uploading') {
        throw uploadError('UPLOAD_NOT_WRITABLE', 409)
      }

      const part = await client.query<{ expected_size_bytes: number; status: string }>(
        `select expected_size_bytes, status from media_app.upload_parts
          where upload_session_id = $1 and part_number = $2
          for update`,
        [input.prepared.uploadId, input.prepared.partNumber],
      )
      if (part.rows[0]?.expected_size_bytes !== input.prepared.expectedSizeBytes) {
        throw uploadError('PART_NUMBER_INVALID', 422)
      }
      if (part.rows[0].status === 'verified') throw uploadError('UPLOAD_NOT_WRITABLE', 409)

      const updated = await client.query(
        `update media_app.upload_parts
            set status = 'uploaded', actual_size_bytes = $3,
                checksum_sha256 = $4, r2_etag = $5,
                attempt_count = attempt_count + 1, uploaded_at = $6,
                verified_at = null
          where upload_session_id = $1 and part_number = $2
            and status <> 'verified'`,
        [
          input.prepared.uploadId,
          input.prepared.partNumber,
          input.actualSizeBytes,
          input.checksumSha256,
          input.etag,
          now,
        ],
      )
      if (updated.rowCount !== 1) throw uploadError('UPLOAD_NOT_WRITABLE', 409)

      const aggregate = await this.#aggregateProgress(client, input.prepared.uploadId)
      const updatedUpload = await client.query(
        `update media_app.upload_sessions
            set confirmed_size_bytes = $2, confirmed_part_count = $3,
                last_activity_at = $4
          where id = $1 and status = 'uploading'`,
        [input.prepared.uploadId, aggregate.confirmedBytes, aggregate.confirmedParts, now],
      )
      if (updatedUpload.rowCount !== 1) throw uploadError('UPLOAD_NOT_WRITABLE', 409)
      await this.#insertPartAudit(client, {
        context: input.context,
        eventType: 'upload.part_uploaded',
        uploadId: input.prepared.uploadId,
        userId: input.prepared.userId,
        metadata: {
          partNumber: input.prepared.partNumber,
          sizeBytes: input.actualSizeBytes,
        },
      })
      await client.query('commit')
      return {
        part: {
          partNumber: input.prepared.partNumber,
          sizeBytes: input.actualSizeBytes,
          sha256: input.checksumSha256.toString('hex'),
          status: 'uploaded',
          uploadedAt: now.toISOString(),
        },
        progress: detailedProgress({
          confirmedBytes: aggregate.confirmedBytes,
          totalBytes: input.prepared.expectedTotalBytes,
          uploadedParts: aggregate.confirmedParts,
          totalParts: input.prepared.expectedPartCount,
        }),
        replayed: false,
      }
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async scheduleValidationAbort(input: ScheduleValidationAbortInput): Promise<void> {
    const client = await this.#pool.connect()
    const now = this.#clock.now()
    try {
      await client.query('begin')
      const user = await client.query(`select id from media_app.users where id = $1 for share`, [
        input.prepared.userId,
      ])
      if (user.rowCount !== 1) throw uploadError('UPLOAD_NOT_FOUND', 404)
      const media = await client.query(
        `select id from media_app.media_objects
          where id = $1 and user_id = $2
          for update`,
        [input.prepared.mediaId, input.prepared.userId],
      )
      if (media.rowCount !== 1) throw uploadError('UPLOAD_NOT_FOUND', 404)
      const upload = await client.query<{ abort_reason: string | null; status: string }>(
        `select status, abort_reason from media_app.upload_sessions
          where id = $1 and media_object_id = $2 and user_id = $3
          for update`,
        [input.prepared.uploadId, input.prepared.mediaId, input.prepared.userId],
      )
      const state = upload.rows[0]
      if (state?.status === 'aborting' && state.abort_reason === 'validationFailed') {
        await client.query('commit')
        return
      }
      if (state?.status !== 'uploading') throw uploadError('UPLOAD_NOT_WRITABLE', 409)

      const scheduled = await client.query(
        `update media_app.upload_sessions
            set status = 'aborting', abort_reason = 'validationFailed',
                abort_attempt_count = 0, next_abort_at = $2,
                failure_code = $3, last_activity_at = $2
          where id = $1 and status = 'uploading'`,
        [input.prepared.uploadId, now, input.failureCode],
      )
      if (scheduled.rowCount !== 1) throw new Error('validation abort was not scheduled')
      await this.#insertPartAudit(client, {
        context: input.context,
        eventType: 'upload.validation_failed',
        uploadId: input.prepared.uploadId,
        userId: input.prepared.userId,
        metadata: { code: input.failureCode, partNumber: input.prepared.partNumber },
      })
      await client.query('commit')
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async getDetail(input: {
    userId: string
    uploadId: string
  }): Promise<UploadDetailResponse['data']> {
    const client = await this.#pool.connect()
    try {
      await client.query('begin isolation level repeatable read read only')
      const selectedUser = await client.query<Pick<UserRow, 'status'>>(
        `select status from media_app.users where id = $1`,
        [input.userId],
      )
      assertActiveUser(selectedUser.rows[0])
      const selected = await client.query<UploadDetailRow>(
        `select u.id as upload_id, u.media_object_id as media_id,
              u.status as upload_status, m.storage_status as media_status,
              m.original_filename, m.kind, m.declared_content_type,
              u.expected_size_bytes::text, u.expected_part_count,
              coalesce(a.confirmed_size_bytes, 0)::text as confirmed_size_bytes,
              coalesce(a.confirmed_part_count, 0)::integer as confirmed_part_count,
              u.expires_at, u.failure_code, u.failed_at, u.created_at,
              greatest(u.updated_at, m.updated_at, u.last_activity_at) as updated_at
         from media_app.upload_sessions u
         join media_app.media_objects m on m.id = u.media_object_id
         left join lateral (
           select coalesce(sum(p.actual_size_bytes), 0) as confirmed_size_bytes,
                  count(*)::integer as confirmed_part_count
             from media_app.upload_parts p
            where p.upload_session_id = u.id
              and p.status in ('uploaded', 'verified')
         ) a on true
        where u.id = $1 and u.user_id = $2`,
        [input.uploadId, input.userId],
      )
      const row = selected.rows[0]
      if (row === undefined) throw uploadError('UPLOAD_NOT_FOUND', 404)
      const selectedParts = await client.query<UploadDetailPartRow>(
        `select part_number, offset_bytes::text, expected_size_bytes,
              status, checksum_sha256
         from media_app.upload_parts
        where upload_session_id = $1
        order by part_number`,
        [input.uploadId],
      )
      const totalBytes = Number(row.expected_size_bytes)
      const confirmedBytes = Number(row.confirmed_size_bytes)
      if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(confirmedBytes)) {
        throw new Error('upload progress is invalid')
      }
      const status = publicUploadStatus(row.upload_status, row.media_status)
      const common = {
        id: row.upload_id,
        mediaId: row.media_id,
        status,
        fileName: row.original_filename,
        sizeBytes: totalBytes,
        progress: detailedProgress({
          confirmedBytes,
          totalBytes,
          uploadedParts: row.confirmed_part_count,
          totalParts: row.expected_part_count,
        }),
        expiresAt: asDate(row.expires_at).toISOString(),
        failure: publicFailure(status, row.failure_code, row.failed_at),
        createdAt: asDate(row.created_at).toISOString(),
        updatedAt: asDate(row.updated_at).toISOString(),
      }
      const upload =
        row.kind === 'image'
          ? {
              ...common,
              kind: row.kind,
              mimeType: row.declared_content_type as Extract<
                InitializeUploadRequest,
                { kind: 'image' }
              >['mimeType'],
            }
          : {
              ...common,
              kind: row.kind,
              mimeType: row.declared_content_type as Extract<
                InitializeUploadRequest,
                { kind: 'video' }
              >['mimeType'],
            }
      const data: UploadDetailResponse['data'] = {
        upload,
        partDetailsRetained: true,
        partsAvailableUntil: null,
        parts: selectedParts.rows.map((part) => ({
          partNumber: part.part_number,
          offsetBytes: Number(part.offset_bytes),
          sizeBytes: part.expected_size_bytes,
          status: part.status,
          sha256: part.checksum_sha256?.toString('hex') ?? null,
        })),
        pollAfterSeconds: ['uploading', 'finalizing', 'cancelling'].includes(status) ? 2 : null,
      }
      await client.query('commit')
      return data
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async #aggregateProgress(
    client: PoolClient,
    uploadId: string,
  ): Promise<{ confirmedBytes: number; confirmedParts: number }> {
    const aggregate = await client.query<{
      confirmed_bytes: string
      confirmed_parts: number
    }>(
      `select coalesce(sum(actual_size_bytes), 0)::text as confirmed_bytes,
              count(*)::integer as confirmed_parts
         from media_app.upload_parts
        where upload_session_id = $1 and status in ('uploaded', 'verified')`,
      [uploadId],
    )
    const confirmedBytes = Number(aggregate.rows[0]?.confirmed_bytes ?? 0)
    const confirmedParts = aggregate.rows[0]?.confirmed_parts ?? 0
    if (!Number.isSafeInteger(confirmedBytes) || !Number.isSafeInteger(confirmedParts)) {
      throw new Error('upload part aggregate is invalid')
    }
    return { confirmedBytes, confirmedParts }
  }

  async #insertPartAudit(
    client: PoolClient,
    input: {
      context: PartRequestContext
      eventType: string
      uploadId: string
      userId: string
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
        input.userId,
        input.context.sessionId,
        input.context.requestId,
        input.eventType,
        input.uploadId,
        input.context.sourceIp,
        JSON.stringify(input.metadata),
      ],
    )
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
