import {
  IMAGE_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  MIN_FILE_SIZE_BYTES,
  PUBLIC_UPLOAD_STATUSES,
  VIDEO_MIME_TYPES,
  type ErrorCode,
  type Pagination,
  type PublicUploadStatus,
  type UploadHistoryQuery,
  type UploadHistoryResponse,
} from '@wx-upload/contracts'

import { ApiError, PUBLIC_ERROR_MESSAGES } from '../http/errors.js'
import type { SignedHistoryCursorCodec } from './cursor.js'
import type {
  HistoryRepositoryRecord,
  HistoryUserStatus,
  UploadHistoryRepository,
} from './history-repository.js'
import { projectPublicStatus } from './public-status.js'

const DEFAULT_HISTORY_LIMIT = 20
const MAX_HISTORY_LIMIT = 100
const PUBLIC_STATUSES = new Set<string>(PUBLIC_UPLOAD_STATUSES)
const IMAGE_MIMES = new Set<string>(IMAGE_MIME_TYPES)
const VIDEO_MIMES = new Set<string>(VIDEO_MIME_TYPES)
const PUBLIC_FAILURE_CODES = new Set<ErrorCode>([
  'FILE_TOO_SMALL',
  'MIME_MISMATCH',
  'STORAGE_UNAVAILABLE',
  'STORAGE_OBJECT_SIZE_MISMATCH',
])

export interface UploadHistoryPage {
  readonly data: UploadHistoryResponse['data']
  readonly pagination: Pagination
}

export interface UploadHistoryListInput {
  readonly userId: string
  readonly query: UploadHistoryQuery
}

function apiError(code: 'UNAUTHORIZED' | 'USER_DISABLED' | 'VALIDATION_ERROR', statusCode: number) {
  return new ApiError({
    code,
    message: PUBLIC_ERROR_MESSAGES[code],
    statusCode,
  })
}

function historyLimit(value: unknown): number {
  const limit = value ?? DEFAULT_HISTORY_LIMIT
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > MAX_HISTORY_LIMIT) {
    throw apiError('VALIDATION_ERROR', 422)
  }
  return Number(limit)
}

function historyStatus(value: unknown): PublicUploadStatus | null {
  if (value === undefined) return null
  if (typeof value !== 'string' || !PUBLIC_STATUSES.has(value)) {
    throw apiError('VALIDATION_ERROR', 422)
  }
  return value as PublicUploadStatus
}

function assertActiveUser(status: HistoryUserStatus | null): void {
  if (status === 'disabled') throw apiError('USER_DISABLED', 403)
  if (status !== 'active') throw apiError('UNAUTHORIZED', 401)
}

function iso(value: Date, field: string): string {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(`history ${field} is invalid`)
  return date.toISOString()
}

function progress(confirmedBytes: number, totalBytes: number) {
  if (
    !Number.isSafeInteger(totalBytes) ||
    totalBytes < MIN_FILE_SIZE_BYTES ||
    totalBytes > MAX_FILE_SIZE_BYTES ||
    !Number.isSafeInteger(confirmedBytes) ||
    confirmedBytes < 0 ||
    confirmedBytes > totalBytes
  ) {
    throw new Error('history progress is invalid')
  }
  return {
    confirmedBytes,
    totalBytes,
    percent: Math.min(100, Math.round((confirmedBytes / totalBytes) * 10_000) / 100),
  }
}

function failure(
  status: PublicUploadStatus,
  code: string | null,
  failedAt: Date | null,
): UploadHistoryResponse['data']['items'][number]['failure'] {
  if (status !== 'upload_failed' || code === null || failedAt === null) return null
  const safeCode: ErrorCode = PUBLIC_FAILURE_CODES.has(code as ErrorCode)
    ? (code as ErrorCode)
    : 'STORAGE_UNAVAILABLE'
  return {
    stage: safeCode === 'MIME_MISMATCH' || safeCode === 'FILE_TOO_SMALL' ? 'validation' : 'storage',
    code: safeCode,
    message: PUBLIC_ERROR_MESSAGES[safeCode],
    failedAt: iso(failedAt, 'failedAt'),
  }
}

function historyItem(row: HistoryRepositoryRecord): UploadHistoryResponse['data']['items'][number] {
  const status = projectPublicStatus(row.uploadStatus, row.mediaStatus)
  const common = {
    id: row.uploadId,
    mediaId: row.mediaId,
    status,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    progress: progress(row.confirmedBytes, row.sizeBytes),
    failure: failure(status, row.failureCode, row.failedAt),
    createdAt: iso(row.createdAt, 'createdAt'),
    updatedAt: iso(row.updatedAt, 'updatedAt'),
  }
  if (row.kind === 'image' && IMAGE_MIMES.has(row.mimeType)) {
    return {
      ...common,
      kind: row.kind,
      mimeType: row.mimeType as Extract<
        UploadHistoryResponse['data']['items'][number],
        { kind: 'image' }
      >['mimeType'],
    }
  }
  if (row.kind === 'video' && VIDEO_MIMES.has(row.mimeType)) {
    return {
      ...common,
      kind: row.kind,
      mimeType: row.mimeType as Extract<
        UploadHistoryResponse['data']['items'][number],
        { kind: 'video' }
      >['mimeType'],
    }
  }
  throw new Error('history media type is invalid')
}

export class UploadHistoryService {
  readonly #repository: UploadHistoryRepository
  readonly #cursor: SignedHistoryCursorCodec

  constructor(deps: { repository: UploadHistoryRepository; cursor: SignedHistoryCursorCodec }) {
    this.#repository = deps.repository
    this.#cursor = deps.cursor
  }

  async list(input: UploadHistoryListInput): Promise<UploadHistoryPage> {
    const limit = historyLimit(input.query.limit)
    const status = historyStatus(input.query.status)
    const filter = { status }
    const after =
      input.query.cursor === undefined
        ? null
        : this.#cursor.decode(input.query.cursor, { userId: input.userId, filter })
    const page = await this.#repository.listPage({
      userId: input.userId,
      status,
      after,
      take: limit + 1,
    })
    assertActiveUser(page.userStatus)

    const hasMore = page.rows.length > limit
    const visibleRows = page.rows.slice(0, limit)
    const lastVisible = visibleRows.at(-1)
    const nextCursor =
      hasMore && lastVisible !== undefined
        ? this.#cursor.encode({
            userId: input.userId,
            filter,
            createdAt: lastVisible.createdAt,
            id: lastVisible.uploadId,
          })
        : null
    return {
      data: { items: visibleRows.map(historyItem) },
      pagination: { limit, hasMore, nextCursor },
    }
  }
}
