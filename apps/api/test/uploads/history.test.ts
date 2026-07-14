import type { UploadHistoryQuery } from '@wx-upload/contracts'
import { describe, expect, it, vi } from 'vitest'

import { SignedHistoryCursorCodec } from '../../src/uploads/cursor.js'
import {
  PostgresUploadHistoryRepository,
  type HistoryRepositoryPage,
  type HistoryRepositoryRecord,
  type UploadHistoryRepository,
} from '../../src/uploads/history-repository.js'
import { UploadHistoryService } from '../../src/uploads/history-service.js'
import { projectPublicStatus } from '../../src/uploads/public-status.js'

const userId = '01981c9e-6c80-7000-8000-000000000001'
const otherUserId = '01981c9e-6c80-7000-8000-000000000002'
const signingSecret = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1))
const now = new Date('2026-07-15T04:00:00.000Z')

type TestHistoryRecord = HistoryRepositoryRecord & { readonly ownerId?: string }

function historyRecord(
  id: string,
  createdAt: string,
  overrides: Partial<HistoryRepositoryRecord> = {},
): HistoryRepositoryRecord {
  return {
    uploadId: id,
    mediaId: id.replace(/.$/u, 'f'),
    uploadStatus: 'uploading',
    mediaStatus: 'pending_upload',
    fileName: 'private-photo.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 12_582_913,
    confirmedBytes: 8_388_608,
    failureCode: null,
    failedAt: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    ...overrides,
  }
}

class InMemoryHistoryRepository implements UploadHistoryRepository {
  readonly calls: Parameters<UploadHistoryRepository['listPage']>[0][] = []

  constructor(
    readonly records: readonly TestHistoryRecord[],
    readonly userStatus: HistoryRepositoryPage['userStatus'] = 'active',
  ) {}

  listPage(
    input: Parameters<UploadHistoryRepository['listPage']>[0],
  ): Promise<HistoryRepositoryPage> {
    this.calls.push(input)
    if (this.userStatus !== 'active') {
      return Promise.resolve({ userStatus: this.userStatus, rows: [] })
    }
    const rows = [...this.records]
      .filter((record) => record.ownerId === undefined || record.ownerId === input.userId)
      .filter(
        (record) =>
          input.status === null ||
          projectPublicStatus(record.uploadStatus, record.mediaStatus) === input.status,
      )
      .filter((record) => {
        if (input.after === null) return true
        const timeDifference = record.createdAt.getTime() - input.after.createdAt.getTime()
        return timeDifference < 0 || (timeDifference === 0 && record.uploadId < input.after.id)
      })
      .sort((left, right) => {
        const timeDifference = right.createdAt.getTime() - left.createdAt.getTime()
        return timeDifference === 0 ? right.uploadId.localeCompare(left.uploadId) : timeDifference
      })
      .slice(0, input.take)
    return Promise.resolve({ userStatus: this.userStatus, rows })
  }
}

function service(repository: UploadHistoryRepository) {
  const cursor = new SignedHistoryCursorCodec({
    secret: signingSecret,
    clock: { now: () => new Date(now) },
  })
  return new UploadHistoryService({ repository, cursor })
}

async function expectApiError(
  operation: Promise<unknown>,
  expected: { code: string; statusCode: number },
): Promise<void> {
  await expect(operation).rejects.toMatchObject({
    name: 'ApiError',
    retryable: false,
    ...expected,
  })
}

