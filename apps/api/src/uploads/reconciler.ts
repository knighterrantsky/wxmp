import type { Pool, PoolClient } from 'pg'

import type { Clock } from '../lib/clock.js'
import type { IdGenerator } from '../lib/id.js'
import { ApiError } from '../http/errors.js'
import { ObjectStorageError, type ObjectStorage } from './object-storage.js'
import type { ExclusiveUploadConcurrency } from './upload-service.js'

const MAX_BATCH_SIZE = 5_000
const SCAN_OVERSAMPLE = 4
const RECONCILIATION_LEASE_MS = 5 * 60 * 1_000
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000
const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

interface ReconciliationSnapshot {
  uploadId: string
  mediaId: string
  userId: string
  bucket: string
  objectKey: string
  expectedSizeBytes: number
  idempotencyKey: string
  idempotencyFence: bigint
}

export interface ReconciliationAlertSink {
  criticalReconciliation(code: 'STORAGE_OBJECT_SIZE_MISMATCH' | 'STORAGE_UNAVAILABLE'): void
}

export interface ReconciliationRunResult {
  claimed: number
  retried: number
  settled: number
}

function rollback(client: PoolClient): Promise<void> {
  return client.query('rollback').then(
    () => undefined,
    () => undefined,
  )
}

function validLimit(limit: number, worker: string): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new RangeError(`${worker} limit must be between 1 and ${String(MAX_BATCH_SIZE)}`)
  }
}

function bigint(value: string): bigint {
  const parsed = BigInt(value)
  if (parsed < 0n) throw new Error('reconciliation fence is invalid')
  return parsed
}

