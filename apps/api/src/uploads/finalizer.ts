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

type FinalizerOutcome = 'failed' | 'ignored' | 'repaired' | 'retried' | 'succeeded'

interface FinalizerRow {
  upload_id: string
  media_id: string
  user_id: string
  status: 'completing'
  row_version: string
  r2_upload_id: string
  expected_size_bytes: string
  expected_part_count: number
  expires_at: Date | string
  finalize_attempt_count: number
  media_status: string
  r2_bucket: string
  object_key: string
  declared_content_type: string
}

interface FinalizerPartRow {
  part_number: number
  status: 'pending' | 'uploaded' | 'verified'
  expected_size_bytes: number
  actual_size_bytes: number | null
  r2_etag: string | null
}

interface FinalizerWork {
  row: FinalizerRow
  parts: FinalizerPartRow[]
}

export interface FinalizerAlertSink {
  criticalReconciliation(code: 'STORAGE_OBJECT_SIZE_MISMATCH' | 'STORAGE_UNAVAILABLE'): void
}

export interface FinalizerRunResult {
  claimed: number
  failed: number
  repaired: number
  retried: number
  succeeded: number
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function rollback(client: PoolClient): Promise<void> {
  return client.query('rollback').then(
    () => undefined,
    () => undefined,
  )
}

function validLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new RangeError(`finalizer limit must be between 1 and ${String(MAX_BATCH_SIZE)}`)
  }
}

function safeStorageCode(error: unknown): ObjectStorageErrorCode | 'UPLOAD_BUSY' | 'UNKNOWN' {
  if (error instanceof ObjectStorageError) return error.code
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    Reflect.get(error, 'code') === 'UPLOAD_BUSY'
  ) {
    return 'UPLOAD_BUSY'
  }
  return 'UNKNOWN'
}

function definitiveMissing(error: unknown): boolean {
  return (
    error instanceof ObjectStorageError &&
    error.certainty === 'definite' &&
    error.code === 'NOT_FOUND'
  )
}

