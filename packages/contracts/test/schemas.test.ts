import { Value } from '@sinclair/typebox/value'
import { describe, expect, it } from 'vitest'

import {
  CompleteUploadRequestSchema,
  DateTimeSchema,
  ErrorEnvelopeSchema,
  InitializeUploadRequestSchema,
  InitializeUploadResponseSchema,
  NicknameRequestSchema,
  PUBLIC_SCHEMAS,
  UploadDetailResponseSchema,
  UploadHistoryResponseSchema,
  WechatLoginRequestSchema,
  WechatLoginResponseSchema,
} from '../src/index.js'

describe('DateTimeSchema', () => {
  it('declares the standard JSON Schema date-time format', () => {
    expect(DateTimeSchema).toMatchObject({ format: 'date-time' })
  })

  it.each(['2026-07-14T09:15:00.000Z', '2024-02-29T23:59:59Z'])(
    'accepts a real UTC RFC 3339 instant: %s',
    (value) => {
      expect(Value.Check(DateTimeSchema, value)).toBe(true)
    },
  )

  it.each(['2026-99-99T99:99:99Z', '2026-02-30T09:15:00Z'])(
    'rejects an impossible UTC RFC 3339 instant: %s',
    (value) => {
      expect(Value.Check(DateTimeSchema, value)).toBe(false)
    },
  )
})

const meta = {
  requestId: '019bfae5-c06f-77dd-8cf2-b2e0513a6789',
  serverTime: '2026-07-14T09:15:00.000Z',
}

const loginRequest = {
  code: '0a3xYp0000J6dR1ABCDEF9',
  deviceId: '5f8b68e8-4d4a-4df0-a7d1-3db4dcbcc001',
}

const loginResponse = {
  data: {
    accessToken: 'eyJhbGciOiJFZERTQSJ9.payload.signature',
    accessTokenExpiresIn: 900,
    refreshToken: 'rft_5hM2J1K4pQ8xW7vN3sR9',
    refreshTokenExpiresIn: 2_592_000,
    isNewUser: true,
    user: {
      id: '019bfae0-7b1a-7c32-89fd-6dfb0ce51234',
      nickname: null,
      nicknameConfirmed: false,
      createdAt: '2026-07-14T09:15:00.000Z',
    },
  },
  meta,
}

const initializeRequest = {
  fileName: 'summer-video.mov',
  kind: 'video',
  mimeType: 'video/quicktime',
  sizeBytes: 12_582_913,
}

const initializeResponse = {
  data: {
    upload: {
      id: '019bfae2-9d3c-7a10-89df-8fbd2e073456',
      mediaId: '019bfae1-8c2b-7b21-98ce-7eac1df62345',
      status: 'uploading',
      fileName: 'summer-video.mov',
      kind: 'video',
      mimeType: 'video/quicktime',
      sizeBytes: 12_582_913,
      partSizeBytes: 8_388_608,
      partCount: 2,
      expiresAt: '2026-07-15T09:20:00.000Z',
      createdAt: '2026-07-14T09:20:00.000Z',
    },
    parts: [
      { partNumber: 1, offsetBytes: 0, sizeBytes: 8_388_608, status: 'pending' },
      { partNumber: 2, offsetBytes: 8_388_608, sizeBytes: 4_194_305, status: 'pending' },
    ],
  },
  meta,
}

const uploadDetailResponse = {
  data: {
    upload: {
      id: '019bfae2-9d3c-7a10-89df-8fbd2e073456',
      mediaId: '019bfae1-8c2b-7b21-98ce-7eac1df62345',
      status: 'uploading',
      fileName: 'summer-video.mov',
      kind: 'video',
      mimeType: 'video/quicktime',
      sizeBytes: 12_582_913,
      progress: {
        confirmedBytes: 8_388_608,
        totalBytes: 12_582_913,
        uploadedParts: 1,
        totalParts: 2,
        percent: 66.67,
      },
      expiresAt: '2026-07-15T09:20:00.000Z',
      failure: null,
      createdAt: '2026-07-14T09:20:00.000Z',
      updatedAt: '2026-07-14T09:21:08.000Z',
    },
    partDetailsRetained: true,
    partsAvailableUntil: null,
    parts: [
      {
        partNumber: 1,
        offsetBytes: 0,
        sizeBytes: 8_388_608,
        status: 'uploaded',
        sha256: 'a'.repeat(64),
      },
      {
        partNumber: 2,
        offsetBytes: 8_388_608,
        sizeBytes: 4_194_305,
        status: 'pending',
        sha256: null,
      },
    ],
    pollAfterSeconds: 2,
  },
  meta,
}

const uploadHistoryResponse = {
  data: {
    items: [
      {
        id: '019bfae2-9d3c-7a10-89df-8fbd2e073456',
        mediaId: '019bfae1-8c2b-7b21-98ce-7eac1df62345',
        status: 'uploaded',
        fileName: 'summer-video.mov',
        kind: 'video',
        mimeType: 'video/quicktime',
        sizeBytes: 12_582_913,
        progress: {
          confirmedBytes: 12_582_913,
          totalBytes: 12_582_913,
          percent: 100,
        },
        failure: null,
        createdAt: '2026-07-14T09:20:00.000Z',
        updatedAt: '2026-07-14T09:23:03.000Z',
      },
    ],
  },
  meta: {
    ...meta,
    pagination: {
      limit: 20,
      hasMore: false,
      nextCursor: null,
    },
  },
}