function uploadBusy(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'UPLOAD_BUSY'
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export class Reconciler {
  readonly #pool: Pool
  readonly #storage: ObjectStorage
  readonly #concurrency: ExclusiveUploadConcurrency
  readonly #clock: Clock
  readonly #ids: IdGenerator
  readonly #alerts: ReconciliationAlertSink
  readonly #operationTimeoutMs: number

  constructor(input: {
    pool: Pool
    storage: ObjectStorage
    concurrency: ExclusiveUploadConcurrency
    clock: Clock
    ids: IdGenerator
    alerts: ReconciliationAlertSink
    operationTimeoutMs?: number
  }) {
    this.#pool = input.pool
    this.#storage = input.storage
    this.#concurrency = input.concurrency
    this.#clock = input.clock
    this.#ids = input.ids
    this.#alerts = input.alerts
    this.#operationTimeoutMs = input.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.#operationTimeoutMs) ||
      this.#operationTimeoutMs < 1 ||
      this.#operationTimeoutMs >= RECONCILIATION_LEASE_MS
    ) {
      throw new RangeError('reconciliation operation timeout must be shorter than its lease')
    }
  }

  async runOnce(limit: number, signal?: AbortSignal): Promise<ReconciliationRunResult> {
    validLimit(limit, 'reconciler')
    const result: ReconciliationRunResult = { claimed: 0, retried: 0, settled: 0 }
    const candidates = await this.#candidates(
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
        const snapshot = await this.#claim(uploadId)
        if (snapshot === undefined) continue
        result.claimed += 1
        if (await this.#reconcile(snapshot, signal)) result.settled += 1
        else result.retried += 1
      } finally {
        await lease.release()
      }
    }
    return result
  }

  async #candidates(limit: number): Promise<string[]> {
    const selected = await this.#pool.query<{ id: string }>(
      `select u.id
         from media_app.upload_sessions u
         join media_app.idempotency_records i
           on i.resource_type = 'upload_session' and i.resource_id = u.id
          and i.operation = 'upload.initialize' and i.status = 'in_progress'
        where u.status = 'initiating' and i.locked_until <= $1
        order by i.locked_until, u.id
        limit $2`,
      [this.#clock.now(), limit],
    )
    return selected.rows.map((row) => row.id)
  }

  async #claim(uploadId: string): Promise<ReconciliationSnapshot | undefined> {
    const identity = await this.#pool.query<{ media_object_id: string }>(
      `select media_object_id from media_app.upload_sessions where id = $1`,
      [uploadId],
    )
    const mediaId = identity.rows[0]?.media_object_id
    if (mediaId === undefined) return undefined

    const client = await this.#pool.connect()
    try {
      await client.query('begin')
      const selectedMedia = await client.query<{
        id: string
        user_id: string
        r2_bucket: string
        object_key: string
        declared_size_bytes: string
        storage_status: string
      }>(
        `select id, user_id, r2_bucket, object_key,
                declared_size_bytes::text, storage_status
           from media_app.media_objects
          where id = $1
          for update`,
        [mediaId],
      )
      const media = selectedMedia.rows[0]
      if (media?.storage_status !== 'pending_upload') {
        await client.query('commit')
        return undefined
      }
      const selectedUpload = await client.query<{ status: string }>(
        `select status
           from media_app.upload_sessions
          where id = $1 and media_object_id = $2
          for update`,
        [uploadId, mediaId],
      )
      if (selectedUpload.rows[0]?.status !== 'initiating') {
        await client.query('commit')
        return undefined
      }
      const selectedIdempotency = await client.query<{
        idempotency_key: string
        row_version: string
      }>(
        `select idempotency_key, row_version::text
           from media_app.idempotency_records
          where principal_type = 'user' and principal_id = $1
            and operation = 'upload.initialize' and resource_type = 'upload_session'
            and resource_id = $2 and status = 'in_progress' and locked_until <= $3
          for update`,
        [media.user_id, uploadId, this.#clock.now()],
      )
      const idempotency = selectedIdempotency.rows[0]
      if (idempotency === undefined) {
        await client.query('commit')
        return undefined
      }
      const claimed = await client.query<{ row_version: string }>(
        `update media_app.idempotency_records
            set locked_until = $3
          where principal_type = 'user' and principal_id = $1
            and operation = 'upload.initialize' and idempotency_key = $2
            and status = 'in_progress' and row_version = $4
          returning row_version::text`,
        [
          media.user_id,
          idempotency.idempotency_key,
          new Date(this.#clock.now().getTime() + RECONCILIATION_LEASE_MS),
          idempotency.row_version,
        ],
      )
      const fenceValue = claimed.rows[0]?.row_version
      if (fenceValue === undefined) {
        await client.query('commit')
        return undefined
      }
      await client.query('commit')
      return {
        uploadId,
        mediaId,
        userId: media.user_id,
        bucket: media.r2_bucket,
        objectKey: media.object_key,
        expectedSizeBytes: Number(media.declared_size_bytes),
        idempotencyKey: idempotency.idempotency_key,
        idempotencyFence: bigint(fenceValue),
      }
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async #reconcile(snapshot: ReconciliationSnapshot, signal?: AbortSignal): Promise<boolean> {
    let object: Awaited<ReturnType<ObjectStorage['headObject']>>
    try {
      object = await this.#storageCall(
        (operationSignal) =>
          this.#storage.headObject({
            bucket: snapshot.bucket,
            key: snapshot.objectKey,
            signal: operationSignal,
          }),
        signal,
      )
    } catch (error) {
      this.#alertConfiguration(error)
      return false
    }
    if (object !== null) {
      const code =
        object.sizeBytes === snapshot.expectedSizeBytes
          ? 'STORAGE_UNAVAILABLE'
          : 'STORAGE_OBJECT_SIZE_MISMATCH'
      this.#alerts.criticalReconciliation(code)
      return this.#settle(snapshot, code)
    }

    let uploads: Awaited<ReturnType<ObjectStorage['listMultipartUploads']>>
    try {
      uploads = await this.#list(snapshot, signal)
      for (const upload of uploads.filter((candidate) => candidate.key === snapshot.objectKey)) {
        await this.#storageCall(
          (operationSignal) =>
            this.#storage.abortMultipart({
              bucket: snapshot.bucket,
              key: snapshot.objectKey,
              uploadId: upload.uploadId,
              signal: operationSignal,
            }),
          signal,
        )
      }
      const remaining = (await this.#list(snapshot, signal)).filter(
        (candidate) => candidate.key === snapshot.objectKey,
      )
      if (remaining.length > 0) return false
    } catch (error) {
      this.#alertConfiguration(error)
      return false
    }
    return this.#settle(snapshot, 'STORAGE_UNAVAILABLE')
  }

  #list(snapshot: ReconciliationSnapshot, signal?: AbortSignal) {
    return this.#storageCall(
      (signal) =>
        this.#storage.listMultipartUploads({
          bucket: snapshot.bucket,
          prefix: snapshot.objectKey,
          signal,
        }),
      signal,
    )
  }

  #alertConfiguration(error: unknown): void {
    if (
      error instanceof ObjectStorageError &&
      error.certainty === 'definite' &&
      (error.code === 'ACCESS_DENIED' || error.code === 'INVALID_REQUEST')
    ) {
      this.#alerts.criticalReconciliation('STORAGE_UNAVAILABLE')
    }
  }

  async #settle(
    snapshot: ReconciliationSnapshot,
    code: 'STORAGE_OBJECT_SIZE_MISMATCH' | 'STORAGE_UNAVAILABLE',
  ): Promise<boolean> {
    const client = await this.#pool.connect()
    const now = this.#clock.now()
    try {
      await client.query('begin')
      const media = await client.query<{ storage_status: string }>(
        `select storage_status from media_app.media_objects where id = $1 for update`,
        [snapshot.mediaId],
      )
      if (media.rows[0]?.storage_status !== 'pending_upload') {
        await client.query('commit')
        return false
      }
      const upload = await client.query<{ status: string }>(
        `select status
           from media_app.upload_sessions
          where id = $1 and media_object_id = $2
          for update`,
        [snapshot.uploadId, snapshot.mediaId],
      )
      if (upload.rows[0]?.status !== 'initiating') {
        await client.query('commit')
        return false
      }
      const idempotency = await client.query<{ row_version: string }>(
        `select row_version::text
           from media_app.idempotency_records
          where principal_type = 'user' and principal_id = $1
            and operation = 'upload.initialize' and idempotency_key = $2
            and resource_id = $3 and status = 'in_progress'
          for update`,
        [snapshot.userId, snapshot.idempotencyKey, snapshot.uploadId],
      )
      const currentFence = idempotency.rows[0]?.row_version
      if (currentFence === undefined || bigint(currentFence) !== snapshot.idempotencyFence) {
        await client.query('commit')
        return false
      }
      await client.query(
        `update media_app.upload_sessions
            set status = 'failed', failed_at = $2, failure_code = $3
          where id = $1 and status = 'initiating'`,
        [snapshot.uploadId, now, code],
      )
      await client.query(
        `update media_app.media_objects
            set storage_status = 'failed', failed_at = $2, failure_code = $3
          where id = $1 and storage_status = 'pending_upload'`,
        [snapshot.mediaId, now, code],
      )
      const settled = await client.query(
        `update media_app.idempotency_records
            set status = 'failed', locked_until = null, response_status = 503,
                response_body = $5::jsonb, expires_at = $6
          where principal_type = 'user' and principal_id = $1
            and operation = 'upload.initialize' and idempotency_key = $2
            and resource_id = $3 and status = 'in_progress' and row_version = $4`,
        [
          snapshot.userId,
          snapshot.idempotencyKey,
          snapshot.uploadId,
          snapshot.idempotencyFence.toString(),
          JSON.stringify({ code: 'STORAGE_UNAVAILABLE', retryable: true }),
          new Date(now.getTime() + IDEMPOTENCY_RETENTION_MS),
        ],
      )
      if (settled.rowCount !== 1) throw new Error('initialization reconciliation lost its fence')
      await client.query(
        `insert into media_app.audit_events(
           event_id, actor_type, actor_service, event_type,
           entity_type, entity_id, metadata
         ) values ($1, 'system', 'upload-reconciler',
                   'upload.initialization_reconciled', 'upload_session', $2, $3::jsonb)`,
        [this.#ids.next(), snapshot.uploadId, JSON.stringify({ code })],
      )
      await client.query('commit')
      return true
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

export class DeadlineScanner {
  readonly #pool: Pool
  readonly #clock: Clock
  readonly #ids: IdGenerator

  constructor(input: { pool: Pool; clock: Clock; ids: IdGenerator }) {
    this.#pool = input.pool
    this.#clock = input.clock
    this.#ids = input.ids
  }

  async runOnce(limit: number, signal?: AbortSignal): Promise<{ scheduled: number }> {
    validLimit(limit, 'deadline scanner')
    const candidates = await this.#pool.query<{ id: string; media_object_id: string }>(
      `select id, media_object_id
         from media_app.upload_sessions
        where status in ('initiating', 'uploading') and expires_at <= $1
        order by expires_at, id
        limit $2`,
      [this.#clock.now(), limit],
    )
    let scheduled = 0
    for (const candidate of candidates.rows) {
      if (signal?.aborted === true) break
      if (await this.#schedule(candidate.id, candidate.media_object_id)) scheduled += 1
    }
    return { scheduled }
  }

  async #schedule(uploadId: string, mediaId: string): Promise<boolean> {
    const client = await this.#pool.connect()
    const now = this.#clock.now()
    try {
      await client.query('begin')
      const media = await client.query(
        `select id from media_app.media_objects where id = $1 for update`,
        [mediaId],
      )
      if (media.rowCount !== 1) {
        await client.query('commit')
        return false
      }
      const upload = await client.query<{ status: string; expires_at: Date | string }>(
        `select status, expires_at
           from media_app.upload_sessions
          where id = $1 and media_object_id = $2
          for update`,
        [uploadId, mediaId],
      )
      const row = upload.rows[0]
      if (
        row === undefined ||
        (row.status !== 'initiating' && row.status !== 'uploading') ||
        new Date(row.expires_at).getTime() > now.getTime()
      ) {
        await client.query('commit')
        return false
      }
      await client.query(
        `update media_app.upload_sessions
            set status = 'aborting', abort_reason = 'expired',
                abort_attempt_count = 0, next_abort_at = $2,
                last_abort_error_code = null, last_abort_error_at = null,
                last_activity_at = $2
          where id = $1 and status in ('initiating', 'uploading')`,
        [uploadId, now],
      )
      await client.query(
        `insert into media_app.audit_events(
           event_id, actor_type, actor_service, event_type,
           entity_type, entity_id, metadata
         ) values ($1, 'system', 'upload-deadline-scanner',
                   'upload.expiry_scheduled', 'upload_session', $2, '{}'::jsonb)`,
        [this.#ids.next(), uploadId],
      )
      await client.query('commit')
      return true
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }
}
