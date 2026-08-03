/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method -- This integration fixture models callback-shaped WeChat APIs and inspects Vitest call records. */
import { PART_SIZE_BYTES, type PublicUser, type UploadHistoryResponse } from '@wx-upload/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApplicationGlobalData } from '../miniprogram/app.js'
import { validateMediaSelection } from '../miniprogram/core/media-validation.js'
import type { UploadRunnerResumeMetadata } from '../miniprogram/services/upload-runner.js'

const uploadId = '01981d0c-ec80-7000-8000-000000000201'
const mediaId = '01981d0c-ec80-7000-8000-000000000202'
const requestId = '01981d0c-ec80-7000-8000-000000000203'
const initializeKey = '01981d0c-ec80-7000-8000-000000000204'
const completeKey = '01981d0c-ec80-7000-8000-000000000205'
const now = '2026-07-15T06:00:00.000Z'
const later = '2026-07-16T06:00:00.000Z'
const sourcePath = 'wxfile://tmp/private-photo.jpg'
const userDataPath = 'wxfile://usr'

const publicUser: PublicUser = {
  id: '01981d0c-ec80-7000-8000-000000000101',
  nickname: '小晴',
  nicknameConfirmed: true,
  nicknameConfirmedAt: now,
  createdAt: now,
  updatedAt: now,
}

interface RegisteredApplication {
  globalData: ApplicationGlobalData
  onLaunch?: (this: RegisteredApplication) => void
  onHide?: (this: RegisteredApplication) => void
  onShow?: (this: RegisteredApplication) => void
}

interface WxRequestOptions {
  readonly url: string
  readonly method: string
  readonly header?: Record<string, string>
  readonly data?: unknown
  success(result: { statusCode: number; data: unknown; header: Record<string, string> }): void
  fail(reason: unknown): void
}

interface UploadFileOptions {
  readonly url: string
  readonly filePath: string
  readonly name: string
  readonly header: Record<string, string>
  readonly formData: Record<string, string>
  success(result: {
    statusCode: number
    data: string
    header: Record<string, string | readonly string[]>
  }): void
  fail(reason: unknown): void
}

interface FileManager {
  open(options: {
    readonly filePath: string
    success(result: { fd: string }): void
    fail(reason: unknown): void
  }): void
  read(options: {
    readonly arrayBuffer: ArrayBuffer
    readonly position: number
    readonly length: number
    success(result: { bytesRead: number; arrayBuffer: ArrayBuffer }): void
    fail(reason: unknown): void
  }): void
  close(options: { success(): void; fail(reason: unknown): void }): void
  writeFile(options: {
    readonly filePath: string
    readonly data: ArrayBuffer
    success(): void
    fail(reason: unknown): void
  }): void
  unlink(options: { readonly filePath: string; success(): void; fail(reason: unknown): void }): void
  readdir(options: {
    readonly dirPath: string
    success(result: { files: string[] }): void
    fail(reason: unknown): void
  }): void
}

const historyItems: UploadHistoryResponse['data']['items'] = [
  {
    id: uploadId,
    mediaId,
    status: 'uploaded',
    fileName: 'private-photo.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 12,
    progress: { confirmedBytes: 12, totalBytes: 12, percent: 100 },
    failure: null,
    createdAt: now,
    updatedAt: now,
  },
]

function meta(pagination?: {
  readonly limit: number
  readonly hasMore: boolean
  readonly nextCursor: string | null
}) {
  return {
    requestId,
    serverTime: now,
    ...(pagination === undefined ? {} : { pagination }),
  }
}

function loginData() {
  return {
    accessToken: 'access-one',
    accessTokenExpiresIn: 900,
    refreshToken: 'refresh-one',
    refreshTokenExpiresIn: 2_592_000,
    isNewUser: false,
    user: publicUser,
  }
}

function initializeData() {
  return {
    upload: {
      id: uploadId,
      mediaId,
      status: 'uploading',
      fileName: 'private-photo.jpg',
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 12,
      partSizeBytes: PART_SIZE_BYTES,
      partCount: 1,
      expiresAt: later,
      createdAt: now,
    },
    parts: [{ partNumber: 1, offsetBytes: 0, sizeBytes: 12, status: 'pending' }],
  }
}

