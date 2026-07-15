import type {
  AbortUploadResponse,
  CompleteUploadResponse,
  InitializeUploadRequest,
  InitializeUploadResponse,
  PublicUser,
  UploadDetailResponse,
} from '@wx-upload/contracts'
import { describe, expect, it, vi } from 'vitest'

import { ApiClient, type AuthorizedSession } from '../miniprogram/services/api-client.js'
import type { HttpRequest, HttpResponse } from '../miniprogram/runtime/wechat-runtime.js'

const uploadId = '01981d0c-ec80-7000-8000-000000000103'
const mediaId = '01981d0c-ec80-7000-8000-000000000104'
const idempotencyKey = '01981d0c-ec80-7000-8000-000000000105'
const createdAt = '2026-07-15T05:00:00.000Z'
const updatedAt = '2026-07-15T05:10:00.000Z'
const expiresAt = '2026-07-16T05:00:00.000Z'

const publicUser: PublicUser = {
  id: '01981d0c-ec80-7000-8000-000000000101',
  nickname: '小晴',
  nicknameConfirmed: true,
  nicknameConfirmedAt: createdAt,
  createdAt,
  updatedAt,
}

const meta = {
  requestId: '01981d0c-ec80-7000-8000-000000000102',
  serverTime: updatedAt,
}

const initializeRequest: InitializeUploadRequest = {
  fileName: 'summer.jpg',
  kind: 'image',
  mimeType: 'image/jpeg',
  sizeBytes: 12,
}

const initializeData: InitializeUploadResponse['data'] = {
  upload: {
    id: uploadId,
    mediaId,
    status: 'uploading',
    fileName: initializeRequest.fileName,
    kind: initializeRequest.kind,
    mimeType: initializeRequest.mimeType,
    sizeBytes: initializeRequest.sizeBytes,
    partSizeBytes: 8_388_608,
    partCount: 1,
    expiresAt,
    createdAt,
  },
  parts: [{ partNumber: 1, offsetBytes: 0, sizeBytes: 12, status: 'pending' }],
}

const detailData: UploadDetailResponse['data'] = {
  upload: {
    id: uploadId,
    mediaId,
    status: 'uploading',
    fileName: initializeRequest.fileName,
    kind: initializeRequest.kind,
    mimeType: initializeRequest.mimeType,
    sizeBytes: initializeRequest.sizeBytes,
    progress: {
      confirmedBytes: 0,
      totalBytes: 12,
      uploadedParts: 0,
      totalParts: 1,
      percent: 0,
    },
    expiresAt,
    failure: null,
    createdAt,
    updatedAt,
  },
  partDetailsRetained: true,
  partsAvailableUntil: null,
  parts: [
    {
      partNumber: 1,
      offsetBytes: 0,
      sizeBytes: 12,
      status: 'pending',
      sha256: null,
    },
  ],
  pollAfterSeconds: 2,
}

const completeData: CompleteUploadResponse['data'] = {
  upload: {
    id: uploadId,
    status: 'finalizing',
    progress: { confirmedBytes: 12, totalBytes: 12, percent: 100 },
  },
  pollAfterSeconds: 2,
}

const abortData: AbortUploadResponse['data'] = {
  upload: { id: uploadId, status: 'cancelling' },
  pollAfterSeconds: 2,
}

function response<T>(statusCode: number, data: T): HttpResponse<T> {
  return { statusCode, data, headers: {} }
}

interface Fixture {
  client: ApiClient
  request: ReturnType<typeof vi.fn<(request: HttpRequest) => Promise<HttpResponse<unknown>>>>
  session: AuthorizedSession & {
    ensureSession: ReturnType<typeof vi.fn<AuthorizedSession['ensureSession']>>
    refreshOnce: ReturnType<typeof vi.fn<AuthorizedSession['refreshOnce']>>
  }
}

