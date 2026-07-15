import type { PublicUser, UploadPartResponse } from '@wx-upload/contracts'
import { describe, expect, it, vi } from 'vitest'

import type { AuthorizedSession } from '../miniprogram/services/api-client.js'
import { createWechatRuntime } from '../miniprogram/runtime/wechat-runtime.js'
import {
  AuthorizedUploadTransport,
  uploadFileWithWechatRuntime,
  type UploadFileRequest,
  type UploadFileResponse,
  type WechatUploadRuntime,
  type WxUploadSource,
} from '../miniprogram/runtime/wx-upload.js'

const publicUser: PublicUser = {
  id: '01981d0c-ec80-7000-8000-000000000101',
  nickname: '小晴',
  nicknameConfirmed: true,
  nicknameConfirmedAt: '2026-07-15T05:00:00.000Z',
  createdAt: '2026-07-15T04:00:00.000Z',
  updatedAt: '2026-07-15T05:00:00.000Z',
}

const meta = {
  requestId: '01981d0c-ec80-7000-8000-000000000102',
  serverTime: '2026-07-15T05:10:00.000Z',
}

const successfulData: UploadPartResponse['data'] = {
  part: {
    partNumber: 1,
    sizeBytes: 8_388_608,
    sha256: 'a'.repeat(64),
    status: 'uploaded',
    uploadedAt: '2026-07-15T05:10:00.000Z',
  },
  progress: {
    confirmedBytes: 8_388_608,
    totalBytes: 12_582_913,
    uploadedParts: 1,
    totalParts: 2,
    percent: 66.67,
  },
  replayed: false,
}

function uploadResponse(statusCode: number, body: unknown): UploadFileResponse {
  return { statusCode, data: JSON.stringify(body), headers: {} }
}

function tokenExpiredResponse(): UploadFileResponse {
  return uploadResponse(401, {
    error: { code: 'TOKEN_EXPIRED', message: 'raw upstream token text', retryable: true },
    meta,
  })
}

function successResponse(data: UploadPartResponse['data'] = successfulData): UploadFileResponse {
  return uploadResponse(200, { data, meta })
}

function uploadInput() {
  return {
    uploadId: '01981d0c-ec80-7000-8000-000000000103',
    partNumber: 1,
    sha256: 'a'.repeat(64),
    chunkSizeBytes: 8_388_608,
    tempPath: 'wxfile://tmp/private-part-1',
  }
}

interface TransportFixture {
  transport: AuthorizedUploadTransport
  uploadFile: ReturnType<typeof vi.fn<(request: UploadFileRequest) => Promise<UploadFileResponse>>>
  ensureSession: ReturnType<typeof vi.fn<AuthorizedSession['ensureSession']>>
  refreshOnce: ReturnType<typeof vi.fn<AuthorizedSession['refreshOnce']>>
}

function transportFixture(): TransportFixture {
  const uploadFile = vi
    .fn<(request: UploadFileRequest) => Promise<UploadFileResponse>>()
    .mockResolvedValue(successResponse())
  const runtime: WechatUploadRuntime = { uploadFile }
  const current = { accessToken: 'access-old', refreshToken: 'refresh-old', user: publicUser }
  const ensureSession = vi.fn<AuthorizedSession['ensureSession']>().mockResolvedValue(current)
  const refreshOnce = vi.fn<AuthorizedSession['refreshOnce']>().mockResolvedValue({
    ...current,
    accessToken: 'access-new',
    refreshToken: 'refresh-new',
  })
  const session: AuthorizedSession = { ensureSession, refreshOnce }
  return {
    transport: new AuthorizedUploadTransport({
      runtime,
      session,
      baseUrl: 'https://api.example.com',
    }),
    uploadFile,
    ensureSession,
    refreshOnce,
  }
}

