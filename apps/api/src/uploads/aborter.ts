import type { Pool, PoolClient } from 'pg'

import type { Clock } from '../lib/clock.js'
import type { IdGenerator } from '../lib/id.js'
import { ApiError } from '../http/errors.js'
import {
  ObjectStorageError,
  type ObjectStorage,
  type ObjectStorageErrorCode,
} from './object-storage.js'
import type { ExclusiveUploadConcurrency } from './upload-service.js'

const MAX_BATCH_SIZE = 5_000
const SCAN_OVERSAMPLE = 4
const PROCESSING_LEASE_MS = 5 * 60 * 1_000
const MAX_RETRY_DELAY_MS = 5 * 60 * 1_000
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

type AbortReason = 'expired' | 'replaced' | 'userCancelled' | 'validationFailed'
type AborterOutcome = 'ignored' | 'retried' | 'succeeded'
type AbortRetryCode = ObjectStorageErrorCode | 'STORAGE_OBJECT_PRESENT' | 'UNKNOWN'

interface AborterRow {
  upload_id: string
  media_id: string
  user_id: string
  status: 'aborting'
  row_version: string
  r2_upload_id: string | null
  abort_reason: AbortReason
  abort_attempt_count: number
  failure_code: string | null
  media_status: string
  r2_bucket: string
  object_key: string
}

export interface AborterAlertSink {
  criticalReconciliation(code: 'ACCESS_DENIED' | 'INVALID_REQUEST' | 'STORAGE_OBJECT_PRESENT'): void
}

export interface AborterRunResult {
  claimed: number
  retried: number
  succeeded: number
}

function rollback(client: PoolClient): Promise<void> {
  return client.query('rollback').then(
    () => undefined,
    () => undefined,
  )
}

function validLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new RangeError(`aborter limit must be between 1 and ${String(MAX_BATCH_SIZE)}`)
  }
}

function rowVersion(value: string): bigint {
  const parsed = BigInt(value)
  if (parsed < 0n) throw new Error('upload row version is invalid')
  return parsed
}

function safeStorageCode(error: unknown): ObjectStorageErrorCode | 'UNKNOWN' {
  return error instanceof ObjectStorageError ? error.code : 'UNKNOWN'
}

function definiteMissing(error: unknown): boolean {
  return (
    error instanceof ObjectStorageError &&
    error.certainty === 'definite' &&
    error.code === 'NOT_FOUND'
  )
}

function criticalStorageCode(
  code: AbortRetryCode,
): 'ACCESS_DENIED' | 'INVALID_REQUEST' | undefined {
  return code === 'ACCESS_DENIED' || code === 'INVALID_REQUEST' ? code : undefined
}

function terminalStatus(reason: AbortReason): 'aborted' | 'expired' | 'failed' {
  if (reason === 'expired') return 'expired'
  if (reason === 'validationFailed') return 'failed'
  return 'aborted'
}