function fixture(): Fixture {
  const request = vi
    .fn<(request: HttpRequest) => Promise<HttpResponse<unknown>>>()
    .mockResolvedValue(response(200, { data: detailData, meta }))
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

function success(data: unknown, statusCode = 200): HttpResponse<unknown> {
  return response(statusCode, { data, meta })
}

function tokenExpired(): HttpResponse<unknown> {
  return response(401, {
    error: { code: 'TOKEN_EXPIRED', message: '访问凭据已过期', retryable: true },
    meta,
  })
}

describe('ApiClient upload lifecycle', () => {
  it('initializes an upload with the caller-provided idempotency key', async () => {
    const { client, request, session } = fixture()
    request.mockResolvedValueOnce(success(initializeData, 201))

    await expect(
      client.initializeUpload(initializeRequest, idempotencyKey, session),
    ).resolves.toEqual(initializeData)

    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://api.example.com/v1/uploads',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        authorization: 'Bearer access-old',
      },
      data: initializeRequest,
    })
  })

  it('loads public upload status without sending an idempotency key', async () => {
    const { client, request, session } = fixture()
    request.mockResolvedValueOnce(success(detailData))

    await expect(client.getUpload(uploadId, session)).resolves.toEqual(detailData)

    expect(request).toHaveBeenCalledWith({
      method: 'GET',
      url: `https://api.example.com/v1/uploads/${uploadId}`,
      headers: { authorization: 'Bearer access-old' },
    })
  })

  it('starts completion with an empty JSON body and the exact completion-cycle key', async () => {
    const { client, request, session } = fixture()
    request.mockResolvedValueOnce(success(completeData, 202))

    await expect(client.completeUpload(uploadId, idempotencyKey, session)).resolves.toEqual(
      completeData,
    )

    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: `https://api.example.com/v1/uploads/${uploadId}/complete`,
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': idempotencyKey,
        authorization: 'Bearer access-old',
      },
      data: {},
    })
  })

  it.each(['userCancelled', 'replaced'] as const)(
    'aborts an upload with the %s reason and caller-provided key',
    async (reason) => {
      const { client, request, session } = fixture()
      request.mockResolvedValueOnce(success(abortData, 202))

      await expect(client.abortUpload(uploadId, reason, idempotencyKey, session)).resolves.toEqual(
        abortData,
      )

      expect(request).toHaveBeenCalledWith({
        method: 'POST',
        url: `https://api.example.com/v1/uploads/${uploadId}/abort`,
        headers: {
          'content-type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          authorization: 'Bearer access-old',
        },
        data: { reason },
      })
    },
  )

  it('preserves the same complete key when refreshing an expired access token', async () => {
    const { client, request, session } = fixture()
    request.mockResolvedValueOnce(tokenExpired()).mockResolvedValueOnce(success(completeData, 202))

    await expect(client.completeUpload(uploadId, idempotencyKey, session)).resolves.toEqual(
      completeData,
    )

    expect(session.refreshOnce).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.map(([call]) => call.headers?.['Idempotency-Key'])).toEqual([
      idempotencyKey,
      idempotencyKey,
    ])
    expect(request.mock.calls.map(([call]) => call.headers?.['authorization'])).toEqual([
      'Bearer access-old',
      'Bearer access-new',
    ])
  })

  it('does not refresh or retry an upload business 4xx', async () => {
    const { client, request, session } = fixture()
    request.mockResolvedValueOnce(
      response(428, {
        error: { code: 'NICKNAME_REQUIRED', message: '请先确认昵称', retryable: false },
        meta,
      }),
    )

    await expect(
      client.initializeUpload(initializeRequest, idempotencyKey, session),
    ).rejects.toMatchObject({ statusCode: 428, code: 'NICKNAME_REQUIRED' })
    expect(session.refreshOnce).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
  })

  it.each([
    ['initialize', { ...initializeData, privateObjectKey: 'users/private/file' }],
    [
      'status',
      {
        ...detailData,
        parts: [{ ...detailData.parts[0], r2Etag: 'must-not-be-exposed' }],
      },
    ],
    ['complete', { ...completeData, pollAfterSeconds: 1 }],
    ['abort', { ...abortData, upload: { ...abortData.upload, internalStatus: 'aborting' } }],
  ] as const)('rejects a malformed %s response', async (operation, malformedData) => {
    const { client, request, session } = fixture()
    request.mockResolvedValueOnce(success(malformedData))

    const pending =
      operation === 'initialize'
        ? client.initializeUpload(initializeRequest, idempotencyKey, session)
        : operation === 'status'
          ? client.getUpload(uploadId, session)
          : operation === 'complete'
            ? client.completeUpload(uploadId, idempotencyKey, session)
            : client.abortUpload(uploadId, 'userCancelled', idempotencyKey, session)

    await expect(pending).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      statusCode: 502,
    })
  })

  it.each([
    [
      'status',
      (client: ApiClient, session: AuthorizedSession) => client.getUpload('../secret', session),
    ],
    [
      'complete',
      (client: ApiClient, session: AuthorizedSession) =>
        client.completeUpload('01981D0C-EC80-7000-8000-000000000103', idempotencyKey, session),
    ],
    [
      'abort',
      (client: ApiClient, session: AuthorizedSession) =>
        client.abortUpload(`${uploadId}?leak=1`, 'replaced', idempotencyKey, session),
    ],
  ] as const)('rejects an invalid uploadId before the %s request', (_operation, call) => {
    const { client, request, session } = fixture()

    expect(() => call(client, session)).toThrow(/uploadId/u)
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    [
      'initialize',
      (client: ApiClient, session: AuthorizedSession) =>
        client.initializeUpload(initializeRequest, 'client-generated-key', session),
    ],
    [
      'complete',
      (client: ApiClient, session: AuthorizedSession) =>
        client.completeUpload(uploadId, '01981d0c-ec80-6000-8000-000000000105', session),
    ],
    [
      'abort',
      (client: ApiClient, session: AuthorizedSession) =>
        client.abortUpload(uploadId, 'userCancelled', `${idempotencyKey}\n`, session),
    ],
  ] as const)('requires a UUIDv7 idempotency key for %s', (_operation, call) => {
    const { client, request, session } = fixture()

    expect(() => call(client, session)).toThrow(/idempotency/u)
    expect(request).not.toHaveBeenCalled()
  })

  it.each([
    ['status', () => ({ ...detailData, upload: { ...detailData.upload, id: mediaId } })],
    ['complete', () => ({ ...completeData, upload: { ...completeData.upload, id: mediaId } })],
    ['abort', () => ({ ...abortData, upload: { ...abortData.upload, id: mediaId } })],
  ] as const)('rejects a %s response for a different uploadId', async (operation, data) => {
    const { client, request, session } = fixture()
    request.mockResolvedValueOnce(success(data()))

    const pending =
      operation === 'status'
        ? client.getUpload(uploadId, session)
        : operation === 'complete'
          ? client.completeUpload(uploadId, idempotencyKey, session)
          : client.abortUpload(uploadId, 'userCancelled', idempotencyKey, session)

    await expect(pending).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      statusCode: 502,
    })
  })
})