describe('public request schemas', () => {
  it('accepts the documented WeChat login request', () => {
    expect(Value.Check(WechatLoginRequestSchema, loginRequest)).toBe(true)
  })

  it('accepts the documented nickname confirmation request', () => {
    expect(
      Value.Check(NicknameRequestSchema, {
        nickname: '小晴',
        source: 'wechatNicknameInput',
        confirmed: true,
      }),
    ).toBe(true)
  })

  it('accepts the documented initialize and complete requests', () => {
    expect(Value.Check(InitializeUploadRequestSchema, initializeRequest)).toBe(true)
    expect(Value.Check(CompleteUploadRequestSchema, {})).toBe(true)
  })

  it('rejects unknown request fields', () => {
    expect(Value.Check(WechatLoginRequestSchema, { ...loginRequest, unexpected: true })).toBe(false)
    expect(Value.Check(CompleteUploadRequestSchema, { etags: [] })).toBe(false)
  })

  it('rejects a device identifier that PostgreSQL cannot store', () => {
    expect(
      Value.Check(WechatLoginRequestSchema, { ...loginRequest, deviceId: 'device\u0000id' }),
    ).toBe(false)
  })

  it('rejects unsupported MIME and out-of-range file sizes', () => {
    expect(
      Value.Check(InitializeUploadRequestSchema, {
        ...initializeRequest,
        mimeType: 'application/octet-stream',
      }),
    ).toBe(false)
    expect(
      Value.Check(InitializeUploadRequestSchema, { ...initializeRequest, sizeBytes: 11 }),
    ).toBe(false)
    expect(
      Value.Check(InitializeUploadRequestSchema, {
        ...initializeRequest,
        sizeBytes: 209_715_201,
      }),
    ).toBe(false)
  })
})

describe('public response schemas', () => {
  it('accepts the documented login and initialize responses', () => {
    expect(Value.Check(WechatLoginResponseSchema, loginResponse)).toBe(true)
    expect(Value.Check(InitializeUploadResponseSchema, initializeResponse)).toBe(true)
  })

  it('accepts the documented upload detail response', () => {
    expect(Value.Check(UploadDetailResponseSchema, uploadDetailResponse)).toBe(true)
  })

  it('accepts the documented upload history response', () => {
    expect(Value.Check(UploadHistoryResponseSchema, uploadHistoryResponse)).toBe(true)
  })

  it.each([
    [
      'initialize',
      InitializeUploadResponseSchema,
      {
        ...initializeResponse,
        data: {
          ...initializeResponse.data,
          upload: { ...initializeResponse.data.upload, kind: 'image' },
        },
      },
    ],
    [
      'detail',
      UploadDetailResponseSchema,
      {
        ...uploadDetailResponse,
        data: {
          ...uploadDetailResponse.data,
          upload: { ...uploadDetailResponse.data.upload, kind: 'image' },
        },
      },
    ],
    [
      'history',
      UploadHistoryResponseSchema,
      {
        ...uploadHistoryResponse,
        data: {
          items: uploadHistoryResponse.data.items.map((item) => ({ ...item, kind: 'image' })),
        },
      },
    ],
  ] as const)('rejects a kind and MIME mismatch in the %s response', (_name, schema, value) => {
    expect(Value.Check(schema, value)).toBe(false)
  })

  it('rejects an eighth public upload status', () => {
    const invalid = structuredClone(uploadHistoryResponse)
    const firstItem = invalid.data.items.at(0)
    expect(firstItem).toBeDefined()
    if (firstItem === undefined) return
    firstItem.status = 'processing'

    expect(Value.Check(UploadHistoryResponseSchema, invalid)).toBe(false)
  })

  it('rejects identity and storage internals at every public boundary', () => {
    expect(
      Value.Check(WechatLoginResponseSchema, {
        ...loginResponse,
        data: { ...loginResponse.data, openid: 'private-openid' },
      }),
    ).toBe(false)
    expect(
      Value.Check(InitializeUploadResponseSchema, {
        ...initializeResponse,
        data: {
          ...initializeResponse.data,
          upload: { ...initializeResponse.data.upload, objectKey: 'users/private/file.mov' },
        },
      }),
    ).toBe(false)
    expect(
      Value.Check(ErrorEnvelopeSchema, {
        error: {
          code: 'STORAGE_UNAVAILABLE',
          message: '对象存储暂时不可用',
          retryable: true,
          details: { objectKey: 'users/private/file.mov' },
        },
        meta,
      }),
    ).toBe(false)

    const serializedSchemas = JSON.stringify(PUBLIC_SCHEMAS)
    expect(serializedSchemas).not.toMatch(
      /openid|unionid|session_key|sessionKey|r2Bucket|objectKey|r2UploadId|etag|signedUrl/i,
    )
  })
})