function detailData(status: 'finalizing' | 'uploaded') {
  return {
    upload: {
      id: uploadId,
      mediaId,
      status,
      fileName: 'private-photo.jpg',
      kind: 'image',
      mimeType: 'image/jpeg',
      sizeBytes: 12,
      progress: {
        confirmedBytes: 12,
        totalBytes: 12,
        uploadedParts: 1,
        totalParts: 1,
        percent: 100,
      },
      expiresAt: later,
      failure: null,
      createdAt: now,
      updatedAt: now,
    },
    partDetailsRetained: true,
    partsAvailableUntil: null,
    parts: [
      {
        partNumber: 1,
        offsetBytes: 0,
        sizeBytes: 12,
        status: 'uploaded',
        sha256: 'a'.repeat(64),
      },
    ],
    pollAfterSeconds: status === 'finalizing' ? 2 : null,
  }
}

interface FixtureOptions {
  readonly cancelSelection?: boolean
  readonly initialStorage?: Readonly<Record<string, unknown>>
  readonly deferDetail?: boolean
  readonly deferPartUpload?: boolean
  readonly failPartUpload?: boolean
  readonly failFirstDetailNonRetryable?: boolean
}

async function fixture(options: FixtureOptions = {}) {
  const storage = new Map(Object.entries(options.initialStorage ?? {}))
  const requests: WxRequestOptions[] = []
  const uploadCalls: UploadFileOptions[] = []
  const written = new Map<string, ArrayBuffer>()
  const source = Uint8Array.from({ length: 12 }, (_value, index) => index + 1)
  let application: RegisteredApplication | undefined
  let randomCounter = 0
  let deferredDetail: WxRequestOptions | undefined
  let deferredPartUpload: UploadFileOptions | undefined
  let detailFailed = false

  const succeedPartUpload = (uploadOptions: UploadFileOptions): void => {
    const hash = uploadOptions.header['X-Chunk-SHA256'] ?? ''
    uploadOptions.success({
      statusCode: 200,
      data: JSON.stringify({
        data: {
          part: {
            partNumber: 1,
            sizeBytes: 12,
            sha256: hash,
            status: 'uploaded',
            uploadedAt: now,
          },
          progress: {
            confirmedBytes: 12,
            totalBytes: 12,
            uploadedParts: 1,
            totalParts: 1,
            percent: 100,
          },
          replayed: false,
        },
        meta: meta(),
      }),
      header: {},
    })
  }

  const fileManager: FileManager = {
    open: vi.fn<FileManager['open']>((fileOptions) => {
      if (fileOptions.filePath !== sourcePath) {
        fileOptions.fail(new Error('missing file'))
        return
      }
      fileOptions.success({ fd: 'source-fd' })
    }),
    read: vi.fn<FileManager['read']>((fileOptions) => {
      const bytes = source.slice(fileOptions.position, fileOptions.position + fileOptions.length)
      fileOptions.success({
        bytesRead: bytes.byteLength,
        arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      })
    }),
    close: vi.fn<FileManager['close']>((fileOptions) => {
      fileOptions.success()
    }),
    writeFile: vi.fn<FileManager['writeFile']>((fileOptions) => {
      written.set(fileOptions.filePath, fileOptions.data)
      fileOptions.success()
    }),
    unlink: vi.fn<FileManager['unlink']>((fileOptions) => {
      written.delete(fileOptions.filePath)
      fileOptions.success()
    }),
    readdir: vi.fn<FileManager['readdir']>((fileOptions) => {
      fileOptions.success({ files: [] })
    }),
  }

  const request = vi.fn((requestOptions: WxRequestOptions) => {
    requests.push(requestOptions)
    const success = (data: unknown, statusCode = 200) => {
      requestOptions.success({ statusCode, data: { data, meta: meta() }, header: {} })
    }
    if (requestOptions.url.endsWith('/v1/auth/wechat-login')) {
      success(loginData())
      return
    }
    if (requestOptions.url.endsWith('/v1/uploads') && requestOptions.method === 'POST') {
      requestOptions.success({
        statusCode: 201,
        data: { data: initializeData(), meta: meta() },
        header: {},
      })
      return
    }
    if (requestOptions.url.endsWith(`/v1/uploads/${uploadId}/complete`)) {
      requestOptions.success({
        statusCode: 202,
        data: {
          data: {
            upload: {
              id: uploadId,
              status: 'uploaded',
              progress: { confirmedBytes: 12, totalBytes: 12, percent: 100 },
            },
            pollAfterSeconds: null,
          },
          meta: meta(),
        },
        header: {},
      })
      return
    }
    if (requestOptions.url.endsWith(`/v1/uploads/${uploadId}/abort`)) {
      requestOptions.success({
        statusCode: 202,
        data: {
          data: {
            upload: { id: uploadId, status: 'cancelling' },
            pollAfterSeconds: 2,
          },
          meta: meta(),
        },
        header: {},
      })
      return
    }
    if (requestOptions.url.endsWith(`/v1/uploads/${uploadId}`)) {
      if (options.failFirstDetailNonRetryable && !detailFailed) {
        detailFailed = true
        requestOptions.success({
          statusCode: 404,
          data: {
            error: {
              code: 'UPLOAD_NOT_FOUND',
              message: '上传记录不存在',
              retryable: false,
            },
            meta: meta(),
          },
          header: {},
        })
        return
      }
      if (options.deferDetail && deferredDetail === undefined) {
        deferredDetail = requestOptions
        return
      }
      success(detailData('uploaded'))
      return
    }
    if (requestOptions.url.includes('/v1/uploads?')) {
      requestOptions.success({
        statusCode: 200,
        data: {
          data: { items: historyItems },
          meta: meta({ limit: 20, hasMore: false, nextCursor: null }),
        },
        header: {},
      })
      return
    }
    requestOptions.fail(new Error('unexpected request'))
  })

  vi.stubGlobal('wx', {
    env: { USER_DATA_PATH: userDataPath },
    chooseMedia: vi.fn(
      (pickerOptions: { success(result: unknown): void; fail(reason: unknown): void }) => {
        if (options.cancelSelection) {
          pickerOptions.fail({ errMsg: 'chooseMedia:fail cancel' })
          return
        }
        pickerOptions.success({
          errMsg: 'chooseMedia:ok',
          type: 'image',
          tempFiles: [{ tempFilePath: sourcePath, size: 12, fileType: 'image' }],
        })
      },
    ),
    getFileSystemManager: vi.fn(() => fileManager),
    getRandomValues: vi.fn(() => {
      randomCounter += 1
      const bytes = Uint8Array.from(
        { length: 16 },
        (_value, index) => (index + randomCounter) % 256,
      )
      return Promise.resolve({ randomValues: bytes.buffer, errMsg: 'getRandomValues:ok' })
    }),
    getStorageSync: (key: string) => storage.get(key),
    login: (loginOptions: { success(result: { code: string }): void }) => {
      loginOptions.success({ code: 'wx-code-upload' })
    },
    removeStorageSync: (key: string) => storage.delete(key),
    request,
    setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    uploadFile: vi.fn((uploadOptions: UploadFileOptions) => {
      uploadCalls.push(uploadOptions)
      if (options.failPartUpload) {
        uploadOptions.fail(new Error('temporary upload network failure'))
        return { onProgressUpdate: vi.fn() }
      }
      if (options.deferPartUpload && deferredPartUpload === undefined) {
        deferredPartUpload = uploadOptions
        return { onProgressUpdate: vi.fn() }
      }
      succeedPartUpload(uploadOptions)
      return { onProgressUpdate: vi.fn() }
    }),
  })
  vi.stubGlobal('App', (definition: RegisteredApplication) => {
    application = definition
  })

  await import('../miniprogram/app.js')
  if (application === undefined) throw new Error('App was not registered')
  return {
    application,
    fileManager,
    requests,
    uploadCalls,
    storage,
    written,
    resolveDeferredDetail() {
      deferredDetail?.success({
        statusCode: 200,
        data: { data: detailData('uploaded'), meta: meta() },
        header: {},
      })
    },
    resolveDeferredPartUpload() {
      const deferred = deferredPartUpload
      if (deferred === undefined) throw new Error('part upload is not deferred')
      deferredPartUpload = undefined
      succeedPartUpload(deferred)
    },
  }
}

