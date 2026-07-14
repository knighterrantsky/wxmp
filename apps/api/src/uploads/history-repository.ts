import type { AllowedMimeType, MediaKind, PublicUploadStatus } from '@wx-upload/contracts'
import type { Pool, PoolClient } from 'pg'

import type { HistoryCursorPosition } from './cursor.js'
import { type MediaStorageStatus, type UploadSessionStatus } from './public-status.js'

export type HistoryUserStatus = 'active' | 'disabled' | 'deleted'

export interface HistoryRepositoryRecord {
  readonly uploadId: string
  readonly mediaId: string
  readonly uploadStatus: UploadSessionStatus
  readonly mediaStatus: MediaStorageStatus
  readonly fileName: string
  readonly kind: MediaKind
  readonly mimeType: AllowedMimeType
  readonly sizeBytes: number
  readonly confirmedBytes: number
  readonly failureCode: string | null
  readonly failedAt: Date | null
  readonly createdAt: Date
  readonly updatedAt: Date
}

export interface HistoryRepositoryPage {
  readonly userStatus: HistoryUserStatus | null
  readonly rows: readonly HistoryRepositoryRecord[]
}

export interface HistoryRepositoryPageInput {
  readonly userId: string
  readonly status: PublicUploadStatus | null
  readonly after: HistoryCursorPosition | null
  readonly take: number
}

export interface UploadHistoryRepository {
  listPage(input: HistoryRepositoryPageInput): Promise<HistoryRepositoryPage>
}

interface HistoryRow {
  upload_id: string
  media_id: string
  upload_status: string
  media_status: string
  original_filename: string
  kind: string
  declared_content_type: string
  expected_size_bytes: string | number
  confirmed_size_bytes: string | number
  failure_code: string | null
  failed_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

const UPLOAD_STATUSES = new Set<UploadSessionStatus>([
  'initiating',
  'uploading',
  'completing',
  'completed',
  'aborting',
  'aborted',
  'expired',
  'failed',
])
const MEDIA_STATUSES = new Set<MediaStorageStatus>([
  'pending_upload',
  'ready',
  'failed',
  'aborted',
  'purged',
])
const MEDIA_KINDS = new Set<MediaKind>(['image', 'video'])
const MIME_TYPES = new Set<AllowedMimeType>([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
  'video/mp4',
  'video/quicktime',
])

function asDate(value: Date | string, field: string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`history ${field} is invalid`)
  return date
}

function asSafeInteger(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error(`history ${field} is invalid`)
  return parsed
}

function enumValue<T extends string>(value: string, values: ReadonlySet<T>, field: string): T {
  if (!values.has(value as T)) throw new Error(`history ${field} is invalid`)
  return value as T
}

function repositoryRecord(row: HistoryRow): HistoryRepositoryRecord {
  const failedAt = row.failed_at === null ? null : asDate(row.failed_at, 'failedAt')
  return {
    uploadId: row.upload_id,
    mediaId: row.media_id,
    uploadStatus: enumValue(row.upload_status, UPLOAD_STATUSES, 'uploadStatus'),
    mediaStatus: enumValue(row.media_status, MEDIA_STATUSES, 'mediaStatus'),
    fileName: row.original_filename,
    kind: enumValue(row.kind, MEDIA_KINDS, 'kind'),
    mimeType: enumValue(row.declared_content_type, MIME_TYPES, 'mimeType'),
    sizeBytes: asSafeInteger(row.expected_size_bytes, 'sizeBytes'),
    confirmedBytes: asSafeInteger(row.confirmed_size_bytes, 'confirmedBytes'),
    failureCode: row.failure_code,
    failedAt,
    createdAt: asDate(row.created_at, 'createdAt'),
    updatedAt: asDate(row.updated_at, 'updatedAt'),
  }
}

function normalizedUserStatus(value: string | undefined): HistoryUserStatus | null {
  return value === 'active' || value === 'disabled' || value === 'deleted' ? value : null
}

function rollback(client: PoolClient): Promise<void> {
  return client.query('rollback').then(
    () => undefined,
    () => undefined,
  )
}

export class PostgresUploadHistoryRepository implements UploadHistoryRepository {
  readonly #pool: Pick<Pool, 'connect'>

  constructor(deps: { pool: Pick<Pool, 'connect'> }) {
    this.#pool = deps.pool
  }

  async listPage(input: HistoryRepositoryPageInput): Promise<HistoryRepositoryPage> {
    const client = await this.#pool.connect()
    try {
      await client.query('begin isolation level repeatable read read only')
      const selectedUser = await client.query<{ status: string }>(
        `select status from media_app.users where id = $1`,
        [input.userId],
      )
      const userStatus = normalizedUserStatus(selectedUser.rows[0]?.status)
      if (userStatus !== 'active') {
        await client.query('commit')
        return { userStatus, rows: [] }
      }

      const selected = await client.query<HistoryRow>(
        `with history as (
           select u.id as upload_id, u.media_object_id as media_id,
                  u.status as upload_status, m.storage_status as media_status,
                  m.original_filename, m.kind, m.declared_content_type,
                  u.expected_size_bytes::text,
                  u.confirmed_size_bytes::text,
                  coalesce(u.failure_code, m.failure_code) as failure_code,
                  coalesce(u.failed_at, m.failed_at) as failed_at,
                  u.created_at,
                  greatest(u.updated_at, m.updated_at, u.last_activity_at) as updated_at,
                  case
                    when u.status = 'aborting' then 'cancelling'
                    when u.status = 'completing' and m.storage_status = 'pending_upload'
                      then 'finalizing'
                    when u.status = 'completed' and m.storage_status = 'ready' then 'uploaded'
                    when u.status = 'failed' or m.storage_status = 'failed' then 'upload_failed'
                    when u.status = 'aborted' and m.storage_status = 'aborted' then 'aborted'
                    when u.status = 'expired' and m.storage_status = 'aborted' then 'expired'
                    when u.status in ('initiating', 'uploading')
                      and m.storage_status = 'pending_upload' then 'uploading'
                    else 'upload_failed'
                  end as public_status
             from media_app.upload_sessions u
             join media_app.media_objects m on m.id = u.media_object_id
            where u.user_id = $1
         )
         select upload_id, media_id, upload_status, media_status,
                original_filename, kind, declared_content_type,
                expected_size_bytes, confirmed_size_bytes,
                failure_code, failed_at, created_at, updated_at
           from history
          where ($2::text is null or public_status = $2)
            and ($3::timestamptz is null or (created_at, upload_id) < ($3, $4::uuid))
          order by created_at desc, upload_id desc
          limit $5`,
        [
          input.userId,
          input.status,
          input.after?.createdAt ?? null,
          input.after?.id ?? null,
          input.take,
        ],
      )
      await client.query('commit')
      return { userStatus, rows: selected.rows.map(repositoryRecord) }
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }
}