function uploadBusy(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'UPLOAD_BUSY'
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

function rowVersion(value: string): bigint {
  const parsed = BigInt(value)
  if (parsed < 0n) throw new Error('upload row version is invalid')
  return parsed
}

export class Finalizer {
  readonly #pool: Pool
  readonly #storage: ObjectStorage
  readonly #concurrency: ExclusiveUploadConcurrency
  readonly #clock: Clock
  readonly #ids: IdGenerator
  readonly #alerts: FinalizerAlertSink
  readonly #random: () => number
  readonly #operationTimeoutMs: number

  constructor(input: {
    pool: Pool
    storage: ObjectStorage
    concurrency: ExclusiveUploadConcurrency
    clock: Clock
    ids: IdGenerator
    alerts: FinalizerAlertSink
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
      throw new RangeError('finalizer operation timeout must be shorter than its processing lease')
    }
  }

  async runOnce(limit: number, signal?: AbortSignal): Promise<FinalizerRunResult> {
    validLimit(limit)
    const result: FinalizerRunResult = {
      claimed: 0,
      failed: 0,
      repaired: 0,
      retried: 0,
      succeeded: 0,
    }
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
        where status = 'completing' and next_finalize_at <= $1
        order by next_finalize_at, id
        limit $2`,
      [this.#clock.now(), limit],
    )
    return selected.rows.map((row) => row.id)
  }

  async #claim(uploadId: string): Promise<bigint | undefined> {
    const now = this.#clock.now()
    const claimed = await this.#pool.query<{ row_version: string }>(
      `update media_app.upload_sessions
          set finalize_attempt_count = finalize_attempt_count + 1,
              next_finalize_at = $2
        where id = $1 and status = 'completing' and next_finalize_at <= $3
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
  ): Promise<FinalizerOutcome> {
    const work = await this.#loadWork(uploadId, claimedVersion)
    if (work === undefined) return 'ignored'

    let object: Awaited<ReturnType<ObjectStorage['headObject']>>
    try {
      object = await this.#storageCall(
        (operationSignal) =>
          this.#storage.headObject({
            bucket: work.row.r2_bucket,
            key: work.row.object_key,
            signal: operationSignal,
          }),
        signal,
      )
    } catch (error) {
      return (await this.#scheduleRetry(work, safeStorageCode(error))) ? 'retried' : 'ignored'
    }

    if (object !== null) return this.#settleHead(work, object)

    let r2Parts: Awaited<ReturnType<ObjectStorage['listParts']>>
    try {
      r2Parts = await this.#storageCall(
        (operationSignal) =>
          this.#storage.listParts({
            bucket: work.row.r2_bucket,
            key: work.row.object_key,
            uploadId: work.row.r2_upload_id,
            signal: operationSignal,
          }),
        signal,
      )
    } catch (error) {
      if (definitiveMissing(error)) {
        return (await this.#settleFailure(work, 'STORAGE_UNAVAILABLE')) ? 'failed' : 'ignored'
      }
      return (await this.#scheduleRetry(work, safeStorageCode(error))) ? 'retried' : 'ignored'
    }

    const mismatched = this.#mismatchedParts(work, r2Parts)
    if (mismatched.length > 0) {
      const changed =
        this.#clock.now().getTime() >= asDate(work.row.expires_at).getTime()
          ? await this.#scheduleExpiredAbort(work)
          : await this.#repairParts(work, mismatched)
      return changed ? 'repaired' : 'ignored'
    }

    let completionEtag: string | undefined
    try {
      const completed = await this.#storageCall(
        (operationSignal) =>
          this.#storage.completeMultipart({
            bucket: work.row.r2_bucket,
            key: work.row.object_key,
            uploadId: work.row.r2_upload_id,
            parts: work.parts.map((part) => {
              if (part.r2_etag === null) throw new Error('persisted part ETag is missing')
              return { partNumber: part.part_number, etag: part.r2_etag }
            }),
            signal: operationSignal,
          }),
        signal,
      )
      completionEtag = completed.etag
    } catch {
      // A failed Complete response does not establish whether R2 created the object.
      // The mandatory HEAD below is the only safe convergence fact.
    }

    try {
      object = await this.#storageCall(
        (operationSignal) =>
          this.#storage.headObject({
            bucket: work.row.r2_bucket,
            key: work.row.object_key,
            signal: operationSignal,
          }),
        signal,
      )
    } catch (error) {
      return (await this.#scheduleRetry(work, safeStorageCode(error))) ? 'retried' : 'ignored'
    }
    if (object === null) {
      return (await this.#scheduleRetry(work, 'NOT_FOUND')) ? 'retried' : 'ignored'
    }
    return this.#settleHead(work, {
      ...object,
      ...(object.etag === undefined && completionEtag !== undefined
        ? { etag: completionEtag }
        : {}),
    })
  }

  async #loadWork(uploadId: string, claimedVersion: bigint): Promise<FinalizerWork | undefined> {
    const selected = await this.#pool.query<FinalizerRow>(
      `select u.id as upload_id, u.media_object_id as media_id, u.user_id, u.status,
              u.row_version::text, u.r2_upload_id, u.expected_size_bytes::text,
              u.expected_part_count, u.expires_at, u.finalize_attempt_count,
              m.storage_status as media_status, m.r2_bucket, m.object_key,
              m.declared_content_type
         from media_app.upload_sessions u
         join media_app.media_objects m on m.id = u.media_object_id
        where u.id = $1 and u.status = 'completing' and u.row_version = $2`,
      [uploadId, claimedVersion.toString()],
    )
    const row = selected.rows[0]
    if (row === undefined) return undefined
    const selectedParts = await this.#pool.query<FinalizerPartRow>(
      `select part_number, status, expected_size_bytes, actual_size_bytes, r2_etag
         from media_app.upload_parts
        where upload_session_id = $1
        order by part_number`,
      [uploadId],
    )
    return { row, parts: selectedParts.rows }
  }

  async #settleHead(
    work: FinalizerWork,
    object: NonNullable<Awaited<ReturnType<ObjectStorage['headObject']>>>,
  ): Promise<FinalizerOutcome> {
    if (object.sizeBytes !== Number(work.row.expected_size_bytes)) {
      if (!(await this.#settleFailure(work, 'STORAGE_OBJECT_SIZE_MISMATCH'))) return 'ignored'
      this.#alerts.criticalReconciliation('STORAGE_OBJECT_SIZE_MISMATCH')
      return 'failed'
    }
    const objectMediaId = object.metadata?.mediaId
    const objectUserId = object.metadata?.userId
    const metadataMatches = objectMediaId === work.row.media_id && objectUserId === work.row.user_id
    if (object.contentType !== work.row.declared_content_type || !metadataMatches) {
      if (!(await this.#settleFailure(work, 'STORAGE_UNAVAILABLE'))) return 'ignored'
      this.#alerts.criticalReconciliation('STORAGE_UNAVAILABLE')
      return 'failed'
    }
    if (object.etag === undefined) {
      return (await this.#scheduleRetry(work, 'PROTOCOL_ERROR')) ? 'retried' : 'ignored'
    }
    return (await this.#settleSuccess(work, object.etag)) ? 'succeeded' : 'ignored'
  }

  #mismatchedParts(
    work: FinalizerWork,
    r2Parts: Awaited<ReturnType<ObjectStorage['listParts']>>,
  ): number[] {
    const byNumber = new Map(r2Parts.map((part) => [part.partNumber, part]))
    const mismatched: number[] = []
    for (const part of work.parts) {
      const remote = byNumber.get(part.part_number)
      if (
        (part.status !== 'uploaded' && part.status !== 'verified') ||
        part.actual_size_bytes !== part.expected_size_bytes ||
        part.r2_etag === null ||
        remote?.sizeBytes !== part.expected_size_bytes ||
        remote.etag !== part.r2_etag
      ) {
        mismatched.push(part.part_number)
      }
    }
    if (work.parts.length !== work.row.expected_part_count) {
      for (let partNumber = 1; partNumber <= work.row.expected_part_count; partNumber += 1) {
        if (!work.parts.some((part) => part.part_number === partNumber)) {
          mismatched.push(partNumber)
        }
      }
    }
    return [...new Set(mismatched)].sort((left, right) => left - right)
  }

  async #settleSuccess(work: FinalizerWork, etag: string): Promise<boolean> {
    return this.#transaction(async (client) => {
      if (!(await this.#lockCurrent(client, work))) return false
      const now = this.#clock.now()
      await client.query(
        `update media_app.upload_parts
            set status = 'verified', verified_at = $2
          where upload_session_id = $1`,
        [work.row.upload_id, now],
      )
      const completed = await client.query(
        `update media_app.upload_sessions
            set status = 'completed', completed_at = $3,
                next_finalize_at = null, last_finalize_error_code = null,
                last_finalize_error_at = null
          where id = $1 and status = 'completing' and row_version = $2`,
        [work.row.upload_id, work.row.row_version, now],
      )
      if (completed.rowCount !== 1) throw new Error('finalizer completion CAS failed while locked')
      await client.query(
        `update media_app.media_objects
            set storage_status = 'ready', verified_content_type = declared_content_type,
                verified_size_bytes = declared_size_bytes, object_etag = $2,
                uploaded_at = $3, failed_at = null, failure_code = null
          where id = $1`,
        [work.row.media_id, etag, now],
      )
      await this.#audit(client, work.row.upload_id, 'upload.finalized', {
        outcome: 'uploaded',
      })
      return true
    })
  }

  async #settleFailure(
    work: FinalizerWork,
    code: 'STORAGE_OBJECT_SIZE_MISMATCH' | 'STORAGE_UNAVAILABLE',
  ): Promise<boolean> {
    return this.#transaction(async (client) => {
      if (!(await this.#lockCurrent(client, work))) return false
      const now = this.#clock.now()
      const failed = await client.query(
        `update media_app.upload_sessions
            set status = 'failed', failed_at = $3, failure_code = $4,
                failure_detail = null, next_finalize_at = null,
                last_finalize_error_code = null, last_finalize_error_at = null
          where id = $1 and status = 'completing' and row_version = $2`,
        [work.row.upload_id, work.row.row_version, now, code],
      )
      if (failed.rowCount !== 1) throw new Error('finalizer failure CAS failed while locked')
      await client.query(
        `update media_app.media_objects
            set storage_status = 'failed', failed_at = $2, failure_code = $3
          where id = $1`,
        [work.row.media_id, now, code],
      )
      await this.#audit(client, work.row.upload_id, 'upload.finalization_failed', { code })
      return true
    })
  }

  async #repairParts(work: FinalizerWork, mismatched: number[]): Promise<boolean> {
    return this.#transaction(async (client) => {
      if (!(await this.#lockCurrent(client, work, true))) return false
      const now = this.#clock.now()
      await client.query(
        `update media_app.upload_parts
            set status = 'pending', actual_size_bytes = null,
                checksum_sha256 = null, r2_etag = null,
                uploaded_at = null, verified_at = null
          where upload_session_id = $1 and part_number = any($2::smallint[])`,
        [work.row.upload_id, mismatched],
      )
      const aggregate = await client.query<{
        confirmed_bytes: string
        confirmed_parts: number
      }>(
        `select coalesce(sum(actual_size_bytes), 0)::text as confirmed_bytes,
                count(*)::integer as confirmed_parts
           from media_app.upload_parts
          where upload_session_id = $1 and status in ('uploaded', 'verified')`,
        [work.row.upload_id],
      )
      const progress = aggregate.rows[0]
      if (progress === undefined) throw new Error('upload aggregate is missing')
      const repaired = await client.query(
        `update media_app.upload_sessions
            set status = 'uploading', confirmed_size_bytes = $3,
                confirmed_part_count = $4, finalize_attempt_count = 0,
                next_finalize_at = null, last_finalize_error_code = null,
                last_finalize_error_at = null, last_activity_at = $5
          where id = $1 and status = 'completing' and row_version = $2`,
        [
          work.row.upload_id,
          work.row.row_version,
          progress.confirmed_bytes,
          progress.confirmed_parts,
          now,
        ],
      )
      if (repaired.rowCount !== 1) throw new Error('finalizer repair CAS failed while locked')
      await this.#audit(client, work.row.upload_id, 'upload.finalization_repaired', {
        resetPartNumbers: mismatched,
      })
      return true
    })
  }

  async #scheduleExpiredAbort(work: FinalizerWork): Promise<boolean> {
    return this.#transaction(async (client) => {
      if (!(await this.#lockCurrent(client, work))) return false
      const now = this.#clock.now()
      const scheduled = await client.query(
        `update media_app.upload_sessions
            set status = 'aborting', abort_reason = 'expired',
                abort_attempt_count = 0, next_abort_at = $3,
                last_abort_error_code = null, last_abort_error_at = null,
                next_finalize_at = null, last_finalize_error_code = null,
                last_finalize_error_at = null
          where id = $1 and status = 'completing' and row_version = $2`,
        [work.row.upload_id, work.row.row_version, now],
      )
      if (scheduled.rowCount !== 1) throw new Error('finalizer expiry CAS failed while locked')
      await this.#audit(client, work.row.upload_id, 'upload.expiry_scheduled', {
        source: 'finalizer',
      })
      return true
    })
  }

  async #scheduleRetry(
    work: FinalizerWork,
    code: ObjectStorageErrorCode | 'UPLOAD_BUSY' | 'UNKNOWN',
  ): Promise<boolean> {
    const attempt = Math.max(1, work.row.finalize_attempt_count)
    const exponent = Math.min(18, attempt - 1)
    const cap = Math.min(MAX_RETRY_DELAY_MS, 1_000 * 2 ** exponent)
    const random = this.#random()
    if (!Number.isFinite(random) || random < 0 || random >= 1) {
      throw new Error('finalizer random source must return a value in [0, 1)')
    }
    const delayMs = Math.max(1, Math.floor(random * cap))
    const now = this.#clock.now()
    const scheduled = await this.#pool.query(
      `update media_app.upload_sessions
          set next_finalize_at = $3, last_finalize_error_code = $4,
              last_finalize_error_at = $5
        where id = $1 and status = 'completing' and row_version = $2`,
      [work.row.upload_id, work.row.row_version, new Date(now.getTime() + delayMs), code, now],
    )
    return scheduled.rowCount === 1
  }

  async #lockCurrent(client: PoolClient, work: FinalizerWork, lockParts = false): Promise<boolean> {
    const media = await client.query<{ storage_status: string }>(
      `select storage_status from media_app.media_objects where id = $1 for update`,
      [work.row.media_id],
    )
    if (media.rows[0] === undefined) return false
    const upload = await client.query<{ row_version: string; status: string }>(
      `select status, row_version::text
         from media_app.upload_sessions
        where id = $1 and media_object_id = $2
        for update`,
      [work.row.upload_id, work.row.media_id],
    )
    const current = upload.rows[0]
    if (current?.status !== 'completing') return false
    if (rowVersion(current.row_version) !== rowVersion(work.row.row_version)) return false
    if (lockParts) {
      await client.query(
        `select part_number
           from media_app.upload_parts
          where upload_session_id = $1
          order by part_number
          for update`,
        [work.row.upload_id],
      )
    }
    return true
  }

  async #audit(
    client: PoolClient,
    uploadId: string,
    eventType: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `insert into media_app.audit_events(
         event_id, actor_type, actor_service, event_type,
         entity_type, entity_id, metadata
       ) values ($1, 'system', 'upload-finalizer', $2,
                 'upload_session', $3, $4::jsonb)`,
      [this.#ids.next(), eventType, uploadId, JSON.stringify(metadata)],
    )
  }

  async #transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect()
    try {
      await client.query('begin')
      const result = await action(client)
      await client.query('commit')
      return result
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
