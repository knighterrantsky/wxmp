import type { HttpRequest, HttpResponse } from '../miniprogram/runtime/wechat-runtime.js'
import { ApiClient, type AuthorizedSession } from '../miniprogram/services/api-client.js'
import type { PublicUser, UploadHistoryResponse } from '@wx-upload/contracts'
import { describe, expect, it, vi } from 'vitest'

const createdAt = '2026-07-15T05:00:00.000Z'
const updatedAt = '2026-07-15T05:10:00.000Z'

const publicUser: PublicUser = {
  id: '01981d0c-ec80-7000-8000-000000000101',
  nickname: '小晴',
  nicknameConfirmed: true,
  nicknameConfirmedAt: createdAt,
  createdAt,
  updatedAt,
}

const items: UploadHistoryResponse['data']['items'] = [
  {
    id: '01981d0c-ec80-7000-8000-000000000103',
    mediaId: '01981d0c-ec80-7000-8000-000000000104',
    status: 'uploaded',
    fileName: 'summer.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 12,
    progress: { confirmedBytes: 12, totalBytes: 12, percent: 100 },
    failure: null,
    createdAt,
    updatedAt,
  },
]

const responseMeta = {
  requestId: '01981d0c-ec80-7000-8000-000000000102',
  serverTime: updatedAt,
}

const pagination = {
  limit: 20,
  hasMore: true,
  nextCursor: 'signed-next-cursor',
}

interface Fixture {
  client: ApiClient
  request: ReturnType<typeof vi.fn<(request: HttpRequest) => Promise<HttpResponse<unknown>>>>
  session: AuthorizedSession & {
    ensureSession: ReturnType<typeof vi.fn<AuthorizedSession['ensureSession']>>
    refreshOnce: ReturnType<typeof vi.fn<AuthorizedSession['refreshOnce']>>
  }
}

function response<T>(statusCode: number, data: T): HttpResponse<T> {
  return { statusCode, data, headers: {} }
}

function listSuccess(
  data: unknown = { items },
  meta: unknown = { ...responseMeta, pagination },
): HttpResponse<unknown> {
  return response(200, { data, meta })
}

function fixture(): Fixture {
  const request = vi
    .fn<(request: HttpRequest) => Promise<HttpResponse<unknown>>>()
    .mockResolvedValue(listSuccess())
  const current = {
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    user: publicUser,
  }
  const session = {
    ensureSession: vi.fn<AuthorizedSession['ensureSession']>().mockResolvedValue(current),
    refreshOnce: vi.fn<AuthorizedSession['refreshOnce']>().mockResolvedValue({
      ...current,
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
    }),
  }

  return {
    client: new ApiClient({
      runtime: {
        async request<T>(input: HttpRequest): Promise<HttpResponse<T>> {
          const result = await request(input)
          return { ...result, data: result.data as T }
        },
      },
      baseUrl: 'https://api.example.com',
    }),
    request,
    session,
  }
}

describe('ApiClient upload history', () => {
  it('loads the first page and preserves its pagination cursor', async () => {
    const { client, request, session } = fixture()

    await expect(client.getUploadHistory({}, session)).resolves.toEqual({ items, pagination })
    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: 'https://api.example.com/v1/uploads',
      headers: { authorization: 'Bearer access-old' },
    })
  })

  it('constructs query parameters in a fixed order and URL-encodes the opaque cursor', async () => {
    const { client, request, session } = fixture()
    const cursor = 'https://evil.example/signed+/cursor?status=aborted&next=1#fragment % 中文'

    await client.getUploadHistory({ limit: 50, status: 'uploaded', cursor }, session)

    expect(request.mock.calls[0]?.[0].url).toBe(
      `https://api.example.com/v1/uploads?limit=50&status=uploaded&cursor=${encodeURIComponent(cursor)}`,
    )
  })

  it.each([
    ['zero limit', { limit: 0 }],
    ['limit over 100', { limit: 101 }],
    ['fractional limit', { limit: 1.5 }],
    ['unknown status', { status: 'processing' }],
    ['empty cursor', { cursor: '' }],
    ['oversized cursor', { cursor: 'a'.repeat(4_097) }],
    ['unknown query field', { limit: 20, objectKey: 'private/path' }],
  ])('rejects an invalid %s before requesting history', (_name, query) => {
    const { client, request, session } = fixture()

    expect(() => client.getUploadHistory(query as never, session)).toThrow(/query/u)
    expect(request).not.toHaveBeenCalled()
  })

  it('rejects private object fields in a history item', async () => {
    const { client, request, session } = fixture()
    request.mockResolvedValueOnce(
      listSuccess({
        items: [{ ...items[0], objectKey: 'users/private/object.jpg', etag: 'secret-etag' }],
      }),
    )

    await expect(client.getUploadHistory({}, session)).rejects.toMatchObject({
      statusCode: 502,
      code: 'INTERNAL_ERROR',
    })
  })

  it.each([
    ['missing pagination', responseMeta],
    [
      'unknown pagination field',
      { ...responseMeta, pagination: { ...pagination, internalCount: 123 } },
    ],
    ['invalid next cursor', { ...responseMeta, pagination: { ...pagination, nextCursor: 123 } }],
  ])('rejects list metadata with %s', async (_name, malformedMeta) => {
    const { client, request, session } = fixture()
    request.mockResolvedValueOnce(listSuccess({ items }, malformedMeta))

    await expect(client.getUploadHistory({}, session)).rejects.toMatchObject({
      statusCode: 502,
      code: 'INTERNAL_ERROR',
    })
  })

  it('keeps ordinary success metadata strict and does not allow list pagination there', async () => {
    const { client, request, session } = fixture()
    request.mockResolvedValueOnce(
      response(200, {
        data: { user: publicUser },
        meta: { ...responseMeta, pagination },
      }),
    )

    await expect(client.getProfile(session)).rejects.toMatchObject({
      statusCode: 502,
      code: 'INTERNAL_ERROR',
    })
  })

  it('does not refresh or retry an invalid-cursor business response', async () => {
    const { client, request, session } = fixture()
    request.mockResolvedValueOnce(
      response(422, {
        error: {
          code: 'INVALID_CURSOR',
          message: '上传记录游标无效',
          retryable: false,
        },
        meta: responseMeta,
      }),
    )

    await expect(
      client.getUploadHistory({ cursor: 'signed-old-cursor' }, session),
    ).rejects.toMatchObject({ statusCode: 422, code: 'INVALID_CURSOR' })
    expect(session.refreshOnce).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
  })

  it('refreshes once on TOKEN_EXPIRED and retries the identical encoded history path', async () => {
    const { client, request, session } = fixture()
    request
      .mockResolvedValueOnce(
        response(401, {
          error: { code: 'TOKEN_EXPIRED', message: '访问凭据已过期', retryable: true },
          meta: responseMeta,
        }),
      )
      .mockResolvedValueOnce(listSuccess())

    await client.getUploadHistory({ cursor: 'signed+/cursor' }, session)

    expect(session.refreshOnce).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0]?.[0].url).toBe(request.mock.calls[1]?.[0].url)
    expect(request.mock.calls.map(([call]) => call.headers?.['authorization'])).toEqual([
      'Bearer access-old',
      'Bearer access-new',
    ])
  })
})