function uploadBusy(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'UPLOAD_BUSY'
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export class Aborter {
  readonly #pool: Pool
  readonly #storage: ObjectStorage
  readonly #concurrency: ExclusiveUploadConcurrency
  readonly #clock: Clock
  readonly #ids: IdGenerator
  readonly #alerts: AborterAlertSink
  readonly #random: () => number
  readonly #operationTimeoutMs: number

  constructor(input: {
    pool: Pool
    storage: ObjectStorage
    concurrency: ExclusiveUploadConcurrency
    clock: Clock
    ids: IdGenerator
    alerts: AborterAlertSink
    random?: () => number
    operationTimeoutMs?: number
  }) {
    this.#pool = input.pool
    this.#storage = input.storage
    this.#concurrency = input.concurrency
    this.#clock = input.clock
    this.#ids = input.ids
    this.#alerts = input.alerts
    this.#random = input.random ?? Math.random
    this.#operationTimeoutMs = input.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.#operationTimeoutMs) ||
      this.#operationTimeoutMs < 1 ||
      this.#operationTimeoutMs >= PROCESSING_LEASE_MS
    ) {
      throw new RangeError('aborter operation timeout must be shorter than its processing lease')
    }
  }

  async runOnce(limit: number, signal?: AbortSignal): Promise<AborterRunResult> {
    validLimit(limit)
    const result: AborterRunResult = { claimed: 0, retried: 0, succeeded: 0 }
    const candidates = await this.#dueCandidates(
      Math.min(MAX_BATCH_SIZE, Math.max(limit, limit * SCAN_OVERSAMPLE)),
    )

    for (const uploadId of candidates) {
      if (result.claimed >= limit || aborted(signal)) break
      let lease: Awaited<ReturnType<ExclusiveUploadConcurrency['acquireExclusiveUpload']>>
      try {
        lease = await this.#concurrency.acquireExclusiveUpload({ uploadId, waitMs: 0 })
      } catch (error) {
        if (uploadBusy(error)) continue
        throw error
      }
      try {
        if (aborted(signal)) continue
        const claimedVersion = await this.#claim(uploadId)
        if (claimedVersion === undefined) continue
        result.claimed += 1
        const outcome = await this.#process(uploadId, claimedVersion, signal)
        if (outcome !== 'ignored') result[outcome] += 1
      } finally {
        await lease.release()
      }
    }
    return result
  }

  async #dueCandidates(limit: number): Promise<string[]> {
    const selected = await this.#pool.query<{ id: string }>(
      `select id
         from media_app.upload_sessions
        where status = 'aborting' and next_abort_at <= $1
        order by next_abort_at, id
        limit $2`,
      [this.#clock.now(), limit],
    )
    return selected.rows.map((row) => row.id)
  }

  async #claim(uploadId: string): Promise<bigint | undefined> {
    const now = this.#clock.now()
    const claimed = await this.#pool.query<{ row_version: string }>(
      `update media_app.upload_sessions
          set abort_attempt_count = abort_attempt_count + 1,
              next_abort_at = $2
        where id = $1 and status = 'aborting' and next_abort_at <= $3
        returning row_version::text`,
      [uploadId, new Date(now.getTime() + PROCESSING_LEASE_MS), now],
    )
    const value = claimed.rows[0]?.row_version
    return value === undefined ? undefined : rowVersion(value)
  }

  async #process(
    uploadId: string,
    claimedVersion: bigint,
    signal?: AbortSignal,
  ): Promise<AborterOutcome> {
    const work = await this.#loadWork(uploadId, claimedVersion)
    if (work === undefined) return 'ignored'

    let cleanup: 'clean' | 'object_present'
    try {
      cleanup = await this.#storageCleanup(work, signal)
    } catch (error) {
      const code = safeStorageCode(error)
      const critical = criticalStorageCode(code)
      if (critical !== undefined) this.#alerts.criticalReconciliation(critical)
      return (await this.#scheduleRetry(work, code, critical !== undefined)) ? 'retried' : 'ignored'
    }

    if (cleanup === 'object_present') {
      this.#alerts.criticalReconciliation('STORAGE_OBJECT_PRESENT')
      return (await this.#scheduleRetry(work, 'STORAGE_OBJECT_PRESENT', true))
        ? 'retried'
        : 'ignored'
    }

    return (await this.#settleSuccess(work)) ? 'succeeded' : 'ignored'
  }

  async #loadWork(uploadId: string, claimedVersion: bigint): Promise<AborterRow | undefined> {
    const selected = await this.#pool.query<AborterRow>(
      `select u.id as upload_id, u.media_object_id as media_id, u.user_id,
              u.status, u.row_version::text, u.r2_upload_id, u.abort_reason,
              u.abort_attempt_count, u.failure_code,
              m.storage_status as media_status, m.r2_bucket, m.object_key
         from media_app.upload_sessions u
         join media_app.media_objects m on m.id = u.media_object_id
        where u.id = $1 and u.status = 'aborting' and u.row_version = $2`,
      [uploadId, claimedVersion.toString()],
    )
    return selected.rows[0]
  }

  async #storageCleanup(
    work: AborterRow,
    externalSignal?: AbortSignal,
  ): Promise<'clean' | 'object_present'> {
    return this.#storageCall(async (signal) => {
      let object: Awaited<ReturnType<ObjectStorage['headObject']>>
      try {
        object = await this.#storage.headObject({
          bucket: work.r2_bucket,
          key: work.object_key,
          signal,
        })
      } catch (error) {
        if (!definiteMissing(error)) throw error
        object = null
      }
      if (object !== null) return 'object_present'

      if (work.r2_upload_id !== null) {
        await this.#abortKnownMultipart(work, work.r2_upload_id, signal)
        return 'clean'
      }

      const uploads = await this.#storage.listMultipartUploads({
        bucket: work.r2_bucket,
        prefix: work.object_key,
        signal,
      })
      for (const upload of uploads) {
        if (upload.key !== work.object_key) continue
        await this.#abortKnownMultipart(work, upload.uploadId, signal)
      }
      return 'clean'
    }, externalSignal)
  }

  async #abortKnownMultipart(
    work: AborterRow,
    uploadId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.#storage.abortMultipart({
        bucket: work.r2_bucket,
        key: work.object_key,
        uploadId,
        signal,
      })
    } catch (error) {
      if (!definiteMissing(error)) throw error
    }
  }

  async #settleSuccess(work: AborterRow): Promise<boolean> {
    let settled = false
    await this.#transaction(async (client) => {
      if (!(await this.#lockCurrent(client, work))) return
      const now = this.#clock.now()
      const status = terminalStatus(work.abort_reason)
      const failureCode =
        work.abort_reason === 'validationFailed' ? (work.failure_code ?? 'VALIDATION_FAILED') : null

      const updatedUpload = await client.query(
        `update media_app.upload_sessions
            set status = $3::media_app.upload_session_status,
                aborted_at = case when $3::text = 'aborted' then $4::timestamptz else null end,
                expired_at = case when $3::text = 'expired' then $4::timestamptz else null end,
                failed_at = case when $3::text = 'failed' then $4::timestamptz else null end,
                failure_code = $5, failure_detail = null,
                next_abort_at = null, last_abort_error_code = null,
                last_abort_error_at = null, last_activity_at = $4
          where id = $1 and status = 'aborting' and row_version = $2`,
        [work.upload_id, work.row_version, status, now, failureCode],
      )
      if (updatedUpload.rowCount !== 1) return

      if (status === 'failed') {
        await client.query(
          `update media_app.media_objects
              set storage_status = 'failed', failed_at = $2, failure_code = $3
            where id = $1`,
          [work.media_id, now, failureCode],
        )
      } else {
        await client.query(
          `update media_app.media_objects
              set storage_status = 'aborted', failed_at = null, failure_code = null
            where id = $1`,
          [work.media_id],
        )
      }

      await client.query(
        `update media_app.idempotency_records
            set status = 'failed', locked_until = null, response_status = 503,
                response_body = $3::jsonb, expires_at = $4
          where principal_type = 'user' and principal_id = $1
            and operation = 'upload.initialize'
            and resource_type = 'upload_session' and resource_id = $2
            and status = 'in_progress'`,
        [
          work.user_id,
          work.upload_id,
          JSON.stringify({ code: 'STORAGE_UNAVAILABLE', retryable: true }),
          new Date(now.getTime() + IDEMPOTENCY_RETENTION_MS),
        ],
      )
      await this.#audit(client, work, status)
      settled = true
    })
    return settled
  }

  async #lockCurrent(client: PoolClient, work: AborterRow): Promise<boolean> {
    const user = await client.query(`select id from media_app.users where id = $1 for share`, [
      work.user_id,
    ])
    if (user.rowCount !== 1) return false
    const media = await client.query<{ storage_status: string }>(
      `select storage_status
         from media_app.media_objects
        where id = $1 and user_id = $2
        for update`,
      [work.media_id, work.user_id],
    )
    if (media.rows[0]?.storage_status !== work.media_status) return false
    const upload = await client.query<{
      abort_reason: AbortReason
      row_version: string
      status: string
    }>(
      `select status, abort_reason, row_version::text
         from media_app.upload_sessions
        where id = $1 and media_object_id = $2 and user_id = $3
        for update`,
      [work.upload_id, work.media_id, work.user_id],
    )
    const current = upload.rows[0]
    if (
      current?.status !== 'aborting' ||
      current.abort_reason !== work.abort_reason ||
      rowVersion(current.row_version) !== rowVersion(work.row_version)
    ) {
      return false
    }
    await client.query(
      `select id
         from media_app.idempotency_records
        where principal_type = 'user' and principal_id = $1
          and operation = 'upload.initialize'
          and resource_type = 'upload_session' and resource_id = $2
        order by id
        for update`,
      [work.user_id, work.upload_id],
    )
    return true
  }

  async #scheduleRetry(
    work: AborterRow,
    code: AbortRetryCode,
    fixedCriticalDelay: boolean,
  ): Promise<boolean> {
    let delayMs = MAX_RETRY_DELAY_MS
    if (!fixedCriticalDelay) {
      const attempt = Math.max(1, work.abort_attempt_count)
      const exponent = Math.min(18, attempt - 1)
      const cap = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** exponent)
      const random = this.#random()
      if (!Number.isFinite(random) || random < 0 || random >= 1) {
        throw new Error('aborter random source must return a value in [0, 1)')
      }
      delayMs = Math.max(1, Math.floor(random * cap))
    }
    const now = this.#clock.now()
    const updated = await this.#pool.query(
      `update media_app.upload_sessions
          set next_abort_at = $3, last_abort_error_code = $4,
              last_abort_error_at = $5
        where id = $1 and status = 'aborting' and row_version = $2`,
      [work.upload_id, work.row_version, new Date(now.getTime() + delayMs), code, now],
    )
    return updated.rowCount === 1
  }

  async #audit(
    client: PoolClient,
    work: AborterRow,
    status: 'aborted' | 'expired' | 'failed',
  ): Promise<void> {
    const eventType =
      status === 'aborted'
        ? 'upload.aborted'
        : status === 'expired'
          ? 'upload.expired'
          : 'upload.validation_cleanup_completed'
    await client.query(
      `insert into media_app.audit_events(
         event_id, actor_type, actor_service, event_type,
         entity_type, entity_id, metadata
       ) values ($1, 'system', 'upload-aborter', $2,
                 'upload_session', $3, $4::jsonb)`,
      [
        this.#ids.next(),
        eventType,
        work.upload_id,
        JSON.stringify({ reason: work.abort_reason, terminalStatus: status }),
      ],
    )
  }

  async #transaction(action: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await this.#pool.connect()
    try {
      await client.query('begin')
      await action(client)
      await client.query('commit')
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async #storageCall<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const controller = new AbortController()
    const abort = (): void => {
      controller.abort()
    }
    externalSignal?.addEventListener('abort', abort, { once: true })
    if (externalSignal?.aborted === true) abort()
    const timeout = setTimeout(() => {
      controller.abort()
    }, this.#operationTimeoutMs)
    timeout.unref()
    try {
      return await operation(controller.signal)
    } finally {
      clearTimeout(timeout)
      externalSignal?.removeEventListener('abort', abort)
    }
  }
}