describe('UploadHistoryService', () => {
  it('projects progress and sanitized failure without exposing storage internals', async () => {
    const failed = {
      ...historyRecord('01981c9e-6c80-7000-8000-000000000013', '2026-07-15T03:00:00.000Z', {
        uploadStatus: 'failed',
        mediaStatus: 'failed',
        failureCode: 'DATABASE_PRIVATE_DIAGNOSTIC',
        failedAt: new Date('2026-07-15T03:01:00.000Z'),
      }),
      object_key: 'users/private/secret.jpg',
      r2_upload_id: 'private-multipart-id',
      object_etag: 'private-etag',
      r2_bucket: 'private-bucket',
    }
    const repository = new InMemoryHistoryRepository([failed])

    const result = await service(repository).list({ userId, query: {} })

    expect(result).toEqual({
      data: {
        items: [
          {
            id: failed.uploadId,
            mediaId: failed.mediaId,
            status: 'upload_failed',
            fileName: 'private-photo.jpg',
            kind: 'image',
            mimeType: 'image/jpeg',
            sizeBytes: 12_582_913,
            progress: {
              confirmedBytes: 8_388_608,
              totalBytes: 12_582_913,
              percent: 66.67,
            },
            failure: {
              stage: 'storage',
              code: 'STORAGE_UNAVAILABLE',
              message: '存储服务暂时不可用',
              failedAt: '2026-07-15T03:01:00.000Z',
            },
            createdAt: '2026-07-15T03:00:00.000Z',
            updatedAt: '2026-07-15T03:00:00.000Z',
          },
        ],
      },
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    })
    expect(JSON.stringify(result)).not.toMatch(
      /object_key|r2_upload_id|object_etag|r2_bucket|secret\.jpg|private-etag/u,
    )
    expect(repository.calls[0]).toMatchObject({ userId, status: null, after: null, take: 21 })
  })

  it('uses createdAt DESC plus id DESC as a stable keyset without duplicates', async () => {
    const records = [
      historyRecord('01981c9e-6c80-7000-8000-000000000011', '2026-07-15T03:00:00.000Z'),
      historyRecord('01981c9e-6c80-7000-8000-000000000012', '2026-07-15T03:00:00.000Z'),
      historyRecord('01981c9e-6c80-7000-8000-000000000013', '2026-07-15T03:00:00.000Z'),
      historyRecord('01981c9e-6c80-7000-8000-000000000014', '2026-07-15T02:00:00.000Z'),
    ]
    const repository = new InMemoryHistoryRepository(records)
    const history = service(repository)

    const first = await history.list({ userId, query: { limit: 2 } })
    if (first.pagination.nextCursor === null) throw new Error('expected a second history page')
    const second = await history.list({
      userId,
      query: { limit: 2, cursor: first.pagination.nextCursor },
    })

    expect(first.data.items.map(({ id }) => id)).toEqual([
      '01981c9e-6c80-7000-8000-000000000013',
      '01981c9e-6c80-7000-8000-000000000012',
    ])
    expect(first.pagination).toMatchObject({ limit: 2, hasMore: true })
    expect(first.pagination.nextCursor).toEqual(expect.any(String))
    expect(second.data.items.map(({ id }) => id)).toEqual([
      '01981c9e-6c80-7000-8000-000000000011',
      '01981c9e-6c80-7000-8000-000000000014',
    ])
    expect(second.pagination).toEqual({ limit: 2, hasMore: false, nextCursor: null })
    expect(repository.calls[1]?.after).toEqual({
      createdAt: new Date('2026-07-15T03:00:00.000Z'),
      id: '01981c9e-6c80-7000-8000-000000000012',
    })
  })

  it('binds the signed cursor to both the authenticated user and status filter', async () => {
    const repository = new InMemoryHistoryRepository([
      historyRecord('01981c9e-6c80-7000-8000-000000000021', '2026-07-15T03:00:00.000Z', {
        uploadStatus: 'completed',
        mediaStatus: 'ready',
      }),
      historyRecord('01981c9e-6c80-7000-8000-000000000022', '2026-07-15T02:00:00.000Z', {
        uploadStatus: 'completed',
        mediaStatus: 'ready',
      }),
    ])
    const history = service(repository)
    const first = await history.list({ userId, query: { limit: 1, status: 'uploaded' } })
    const cursor = first.pagination.nextCursor
    if (cursor === null) throw new Error('expected a signed history cursor')

    await expectApiError(
      history.list({
        userId: otherUserId,
        query: { limit: 1, status: 'uploaded', cursor },
      }),
      { code: 'INVALID_CURSOR', statusCode: 400 },
    )
    await expectApiError(
      history.list({
        userId,
        query: { limit: 1, status: 'upload_failed', cursor },
      }),
      { code: 'INVALID_CURSOR', statusCode: 400 },
    )
    expect(repository.calls).toHaveLength(1)
  })

  it('passes user ownership and one normalized public-status filter to the repository', async () => {
    const repository = new InMemoryHistoryRepository([
      {
        ...historyRecord('01981c9e-6c80-7000-8000-000000000031', '2026-07-15T03:00:00.000Z', {
          uploadStatus: 'completed',
          mediaStatus: 'ready',
        }),
        ownerId: userId,
      },
      {
        ...historyRecord('01981c9e-6c80-7000-8000-000000000032', '2026-07-15T02:00:00.000Z', {
          uploadStatus: 'completed',
          mediaStatus: 'ready',
        }),
        ownerId: otherUserId,
      },
      {
        ...historyRecord('01981c9e-6c80-7000-8000-000000000033', '2026-07-15T01:00:00.000Z', {
          uploadStatus: 'failed',
          mediaStatus: 'failed',
        }),
        ownerId: userId,
      },
    ])

    const result = await service(repository).list({
      userId,
      query: { status: 'uploaded' },
    })

    expect(result.data.items.map(({ id }) => id)).toEqual(['01981c9e-6c80-7000-8000-000000000031'])
    expect(repository.calls[0]).toMatchObject({ userId, status: 'uploaded' })
  })

  it.each<[status: HistoryRepositoryPage['userStatus'], code: string, statusCode: number]>([
    ['disabled', 'USER_DISABLED', 403],
    ['deleted', 'UNAUTHORIZED', 401],
    [null, 'UNAUTHORIZED', 401],
  ])('rejects an inactive history owner in state %s', async (status, code, statusCode) => {
    const repository = new InMemoryHistoryRepository([], status)

    await expectApiError(service(repository).list({ userId, query: {} }), { code, statusCode })
  })

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { status: 'internal-status' }])(
    'rejects an invalid direct-service query %j before touching storage',
    async (query) => {
      const repository = new InMemoryHistoryRepository([])

      await expectApiError(
        service(repository).list({ userId, query: query as UploadHistoryQuery }),
        { code: 'VALIDATION_ERROR', statusCode: 422 },
      )
      expect(repository.calls).toHaveLength(0)
    },
  )

  it.each<
    [
      failureCode: HistoryRepositoryRecord['failureCode'],
      expectedCode: string | null,
      expectedStage: string | null,
    ]
  >([
    ['MIME_MISMATCH', 'MIME_MISMATCH', 'validation'],
    ['FILE_TOO_SMALL', 'FILE_TOO_SMALL', 'validation'],
    ['STORAGE_OBJECT_SIZE_MISMATCH', 'STORAGE_OBJECT_SIZE_MISMATCH', 'storage'],
    [null, null, null],
  ])('projects failure code %s safely', async (failureCode, expectedCode, expectedStage) => {
    const repository = new InMemoryHistoryRepository([
      historyRecord('01981c9e-6c80-7000-8000-000000000041', '2026-07-15T03:00:00.000Z', {
        uploadStatus: 'failed',
        mediaStatus: 'failed',
        failureCode,
        failedAt: failureCode === null ? null : new Date('2026-07-15T03:01:00.000Z'),
      }),
    ])

    const result = await service(repository).list({ userId, query: {} })
    const failure = result.data.items[0]?.failure

    if (expectedCode === null) {
      expect(failure).toBeNull()
    } else {
      expect(failure).toMatchObject({ code: expectedCode, stage: expectedStage })
    }
  })
})