describe('WeChat uploadFile runtime adapter', () => {
  it('adds the upload capability to the composed WeChat runtime when available', () => {
    const source = {
      login: vi.fn(),
      request: vi.fn(),
      getStorageSync: vi.fn(),
      setStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
      uploadFile: vi.fn(() => ({ onProgressUpdate: vi.fn() })),
    }

    const runtime = createWechatRuntime(source)

    expect(typeof runtime.uploadFile).toBe('function')
  })

  it('maps upload fields and forwards UploadTask progress', async () => {
    let success:
      | ((result: {
          statusCode: number
          data: string
          header: Record<string, string | readonly string[]>
        }) => void)
      | undefined
    let progress:
      | ((event: {
          progress: number
          totalBytesSent: number
          totalBytesExpectedToSend: number
        }) => void)
      | undefined
    const uploadFile = vi.fn<WxUploadSource['uploadFile']>((options) => {
      success = (result) => {
        options.success(result)
      }
      return {
        onProgressUpdate(callback) {
          progress = callback
        },
      }
    })
    const source: WxUploadSource = { uploadFile }
    const onProgress = vi.fn()
    const pending = uploadFileWithWechatRuntime(source, {
      url: 'https://api.example.com/v1/uploads/upload-1/parts/1',
      filePath: 'wxfile://tmp/chunk',
      name: 'chunk',
      headers: {
        Authorization: 'Bearer access-token',
        'X-Chunk-SHA256': 'a'.repeat(64),
      },
      formData: { chunkSizeBytes: '12' },
      onProgress,
    })

    progress?.({ progress: 25, totalBytesSent: 3, totalBytesExpectedToSend: 12 })
    success?.({ statusCode: 200, data: '{"data":{}}', header: { trace: 'safe' } })

    await expect(pending).resolves.toEqual({
      statusCode: 200,
      data: '{"data":{}}',
      headers: { trace: 'safe' },
    })
    expect(onProgress).toHaveBeenCalledWith({
      progress: 25,
      totalBytesSent: 3,
      totalBytesExpectedToSend: 12,
    })
    expect(uploadFile).toHaveBeenCalledWith(
      expect.objectContaining({
        timeout: 180_000,
        filePath: 'wxfile://tmp/chunk',
        name: 'chunk',
        header: {
          Authorization: 'Bearer access-token',
          'X-Chunk-SHA256': 'a'.repeat(64),
        },
        formData: { chunkSizeBytes: '12' },
      }),
    )
  })

  it('accepts the official success result when WeChat omits response headers', async () => {
    let succeed: ((result: unknown) => void) | undefined
    const source: WxUploadSource = {
      uploadFile(options) {
        succeed = (result) => {
          options.success(result as never)
        }
        return { onProgressUpdate: vi.fn() }
      },
    }
    const pending = uploadFileWithWechatRuntime(source, {
      url: 'https://api.example.com/v1/uploads/upload-1/parts/1',
      filePath: 'wxfile://tmp/chunk',
      name: 'chunk',
      headers: { Authorization: 'Bearer access-token' },
      formData: { chunkSizeBytes: '12' },
    })

    expect(() => succeed?.({ statusCode: 200, data: '{"data":{}}' })).not.toThrow()
    await expect(pending).resolves.toEqual({
      statusCode: 200,
      data: '{"data":{}}',
      headers: {},
    })
  })

  it('rejects safely when a later success callback contains an unreadable result', async () => {
    let succeed: ((result: unknown) => void) | undefined
    const source: WxUploadSource = {
      uploadFile(options) {
        succeed = (result) => {
          options.success(result as never)
        }
        return { onProgressUpdate: vi.fn() }
      },
    }
    const pending = uploadFileWithWechatRuntime(source, {
      url: 'https://api.example.com/v1/uploads/upload-1/parts/1',
      filePath: 'wxfile://tmp/private',
      name: 'chunk',
      headers: { Authorization: 'Bearer bearer-secret' },
      formData: { chunkSizeBytes: '12' },
    })
    const malformed = Object.defineProperty({}, 'statusCode', {
      get() {
        throw new Error('private callback details')
      },
    })

    expect(() => succeed?.(malformed)).not.toThrow()
    await expect(pending).rejects.toMatchObject({
      message: 'WeChat upload failed',
      networkError: true,
    })
    await expect(pending).rejects.not.toThrow(/private callback details/u)
  })

  it('turns a runtime fail callback into a sanitized error', async () => {
    const source: WxUploadSource = {
      uploadFile(options) {
        options.fail({
          errMsg: 'uploadFile:fail wxfile://tmp/private bearer-secret raw-runtime-text',
        })
        return { onProgressUpdate: vi.fn() }
      },
    }

    const promise = uploadFileWithWechatRuntime(source, {
      url: 'https://api.example.com/v1/uploads/upload-1/parts/1',
      filePath: 'wxfile://tmp/private',
      name: 'chunk',
      headers: { Authorization: 'Bearer bearer-secret' },
      formData: { chunkSizeBytes: '12' },
    })

    await expect(promise).rejects.toMatchObject({
      message: 'WeChat upload failed',
      networkError: true,
    })
    await expect(promise).rejects.not.toThrow(/private|bearer-secret|raw-runtime-text/u)
  })

  it('marks a synchronous runtime failure as a retryable network error', async () => {
    const source: WxUploadSource = {
      uploadFile() {
        throw new Error('raw bearer-secret and private path')
      },
    }

    const promise = uploadFileWithWechatRuntime(source, {
      url: 'https://api.example.com/v1/uploads/upload-1/parts/1',
      filePath: 'wxfile://tmp/private',
      name: 'chunk',
      headers: { Authorization: 'Bearer bearer-secret' },
      formData: { chunkSizeBytes: '12' },
    })

    await expect(promise).rejects.toMatchObject({
      message: 'WeChat upload failed',
      networkError: true,
    })
    await expect(promise).rejects.not.toThrow(/private|bearer-secret|raw/u)
  })
})