async function flush(count = 20): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('application upload wiring', () => {
  it('does not initialize an upload when media selection is cancelled', async () => {
    const { application, requests } = await fixture({ cancelSelection: true })

    await expect(application.globalData.mediaUpload.chooseMedia()).rejects.toMatchObject({
      code: 'CANCELLED',
    })
    expect(requests.some((request) => request.url.endsWith('/v1/uploads'))).toBe(false)
  })

  it('wires confirmed selection through bounded chunk upload, completion, and history APIs', async () => {
    vi.useFakeTimers()
    const { application, fileManager, requests, uploadCalls, storage, written } = await fixture()
    const selected = validateMediaSelection(await application.globalData.mediaUpload.chooseMedia())
    const updates: unknown[] = []

    const starting = application.globalData.mediaUpload.start(selected, (event) => {
      updates.push(event)
    })
    await flush(40)

    expect(requests.some((request) => request.url.endsWith('/v1/uploads'))).toBe(true)
    expect(uploadCalls).toHaveLength(1)
    expect(uploadCalls[0]).toMatchObject({
      name: 'chunk',
      formData: { chunkSizeBytes: '12' },
    })
    await vi.waitFor(() => {
      expect(requests.find((request) => request.url.endsWith('/complete'))).toBeDefined()
    })
    expect(requests.find((request) => request.url.endsWith('/complete'))?.header).toMatchObject({
      'Idempotency-Key': expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    })
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(starting).resolves.toBeUndefined()

    expect(fileManager.readdir).toHaveBeenCalledWith(
      expect.objectContaining({ dirPath: userDataPath }),
    )
    expect(fileManager.read).toHaveBeenCalledWith(
      expect.objectContaining({ position: 0, length: 12 }),
    )
    expect(written.size).toBe(0)
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: 'uploading' }),
        expect.objectContaining({ status: 'uploaded', bytes: 12, percent: 100 }),
      ]),
    )
    expect(storage.has('privateMediaUploadResumeV1')).toBe(false)

    await expect(application.globalData.historyApi.list({ limit: 20 })).resolves.toEqual({
      items: historyItems,
      pagination: { limit: 20, hasMore: false, nextCursor: null },
    })
    await expect(application.globalData.historyApi.getUpload(uploadId)).resolves.toMatchObject({
      upload: { id: uploadId, status: 'uploaded' },
    })
    expect(requests.some((request) => request.url.endsWith('/v1/uploads?limit=20'))).toBe(true)
  })

  it('hands a batch to the application before completion and blocks a duplicate dispatch', async () => {
    vi.useFakeTimers()
    const { application, uploadCalls, resolveDeferredPartUpload, storage } = await fixture({
      deferPartUpload: true,
    })
    const selected = validateMediaSelection(await application.globalData.mediaUpload.chooseMedia())

    await expect(application.globalData.mediaUpload.dispatch(selected)).resolves.toBeUndefined()
    await vi.waitFor(() => {
      expect(uploadCalls).toHaveLength(1)
    })
    await expect(application.globalData.mediaUpload.dispatch(selected)).rejects.toMatchObject({
      name: 'ApplicationUploadBusyError',
    })

    resolveDeferredPartUpload()
    await vi.runAllTimersAsync()
    await vi.waitFor(() => {
      expect(storage.has('privateMediaUploadResumeV1')).toBe(false)
    })
  })

  it('wires history cancellation to the userCancelled abort endpoint with a fresh key', async () => {
    const { application, requests } = await fixture()

    await expect(application.globalData.historyApi.cancel(uploadId)).resolves.toBeUndefined()

    const cancellation = requests.find((request) =>
      request.url.endsWith(`/v1/uploads/${uploadId}/abort`),
    )
    expect(cancellation).toMatchObject({
      method: 'POST',
      data: { reason: 'userCancelled' },
      header: {
        'Idempotency-Key': expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        ),
      },
    })
  })

  it('does not automatically restore retained uploads on launch or foreground', async () => {
    const resume: UploadRunnerResumeMetadata = {
      version: 1,
      phase: 'finalizing',
      file: {
        sourcePath,
        fileName: 'private-photo.jpg',
        sizeBytes: 12,
        kind: 'image',
        mimeType: 'image/jpeg',
      },
      initializeIdempotencyKey: initializeKey,
      uploadId,
      parts: [{ partNumber: 1, offsetBytes: 0, sizeBytes: 12 }],
      confirmedBytes: 12,
      confirmedPartHashes: { 1: 'a'.repeat(64) },
      completeIdempotencyKey: completeKey,
      abortIdempotencyKey: null,
      paused: false,
    }
    const { application, requests, storage } = await fixture({
      initialStorage: {
        apiSession: {
          accessToken: 'access-restored',
          refreshToken: 'refresh-restored',
          user: publicUser,
        },
        installationId: 'installation-000102030405060708090a0b0c0d0e0f',
        privateMediaUploadResumeV1: resume,
      },
    })

    application.onShow?.call(application)
    application.onShow?.call(application)
    await flush()
    expect(
      requests.filter((request) => request.url.endsWith(`/v1/uploads/${uploadId}`)),
    ).toHaveLength(0)
    expect(storage.has('privateMediaUploadResumeV1')).toBe(true)

    await expect(
      application.globalData.historyApi.retry(uploadId, 'private-photo.jpg', 12),
    ).resolves.toBe(true)
    await vi.waitFor(() => {
      expect(
        requests.filter(
          (request) => request.url.endsWith('/v1/uploads') && request.method === 'POST',
        ),
      ).toHaveLength(1)
      expect(storage.has('privateMediaUploadResumeV1')).toBe(false)
    })
  })

  it('settles a terminal server result without issuing a redundant foreground refresh', async () => {
    const {
      application,
      requests,
      uploadCalls,
      storage,
      resolveDeferredDetail,
      resolveDeferredPartUpload,
    } = await fixture({ deferDetail: true, deferPartUpload: true })
    const selected = validateMediaSelection(await application.globalData.mediaUpload.chooseMedia())

    const starting = application.globalData.mediaUpload.start(selected, () => undefined)
    await vi.waitFor(() => {
      expect(uploadCalls).toHaveLength(1)
    })

    application.onHide?.call(application)
    await flush()
    application.onShow?.call(application)
    await flush()
    resolveDeferredPartUpload()
    await vi.waitFor(() => {
      expect(
        requests.filter((request) => request.url.endsWith(`/v1/uploads/${uploadId}`)),
      ).toHaveLength(1)
    })

    application.onHide?.call(application)
    await flush()
    application.onShow?.call(application)
    await flush()
    resolveDeferredDetail()

    await expect(starting).resolves.toBeUndefined()
    expect(
      requests.filter((request) => request.url.endsWith(`/v1/uploads/${uploadId}`)),
    ).toHaveLength(1)
    expect(storage.has('privateMediaUploadResumeV1')).toBe(false)
  })

  it('keeps retry metadata and makes only one part request when a live upload fails', async () => {
    const { application, requests, uploadCalls, storage } = await fixture({
      failPartUpload: true,
    })
    const selected = validateMediaSelection(await application.globalData.mediaUpload.chooseMedia())
    const updates: {
      readonly sourcePath: string
      readonly status: string
      readonly bytes: number
      readonly percent: number
    }[] = []

    const starting = application.globalData.mediaUpload.start(selected, (event) => {
      updates.push(event)
    })
    await expect(starting).resolves.toBeUndefined()
    expect(storage.has('privateMediaUploadResumeV1')).toBe(true)
    expect(uploadCalls).toHaveLength(1)
    expect(
      requests.filter((request) => request.url.endsWith(`/v1/uploads/${uploadId}`)),
    ).toHaveLength(0)
    expect(updates.some((event) => event.status === 'failed')).toBe(true)
    expect(updates.at(-1)).toMatchObject({
      sourcePath,
      status: 'failed',
    })
  })
})
