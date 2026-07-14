import type { Pool, QueryResult } from 'pg'

import type { Clock } from '../lib/clock.js'
import { systemClock } from '../lib/clock.js'

const DAY_MS = 86_400_000
const IDEMPOTENCY_RETENTION_DAYS = 7
const UPLOAD_PART_RETENTION_DAYS = 90
const USER_SESSION_RETENTION_DAYS = 90
const AUDIT_RETENTION_DAYS = 365
const MAX_BATCH_SIZE = 5_000
const MAX_UPLOAD_GROUPS_PER_BATCH = 200

export interface RetentionCleanerDependencies {
  pool: Pool
  clock?: Clock
}

export interface RetentionCleanupResult {
  idempotencyRecords: number
  uploadParts: number
  uploadsWhosePartsWereDeleted: number
  userSessions: number
  auditEvents: number
}

interface DeletedPartRow {
  upload_session_id: string
}

function cutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * DAY_MS)
}

function rowCount(result: QueryResult): number {
  return result.rowCount ?? 0
}

function assertBatchSize(batchSize: number): void {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new RangeError('retention batch size must be between 1 and 5000')
  }
}

export class RetentionCleaner {
  readonly #pool: Pool
  readonly #clock: Clock

  constructor(dependencies: RetentionCleanerDependencies) {
    this.#pool = dependencies.pool
    this.#clock = dependencies.clock ?? systemClock
  }

  async runOnce(batchSize = MAX_BATCH_SIZE): Promise<RetentionCleanupResult> {
    assertBatchSize(batchSize)
    const now = this.#clock.now()
    if (Number.isNaN(now.getTime())) throw new Error('retention clock returned an invalid date')

    const auditEvents = await this.#deleteAuditEvents(cutoff(now, AUDIT_RETENTION_DAYS), batchSize)
    const idempotencyRecords = await this.#deleteStableIdempotency(batchSize, now)
    const parts = await this.#deleteTerminalUploadParts(
      cutoff(now, UPLOAD_PART_RETENTION_DAYS),
      batchSize,
    )
    const userSessions = await this.#deleteUserSessions(
      cutoff(now, USER_SESSION_RETENTION_DAYS),
      batchSize,
    )

    return {
      idempotencyRecords,
      uploadParts: parts.rows,
      uploadsWhosePartsWereDeleted: parts.uploads,
      userSessions,
      auditEvents,
    }
  }

  async #deleteStableIdempotency(batchSize: number, now: Date): Promise<number> {
    const result = await this.#pool.query(
      `with candidates as materialized (
         select id
           from media_app.idempotency_records
          where status in ('completed', 'failed')
            and expires_at < $1
          order by expires_at, id
          limit $2
       )
       delete from media_app.idempotency_records records
       using candidates
       where records.id = candidates.id`,
      [now, batchSize],
    )
    return rowCount(result)
  }

  async #deleteTerminalUploadParts(
    terminalCutoff: Date,
    batchSize: number,
  ): Promise<{ rows: number; uploads: number }> {
    const result = await this.#pool.query<DeletedPartRow>(
      `with candidates as materialized (
         select uploads.id,
                case uploads.status
                  when 'completed' then uploads.completed_at
                  when 'aborted' then uploads.aborted_at
                  when 'expired' then uploads.expired_at
                  when 'failed' then uploads.failed_at
                end as terminal_at,
                (
                  select count(parts.upload_session_id)::integer
                    from media_app.upload_parts parts
                   where parts.upload_session_id = uploads.id
                ) as part_count
           from media_app.upload_sessions uploads
          where uploads.status in ('completed', 'aborted', 'expired', 'failed')
            and case uploads.status
                  when 'completed' then uploads.completed_at
                  when 'aborted' then uploads.aborted_at
                  when 'expired' then uploads.expired_at
                  when 'failed' then uploads.failed_at
                end < $1
            and exists (
              select parts.upload_session_id
                from media_app.upload_parts parts
               where parts.upload_session_id = uploads.id
            )
          order by terminal_at, uploads.id
          limit $3
       ), budgeted as materialized (
         select id, terminal_at, part_count,
                sum(part_count) over (order by terminal_at, id) as running_part_count
           from candidates
       ), selected as (
         select id
           from budgeted
          where running_part_count <= $2
       )
       delete from media_app.upload_parts parts
       using selected
       where parts.upload_session_id = selected.id
       returning parts.upload_session_id::text as upload_session_id`,
      [terminalCutoff, batchSize, MAX_UPLOAD_GROUPS_PER_BATCH],
    )
    const uploadIds = new Set(result.rows.map((row) => row.upload_session_id))
    return { rows: rowCount(result), uploads: uploadIds.size }
  }

  async #deleteUserSessions(sessionCutoff: Date, batchSize: number): Promise<number> {
    const result = await this.#pool.query(
      `with candidates as materialized (
         select id
           from media_app.user_sessions
          where expires_at < $1
             or revoked_at < $1
          order by least(expires_at, coalesce(revoked_at, expires_at)), id
          limit $2
       )
       delete from media_app.user_sessions sessions
       using candidates
       where sessions.id = candidates.id`,
      [sessionCutoff, batchSize],
    )
    return rowCount(result)
  }

  async #deleteAuditEvents(auditCutoff: Date, batchSize: number): Promise<number> {
    const result = await this.#pool.query(
      `with candidates as materialized (
         select id
           from media_app.audit_events
          where occurred_at < $1
          order by occurred_at, id
          limit $2
       )
       delete from media_app.audit_events events
       using candidates
       where events.id = candidates.id`,
      [auditCutoff, batchSize],
    )
    return rowCount(result)
  }
}

export const retentionPolicy = Object.freeze({
  idempotencyDays: IDEMPOTENCY_RETENTION_DAYS,
  uploadPartDays: UPLOAD_PART_RETENTION_DAYS,
  userSessionDays: USER_SESSION_RETENTION_DAYS,
  auditDays: AUDIT_RETENTION_DAYS,
  maximumBatchSize: MAX_BATCH_SIZE,
  maximumUploadGroupsPerBatch: MAX_UPLOAD_GROUPS_PER_BATCH,
})