describe('AuthorizedUploadTransport', () => {
  it('uploads the fixed chunk field and parses the string success envelope', async () => {
    const { transport, uploadFile, ensureSession } = transportFixture()

    await expect(transport.uploadPart(uploadInput())).resolves.toEqual(successfulData)

    expect(ensureSession).toHaveBeenCalledOnce()
    expect(uploadFile).toHaveBeenCalledWith({
      url: 'https://api.example.com/v1/uploads/01981d0c-ec80-7000-8000-000000000103/parts/1',
      filePath: 'wxfile://tmp/private-part-1',
      name: 'chunk',
      timeout: 180_000,
      headers: {
        Authorization: 'Bearer access-old',
        'X-Chunk-SHA256': 'a'.repeat(64),
      },
      formData: { chunkSizeBytes: '8388608' },
      onProgress: undefined,
    })
  })

  it('forwards progress updates for the current part', async () => {
    const { transport, uploadFile } = transportFixture()
    const onProgress = vi.fn()
    uploadFile.mockImplementationOnce((request) => {
      request.onProgress?.({
        progress: 50,
        totalBytesSent: 4_194_304,
        totalBytesExpectedToSend: 8_388_608,
      })
      return Promise.resolve(successResponse())
    })

    await transport.uploadPart({ ...uploadInput(), onProgress })

    expect(onProgress).toHaveBeenCalledWith({
      progress: 50,
      totalBytesSent: 4_194_304,
      totalBytesExpectedToSend: 8_388_608,
    })
  })

  it.each([
    ['not JSON and contains wxfile://tmp/private bearer-secret', 'non-JSON'],
    [JSON.stringify({ data: { part: {} }, meta }), 'malformed success'],
    [JSON.stringify({ error: { code: 42 }, meta }), 'malformed error'],
    [
      JSON.stringify({
        data: { ...successfulData, objectKey: 'private/storage/path' },
        meta,
      }),
      'success with an unknown field',
    ],
  ])('fails safely for a %s response (%s)', async (body) => {
    const { transport, uploadFile } = transportFixture()
    uploadFile.mockResolvedValueOnce({ statusCode: 200, data: body, headers: {} })

    const error = await transport.uploadPart(uploadInput()).catch((failure: unknown) => failure)

    expect(error).toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(String(error)).not.toContain(body)
    expect(String(error)).not.toMatch(/wxfile|bearer-secret/u)
  })

  it('does not retry a business 4xx or expose its raw response message', async () => {
    const { transport, uploadFile, refreshOnce } = transportFixture()
    uploadFile.mockResolvedValueOnce(
      uploadResponse(422, {
        error: {
          code: 'PART_LENGTH_MISMATCH',
          message: 'raw server text wxfile://private bearer-secret',
          retryable: false,
        },
        meta,
      }),
    )

    const error = await transport.uploadPart(uploadInput()).catch((failure: unknown) => failure)

    expect(error).toMatchObject({ statusCode: 422, code: 'PART_LENGTH_MISMATCH' })
    expect(String(error)).not.toMatch(/raw server|wxfile|bearer-secret/u)
    expect(refreshOnce).not.toHaveBeenCalled()
    expect(uploadFile).toHaveBeenCalledOnce()
  })

  it('refreshes one TOKEN_EXPIRED response and retries the exact same part once', async () => {
    const { transport, uploadFile, refreshOnce } = transportFixture()
    uploadFile
      .mockResolvedValueOnce(tokenExpiredResponse())
      .mockResolvedValueOnce(successResponse())
    const input = uploadInput()
    const before = structuredClone(input)

    await expect(transport.uploadPart(input)).resolves.toEqual(successfulData)

    expect(refreshOnce).toHaveBeenCalledOnce()
    expect(refreshOnce).toHaveBeenCalledWith('access-old')
    expect(uploadFile).toHaveBeenCalledTimes(2)
    const first = uploadFile.mock.calls[0]?.[0]
    const second = uploadFile.mock.calls[1]?.[0]
    expect(second).toEqual({
      ...first,
      headers: {
        Authorization: 'Bearer access-new',
        'X-Chunk-SHA256': 'a'.repeat(64),
      },
    })
    expect(input).toEqual(before)
  })

  it('snapshots part identity before waiting for refresh recovery', async () => {
    const { transport, uploadFile, refreshOnce } = transportFixture()
    let releaseRefresh:
      ((value: Awaited<ReturnType<AuthorizedSession['refreshOnce']>>) => void) | undefined
    refreshOnce.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releaseRefresh = resolve
        }),
    )
    uploadFile
      .mockResolvedValueOnce(tokenExpiredResponse())
      .mockResolvedValueOnce(successResponse())
    const input = uploadInput()
    const pending = transport.uploadPart(input)
    await vi.waitFor(() => {
      expect(refreshOnce).toHaveBeenCalledOnce()
    })

    input.uploadId = '01981d0c-ec80-7000-8000-000000000999'
    input.partNumber = 9
    input.sha256 = 'b'.repeat(64)
    input.chunkSizeBytes = 12
    input.tempPath = 'wxfile://tmp/attacker-replacement'
    releaseRefresh?.({
      accessToken: 'access-fresh-login',
      refreshToken: 'refresh-fresh-login',
      user: publicUser,
    })
    await pending

    expect(uploadFile.mock.calls[1]?.[0]).toMatchObject({
      url: 'https://api.example.com/v1/uploads/01981d0c-ec80-7000-8000-000000000103/parts/1',
      filePath: 'wxfile://tmp/private-part-1',
      headers: { 'X-Chunk-SHA256': 'a'.repeat(64) },
      formData: { chunkSizeBytes: '8388608' },
    })
  })

  it('stops after a second TOKEN_EXPIRED response', async () => {
    const { transport, uploadFile, refreshOnce } = transportFixture()
    uploadFile
      .mockResolvedValueOnce(tokenExpiredResponse())
      .mockResolvedValueOnce(tokenExpiredResponse())

    await expect(transport.uploadPart(uploadInput())).rejects.toMatchObject({
      statusCode: 401,
      code: 'TOKEN_EXPIRED',
    })

    expect(refreshOnce).toHaveBeenCalledOnce()
    expect(uploadFile).toHaveBeenCalledTimes(2)
  })

  it('shares SessionStore single-flight refresh across concurrent 401 responses', async () => {
    const { uploadFile } = transportFixture()
    let refreshStarts = 0
    let refreshPromise: Promise<Awaited<ReturnType<AuthorizedSession['refreshOnce']>>> | undefined
    const session: AuthorizedSession = {
      ensureSession: () =>
        Promise.resolve({
          accessToken: 'access-old',
          refreshToken: 'refresh-old',
          user: publicUser,
        }),
      refreshOnce: () => {
        refreshPromise ??= Promise.resolve().then(() => {
          refreshStarts += 1
          return {
            accessToken: 'access-new',
            refreshToken: 'refresh-new',
            user: publicUser,
          }
        })
        return refreshPromise
      },
    }
    uploadFile.mockImplementation((request) =>
      Promise.resolve(
        request.headers['Authorization'] === 'Bearer access-old'
          ? tokenExpiredResponse()
          : successResponse({
              ...successfulData,
              part: {
                ...successfulData.part,
                partNumber: request.url.endsWith('/2') ? 2 : 1,
              },
            }),
      ),
    )
    const runtime: WechatUploadRuntime = { uploadFile }
    const transport = new AuthorizedUploadTransport({
      runtime,
      session,
      baseUrl: 'https://api.example.com',
    })

    await Promise.all([
      transport.uploadPart(uploadInput()),
      transport.uploadPart({ ...uploadInput(), partNumber: 2, tempPath: 'wxfile://tmp/part-2' }),
    ])

    expect(refreshStarts).toBe(1)
    expect(uploadFile).toHaveBeenCalledTimes(4)
  })

  it('uses a fresh-login session returned after refresh loss', async () => {
    const { transport, uploadFile, refreshOnce } = transportFixture()
    uploadFile
      .mockResolvedValueOnce(tokenExpiredResponse())
      .mockResolvedValueOnce(successResponse())
    refreshOnce.mockResolvedValueOnce({
      accessToken: 'access-after-fresh-wx-login',
      refreshToken: 'refresh-after-fresh-wx-login',
      user: publicUser,
    })

    await transport.uploadPart(uploadInput())

    expect(uploadFile.mock.calls[1]?.[0].headers['Authorization']).toBe(
      'Bearer access-after-fresh-wx-login',
    )
  })

  it('does not allow caller-supplied authorization metadata to override the session', async () => {
    const { transport, uploadFile } = transportFixture()
    const untrusted = {
      ...uploadInput(),
      headers: { Authorization: 'Bearer attacker-token', authorization: 'Bearer attacker-two' },
    }

    await transport.uploadPart(untrusted)

    expect(uploadFile.mock.calls[0]?.[0].headers).toEqual({
      Authorization: 'Bearer access-old',
      'X-Chunk-SHA256': 'a'.repeat(64),
    })
  })

  it('rejects a non-origin base URL and invalid upload identity before touching the runtime', async () => {
    const fixture = transportFixture()
    expect(
      () =>
        new AuthorizedUploadTransport({
          runtime: { uploadFile: fixture.uploadFile },
          session: {
            ensureSession: fixture.ensureSession,
            refreshOnce: fixture.refreshOnce,
          },
          baseUrl: 'https://attacker@api.example.com/v1',
        }),
    ).toThrow(/origin/i)

    await expect(
      fixture.transport.uploadPart({ ...uploadInput(), uploadId: '../other-user' }),
    ).rejects.toThrow('uploadId is invalid')
    expect(fixture.uploadFile).not.toHaveBeenCalled()
  })
})
