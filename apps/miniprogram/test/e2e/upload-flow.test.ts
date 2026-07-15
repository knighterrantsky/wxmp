import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { UploadQueue } from '../../miniprogram/core/upload-queue.js'
import type { WechatFileRuntime } from '../../miniprogram/runtime/wx-files.js'
import {
  AuthorizedUploadTransport,
  type WechatUploadRuntime,
} from '../../miniprogram/runtime/wx-upload.js'
import type {
  HttpRequest,
  HttpResponse,
  WechatRuntime,
} from '../../miniprogram/runtime/wechat-runtime.js'
import { ApiClient } from '../../miniprogram/services/api-client.js'
import { ChunkFileService } from '../../miniprogram/services/chunk-files.js'
import { CompletionController } from '../../miniprogram/services/completion-controller.js'
import { SessionStore } from '../../miniprogram/services/session-store.js'
import {
  createUploadResumeStore,
  UploadRunner,
  type UploadRunnerFile,
} from '../../miniprogram/services/upload-runner.js'

const SOURCE_PATH = '/memory/e2e-private.png'
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42,
])
const IDEMPOTENCY_KEYS = [
  '019f11a0-2000-7000-8000-000000000001',
  '019f11a0-2000-7000-8000-000000000002',
] as const

interface LocalServer {
  readonly origin: string
  stop(): Promise<void>
}

interface ApiHarness {
  readonly origin: string
  readonly finalizer: { runOnce(limit: number): Promise<unknown> }
  close(): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function startLocalServer(): Promise<LocalServer> {
  const moduleUrl = new URL(
    '../../../api/test/support/local-private-upload-harness.ts',
    import.meta.url,
  ).href
  const loaded: unknown = await import(moduleUrl)
  if (!isRecord(loaded) || typeof loaded['startLocalPrivateUploadHarness'] !== 'function') {
    throw new Error('Local API test harness is unavailable')
  }
  const start = loaded['startLocalPrivateUploadHarness'] as (options: {
    label: string
  }) => Promise<ApiHarness>
  const harness = await start({ label: 'mini-e2e' })
  let stopped = false
  let finalizerFailed = false
  let finalizerTail = Promise.resolve()
  const timer = setInterval(() => {
    if (stopped) return
    finalizerTail = finalizerTail
      .then(async () => {
        await harness.finalizer.runOnce(10)
      })
      .catch(() => {
        finalizerFailed = true
      })
  }, 20)
  return {
    origin: harness.origin,
    async stop() {
      if (stopped) return
      stopped = true
      clearInterval(timer)
      await finalizerTail
      await harness.close()
      if (finalizerFailed) throw new Error('Local E2E finalizer failed')
    },
  }
}

function memoryWechatRuntime(origin: string): {
  readonly runtime: WechatRuntime
  readonly files: Map<string, Uint8Array>
  readonly storage: Map<string, unknown>
} {
  const storage = new Map<string, unknown>()
  const files = new Map<string, Uint8Array>([[SOURCE_PATH, PNG_BYTES]])
  const runtime: WechatRuntime = {
    login: () => Promise.resolve({ code: 'dev:mini-e2e-user' }),
    async request<T>(
      request: HttpRequest,
      decode?: (value: unknown) => T,
    ): Promise<HttpResponse<T>> {
      if (!request.url.startsWith(origin)) throw new Error('unexpected test origin')
      const response = await fetch(request.url, {
        method: request.method,
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        ...(request.data === undefined ? {} : { body: JSON.stringify(request.data) }),
      })
      const value: unknown = await response.json()
      return {
        statusCode: response.status,
        data: decode === undefined ? (value as T) : decode(value),
        headers: Object.fromEntries(response.headers.entries()),
      }
    },
    getStorage<T>(key: string, decode?: (value: unknown) => T): T | undefined {
      const value = storage.get(key)
      if (value === undefined) return undefined
      return decode === undefined ? (value as T) : decode(value)
    },
    setStorage<T>(key: string, value: T, encode?: (value: T) => unknown): void {
      storage.set(key, encode === undefined ? value : encode(value))
    },
    removeStorage(key: string): void {
      storage.delete(key)
    },
  }
  return { runtime, files, storage }
}

function memoryFileRuntime(files: Map<string, Uint8Array>): WechatFileRuntime {
  return {
    openRead(filePath) {
      return files.has(filePath)
        ? Promise.resolve(filePath)
        : Promise.reject(new Error('missing memory file'))
    },
    read(fd, position, length) {
      const bytes = files.get(fd)
      return bytes === undefined
        ? Promise.reject(new Error('missing memory descriptor'))
        : Promise.resolve(bytes.slice(position, position + length))
    },
    close: () => Promise.resolve(),
    writeFile(filePath, data) {
      files.set(filePath, data.slice())
      return Promise.resolve()
    },
    unlink(filePath) {
      files.delete(filePath)
      return Promise.resolve()
    },
    listDirectory(dirPath) {
      const prefix = `${dirPath.replace(/\/$/u, '')}/`
      return Promise.resolve(
        [...files.keys()]
          .filter((path) => path.startsWith(prefix))
          .map((path) => path.slice(prefix.length))
          .filter((path) => !path.includes('/')),
      )
    },
  }
}

function nodeUploadRuntime(files: Map<string, Uint8Array>): WechatUploadRuntime {
  return {
    async uploadFile(request) {
      const bytes = files.get(request.filePath)
      if (bytes === undefined) throw new Error('missing upload chunk')
      const multipart = new FormData()
      multipart.append('chunkSizeBytes', request.formData.chunkSizeBytes)
      multipart.append(
        request.name,
        new Blob([bytes.slice()], { type: 'application/octet-stream' }),
        `part-${request.formData.chunkSizeBytes}`,
      )
      const response = await fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: multipart,
      })
      request.onProgress?.({
        progress: 100,
        totalBytesSent: bytes.byteLength,
        totalBytesExpectedToSend: bytes.byteLength,
      })
      return {
        statusCode: response.status,
        data: await response.text(),
        headers: Object.fromEntries(response.headers.entries()),
      }
    },
  }
}