describe('PostgresUploadHistoryRepository', () => {
  it('uses an owner-scoped stable keyset query that never selects R2 internals', async () => {
    const queries: { text: string; values?: readonly unknown[] }[] = []
    const query = vi.fn((text: string, values?: readonly unknown[]) => {
      queries.push(values === undefined ? { text } : { text, values })
      return Promise.resolve(
        text.includes('select status from media_app.users')
          ? { rowCount: 1, rows: [{ status: 'active' }] }
          : { rowCount: 0, rows: [] },
      )
    })
    const client = { query, release: vi.fn() }
    const pool = { connect: vi.fn(() => Promise.resolve(client)) }
    const repository = new PostgresUploadHistoryRepository({
      pool: pool as never,
    })
    const after = {
      createdAt: new Date('2026-07-15T03:00:00.000Z'),
      id: '01981c9e-6c80-7000-8000-000000000051',
    }

    await repository.listPage({ userId, status: 'uploaded', after, take: 21 })

    const pageQuery = queries.find(({ text }) => text.includes('from history'))
    expect(pageQuery).toBeDefined()
    expect(pageQuery?.text).toMatch(/where u\.user_id = \$1/u)
    expect(pageQuery?.text).toMatch(/\(created_at, upload_id\) < \(\$3, \$4::uuid\)/u)
    expect(pageQuery?.text).toMatch(/order by created_at desc, upload_id desc/u)
    expect(pageQuery?.text).not.toMatch(/object_key|r2_upload_id|object_etag|r2_bucket/u)
    expect(pageQuery?.values).toEqual([userId, 'uploaded', after.createdAt, after.id, 21])
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('does not query another table when the history owner is inactive', async () => {
    const query = vi.fn((text: string) => {
      return Promise.resolve(
        text.includes('select status from media_app.users')
          ? { rowCount: 1, rows: [{ status: 'disabled' }] }
          : { rowCount: 0, rows: [] },
      )
    })
    const client = { query, release: vi.fn() }
    const repository = new PostgresUploadHistoryRepository({
      pool: { connect: vi.fn(() => Promise.resolve(client)) } as never,
    })

    await expect(
      repository.listPage({ userId, status: null, after: null, take: 21 }),
    ).resolves.toEqual({ userStatus: 'disabled', rows: [] })
    expect(query).toHaveBeenCalledTimes(3)
    expect(query.mock.calls.map(([text]) => text)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/from history/u)]),
    )
    expect(client.release).toHaveBeenCalledOnce()
  })
})
