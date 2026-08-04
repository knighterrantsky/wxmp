import type { Pool } from 'pg'

export type AdminUploadCategory =
  | 'server_receiving'
  | 'r2_retrying'
  | 'r2_ready'
  | 'user_reupload'
  | 'operator_review'
  | 'cancelled'

export interface AdminUploadSummary {
  readonly users: number
  readonly total: number
  readonly serverReceiving: number
  readonly r2Retrying: number
  readonly r2Ready: number
  readonly userReupload: number
  readonly operatorReview: number
  readonly cancelled: number
}

export interface AdminUploadRecord {
  readonly uploadId: string
  readonly mediaId: string
  readonly userId: string
  readonly nickname: string | null
  readonly appId: string | null
  readonly openid: string | null
  readonly fileName: string
  readonly kind: string
  readonly declaredContentType: string
  readonly verifiedContentType: string | null
  readonly expectedSizeBytes: number
  readonly confirmedSizeBytes: number
  readonly uploadStatus: string
  readonly storageStatus: string
  readonly category: AdminUploadCategory
  readonly r2Bucket: string
  readonly objectKey: string
  readonly finalizeAttemptCount: number
  readonly nextFinalizeAt: string | null
  readonly lastFinalizeErrorCode: string | null
  readonly lastFinalizeErrorAt: string | null
  readonly failureCode: string | null
  readonly failureDetail: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AdminUploadPage {
  readonly total: number
  readonly rows: readonly AdminUploadRecord[]
}

export interface AdminUploadRepository {
  summary(): Promise<AdminUploadSummary>
  list(input: {
    category: AdminUploadCategory | null
    query: string | null
    limit: number
    offset: number
  }): Promise<AdminUploadPage>
}

const CATEGORY_SQL = `case
  when u.status = 'completed' and m.storage_status = 'ready' then 'r2_ready'
  when u.status = 'completing'
    and u.confirmed_size_bytes = u.expected_size_bytes
    and m.storage_status = 'pending_upload' then 'r2_retrying'
  when (u.status = 'failed' or m.storage_status = 'failed')
    and u.confirmed_size_bytes = u.expected_size_bytes then 'operator_review'
  when u.status in ('failed', 'expired')
    and u.confirmed_size_bytes < u.expected_size_bytes then 'user_reupload'
  when u.status in ('aborting', 'aborted') or m.storage_status = 'aborted' then 'cancelled'
  when u.status in ('initiating', 'uploading') then 'server_receiving'
  else 'operator_review'
end`

interface SummaryRow {
  users: string | number
  total: string | number
  server_receiving: string | number
  r2_retrying: string | number
  r2_ready: string | number
  user_reupload: string | number
  operator_review: string | number
  cancelled: string | number
}

interface UploadRow {
  upload_id: string
  media_id: string
  user_id: string
  nickname: string | null
  app_id: string | null
  openid: string | null
  original_filename: string
  kind: string
  declared_content_type: string
  verified_content_type: string | null
  expected_size_bytes: string | number
  confirmed_size_bytes: string | number
  upload_status: string
  storage_status: string
  category: string
  r2_bucket: string
  object_key: string
  finalize_attempt_count: string | number
  next_finalize_at: Date | string | null
  last_finalize_error_code: string | null
  last_finalize_error_at: Date | string | null
  failure_code: string | null
  failure_detail: string | null
  created_at: Date | string
  updated_at: Date | string
}

const CATEGORIES = new Set<AdminUploadCategory>([
  'server_receiving',
  'r2_retrying',
  'r2_ready',
  'user_reupload',
  'operator_review',
  'cancelled',
])

function safeInteger(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`admin ${field} is invalid`)
  return parsed
}

function iso(value: Date | string | null, field: string): string | null {
  if (value === null) return null
  const parsed = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(parsed.getTime())) throw new Error(`admin ${field} is invalid`)
  return parsed.toISOString()
}

function category(value: string): AdminUploadCategory {
  if (!CATEGORIES.has(value as AdminUploadCategory)) throw new Error('admin category is invalid')
  return value as AdminUploadCategory
}