describe('mini-program upload flow against the listening local API', () => {
  let server: LocalServer | undefined

  beforeAll(async () => {
    server = await startLocalServer()
  }, 20_000)

  afterAll(async () => {
    await server?.stop()
  })

  it('requires second confirmation and uploads through SessionStore, queue, runner, and history', async () => {
    if (server === undefined) throw new Error('Local E2E server did not start')
    const memory = memoryWechatRuntime(server.origin)
    const api = new ApiClient({ runtime: memory.runtime, baseUrl: server.origin })
    const session = new SessionStore({
      runtime: memory.runtime,
      api,
      deviceId: 'mini-e2e-device',
    })
    await session.ensureSession()
    const user = await api.updateNickname(
      {
        nickname: '微信昵称小晴',
        source: 'wechatNicknameInput',
        confirmed: true,
      },
      session,
    )
    await session.replaceUser(user)

    const statuses: string[] = []
    const progress: number[] = []
    let nextIdempotencyKey = 0
    const runner = new UploadRunner({
      api: {
        initializeUpload: (request, key) => api.initializeUpload(request, key, session),
        getUpload: (uploadId) => api.getUpload(uploadId, session),
        completeUpload: (uploadId, key) => api.completeUpload(uploadId, key, session),
        abortUpload: (uploadId, reason, key) => api.abortUpload(uploadId, reason, key, session),
      },
      transport: new AuthorizedUploadTransport({
        runtime: nodeUploadRuntime(memory.files),
        session,
        baseUrl: server.origin,
      }),
      chunks: new ChunkFileService({
        files: memoryFileRuntime(memory.files),
        userDataPath: '/memory/tmp',
        createId: () => 'mini-e2e-part',
      }),
      source: { isReadable: (path) => memory.files.has(path) },
      store: createUploadResumeStore(memory.runtime),
      createIdempotencyKey: () => {
        const key = IDEMPOTENCY_KEYS[nextIdempotencyKey]
        nextIdempotencyKey += 1
        if (key === undefined) throw new Error('missing E2E idempotency key')
        return key
      },
      onStatus: (event) => statuses.push(event.status),
      onProgress: (event) => progress.push(event.percent),
    })
    const completion = new CompletionController({
      runner,
      sleep: () => new Promise((resolve) => setTimeout(resolve, 30)),
    })
    const queue = new UploadQueue<UploadRunnerFile>(completion)
    const file: UploadRunnerFile = {
      sourcePath: SOURCE_PATH,
      fileName: 'mini-e2e-private.png',
      sizeBytes: PNG_BYTES.byteLength,
      kind: 'image',
      mimeType: 'image/png',
    }

    await expect(queue.run([file], { confirmed: false })).resolves.toEqual([])
    await expect(api.getUploadHistory({ limit: 20 }, session)).resolves.toMatchObject({
      items: [],
    })

    await expect(queue.run([file], { confirmed: true })).resolves.toEqual([
      expect.objectContaining({
        fileName: 'mini-e2e-private.png',
        status: 'uploaded',
        failureMessage: null,
      }),
    ])
    expect(statuses).toEqual(
      expect.arrayContaining(['initializing', 'uploading', 'finalizing', 'uploaded']),
    )
    expect(progress).toContain(100)
    expect([...memory.files.keys()]).toEqual([SOURCE_PATH])

    const history = await api.getUploadHistory({ limit: 20 }, session)
    expect(history.items).toHaveLength(1)
    expect(history.items[0]).toMatchObject({
      fileName: 'mini-e2e-private.png',
      status: 'uploaded',
    })
    expect(history.items[0]?.progress.percent).toBe(100)
    expect(memory.storage.has('privateMediaUploadResumeV1')).toBe(false)
  })
})