function uploadRecord(row: UploadRow): AdminUploadRecord {
  return {
    uploadId: row.upload_id,
    mediaId: row.media_id,
    userId: row.user_id,
    nickname: row.nickname,
    appId: row.app_id,
    openid: row.openid,
    fileName: row.original_filename,
    kind: row.kind,
    declaredContentType: row.declared_content_type,
    verifiedContentType: row.verified_content_type,
    expectedSizeBytes: safeInteger(row.expected_size_bytes, 'expectedSizeBytes'),
    confirmedSizeBytes: safeInteger(row.confirmed_size_bytes, 'confirmedSizeBytes'),
    uploadStatus: row.upload_status,
    storageStatus: row.storage_status,
    category: category(row.category),
    r2Bucket: row.r2_bucket,
    objectKey: row.object_key,
    finalizeAttemptCount: safeInteger(row.finalize_attempt_count, 'finalizeAttemptCount'),
    nextFinalizeAt: iso(row.next_finalize_at, 'nextFinalizeAt'),
    lastFinalizeErrorCode: row.last_finalize_error_code,
    lastFinalizeErrorAt: iso(row.last_finalize_error_at, 'lastFinalizeErrorAt'),
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
    createdAt: iso(row.created_at, 'createdAt') ?? '',
    updatedAt: iso(row.updated_at, 'updatedAt') ?? '',
  }
}

export class PostgresAdminUploadRepository implements AdminUploadRepository {
  readonly #pool: Pick<Pool, 'query'>

  constructor(deps: { pool: Pick<Pool, 'query'> }) {
    this.#pool = deps.pool
  }

  async summary(): Promise<AdminUploadSummary> {
    const selected = await this.#pool.query<SummaryRow>(
      `with classified as (
         select ${CATEGORY_SQL} as category
           from media_app.upload_sessions u
           join media_app.media_objects m on m.id = u.media_object_id
       )
       select (select count(*) from media_app.users)::text as users,
              count(*)::text as total,
              count(*) filter (where category = 'server_receiving')::text as server_receiving,
              count(*) filter (where category = 'r2_retrying')::text as r2_retrying,
              count(*) filter (where category = 'r2_ready')::text as r2_ready,
              count(*) filter (where category = 'user_reupload')::text as user_reupload,
              count(*) filter (where category = 'operator_review')::text as operator_review,
              count(*) filter (where category = 'cancelled')::text as cancelled
         from classified`,
    )
    const row = selected.rows[0]
    if (row === undefined) throw new Error('admin summary returned no row')
    return {
      users: safeInteger(row.users, 'users'),
      total: safeInteger(row.total, 'total'),
      serverReceiving: safeInteger(row.server_receiving, 'serverReceiving'),
      r2Retrying: safeInteger(row.r2_retrying, 'r2Retrying'),
      r2Ready: safeInteger(row.r2_ready, 'r2Ready'),
      userReupload: safeInteger(row.user_reupload, 'userReupload'),
      operatorReview: safeInteger(row.operator_review, 'operatorReview'),
      cancelled: safeInteger(row.cancelled, 'cancelled'),
    }
  }

  async list(input: {
    category: AdminUploadCategory | null
    query: string | null
    limit: number
    offset: number
  }): Promise<AdminUploadPage> {
    const commonSql = `from (
       select u.id as upload_id, u.media_object_id as media_id, u.user_id,
              usr.nickname, identity.app_id, identity.openid,
              m.original_filename, m.kind::text,
              m.declared_content_type, m.verified_content_type,
              u.expected_size_bytes::text, u.confirmed_size_bytes::text,
              u.status::text as upload_status, m.storage_status::text as storage_status,
              ${CATEGORY_SQL} as category,
              m.r2_bucket, m.object_key, u.finalize_attempt_count,
              u.next_finalize_at, u.last_finalize_error_code, u.last_finalize_error_at,
              coalesce(u.failure_code, m.failure_code) as failure_code,
              u.failure_detail, u.created_at,
              greatest(u.updated_at, m.updated_at, u.last_activity_at) as updated_at
         from media_app.upload_sessions u
         join media_app.media_objects m on m.id = u.media_object_id
         join media_app.users usr on usr.id = u.user_id
         left join lateral (
           select i.app_id, i.openid
             from media_app.user_identities i
            where i.user_id = u.user_id
            order by i.last_login_at desc, i.id desc
            limit 1
         ) identity on true
     ) records
     where ($1::text is null or records.category = $1)
       and ($2::text is null or records.original_filename ilike '%' || $2 || '%'
            or coalesce(records.nickname, '') ilike '%' || $2 || '%'
            or coalesce(records.openid, '') ilike '%' || $2 || '%'
            or records.upload_id::text = $2
            or records.media_id::text = $2)`
    const parameters = [input.category, input.query]
    const [countResult, rowsResult] = await Promise.all([
      this.#pool.query<{ total: string | number }>(
        `select count(*)::text as total ${commonSql}`,
        parameters,
      ),
      this.#pool.query<UploadRow>(
        `select records.* ${commonSql}
          order by records.created_at desc, records.upload_id desc
          limit $3 offset $4`,
        [...parameters, input.limit, input.offset],
      ),
    ])
    const total = countResult.rows[0]?.total
    if (total === undefined) throw new Error('admin upload count returned no row')
    return { total: safeInteger(total, 'total'), rows: rowsResult.rows.map(uploadRecord) }
  }
}
