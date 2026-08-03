import type {
  NicknameRequest,
  PublicUser,
  UploadDetailResponse,
  UploadHistoryQuery,
} from './generated/contracts.js'

import { createUuidV7 } from './core/uuid-v7.js'
import type { MediaSelectionCandidate, ValidatedMedia } from './core/media-validation.js'
import { API_BASE_URL } from './config.generated.js'
import { createWechatFileRuntime, type WxFileSystemManagerSource } from './runtime/wx-files.js'
import {
  chooseMediaWithWechatRuntime,
  type WxChooseMediaOptions,
  type WxChooseMediaSource,
} from './runtime/wx-media.js'
import { createWechatRuntime, type WechatRuntime } from './runtime/wechat-runtime.js'
import { AuthorizedUploadTransport } from './runtime/wx-upload.js'
import { ApiClient, type UploadHistoryPage } from './services/api-client.js'
import { ChunkFileService } from './services/chunk-files.js'
import { CompletionController } from './services/completion-controller.js'
import {
  MediaUploadService,
  type MediaUploadRunnerListeners,
  type MediaUploadUiEvent,
} from './services/media-upload-service.js'
import { SessionStore } from './services/session-store.js'
import { createUploadResumeRegistry } from './services/upload-resume-registry.js'
import { UploadRunner, type UploadRunnerResumeMetadata } from './services/upload-runner.js'

const INSTALLATION_ID_STORAGE_KEY = 'installationId'
const INSTALLATION_ID_PATTERN = /^installation-[0-9a-f]{32}$/u
const RANDOM_BYTE_COUNT = 16

interface ApplicationServices {
  readonly runtime: WechatRuntime
  readonly api: ApiClient
  readonly session: SessionStore
}

interface ApplicationUploadServices {
  readonly mediaUpload: MediaUploadService
  readonly retainedKeys: () => readonly string[]
  readonly retainedRecord: (key: string) => UploadRunnerResumeMetadata | undefined
  readonly removeRetained: (key: string) => void
}

export interface ApplicationProfileApi {
  updateNickname(request: NicknameRequest): Promise<PublicUser>
}

export interface ApplicationMediaUploadApi {
  chooseMedia(maxCount?: number): Promise<readonly MediaSelectionCandidate[]>
  dispatch(files: readonly ValidatedMedia[]): Promise<void>
  start(
    files: readonly ValidatedMedia[],
    onUpdate: (event: MediaUploadUiEvent) => void,
  ): Promise<void>
}

export interface ApplicationHistoryApi {
  list(query: UploadHistoryQuery): Promise<UploadHistoryPage>
  getUpload(uploadId: string): Promise<UploadDetailResponse['data']>
  cancel(uploadId: string): Promise<void>
  clearUploaded(): Promise<number>
  retry(uploadId: string, fileName: string, sizeBytes: number): Promise<boolean>
  deleteRecord(uploadId: string, fileName: string, sizeBytes: number): Promise<void>
}

export interface ApplicationGlobalData {
  readonly profileApi: ApplicationProfileApi
  readonly mediaUpload: ApplicationMediaUploadApi
  readonly historyApi: ApplicationHistoryApi
  publicUser?: PublicUser
  ensureSession: () => Promise<PublicUser>
}

export class ApplicationUploadUnavailableError extends Error {
  override readonly name = 'ApplicationUploadUnavailableError'

  constructor() {
    super('素材上传能力暂不可用')
  }
}

export class ApplicationUploadBusyError extends Error {
  override readonly name = 'ApplicationUploadBusyError'

  constructor() {
    super('已有素材正在恢复或上传')
  }
}

interface WechatUploadCapabilities {
  readonly mediaSource: WxChooseMediaSource
  readonly fileSource: WxFileSystemManagerSource
  readonly userDataPath: string
}

let servicesPromise: Promise<ApplicationServices> | undefined
let uploadServicesPromise: Promise<ApplicationUploadServices> | undefined
let foregroundPromise: Promise<void> | undefined
let uploadBatchActive = false
let applicationHidden = false
let applicationPauseGeneration = 0

interface UploadBatchHandle {
  readonly completion: Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hexadecimal(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

async function secureRandomBytes(): Promise<Uint8Array> {
  const result: unknown = await wx.getRandomValues({ length: RANDOM_BYTE_COUNT })
  if (
    !isRecord(result) ||
    !(result['randomValues'] instanceof ArrayBuffer) ||
    result['randomValues'].byteLength !== RANDOM_BYTE_COUNT
  ) {
    throw new ApplicationUploadUnavailableError()
  }
  return new Uint8Array(result['randomValues']).slice()
}

async function installationId(runtime: WechatRuntime): Promise<string> {
  const persisted = runtime.getStorage<unknown>(INSTALLATION_ID_STORAGE_KEY)
  if (typeof persisted === 'string' && INSTALLATION_ID_PATTERN.test(persisted)) {
    return persisted
  }
  if (persisted !== undefined) runtime.removeStorage(INSTALLATION_ID_STORAGE_KEY)

  const generated = `installation-${hexadecimal(await secureRandomBytes())}`
  runtime.setStorage(INSTALLATION_ID_STORAGE_KEY, generated)
  return generated
}

async function idempotencyKey(): Promise<string> {
  return createUuidV7(Date.now(), await secureRandomBytes())
}

function applicationServices(): Promise<ApplicationServices> {
  if (servicesPromise === undefined) {
    const pending = (async () => {
      const runtime = createWechatRuntime()
      const api = new ApiClient({ runtime, baseUrl: API_BASE_URL })
      const deviceId = await installationId(runtime)
      return {
        runtime,
        api,
        session: new SessionStore({ runtime, api, deviceId }),
      }
    })()
    servicesPromise = pending
    void pending
      .catch(() => {
        if (servicesPromise === pending) servicesPromise = undefined
      })
      .catch(() => undefined)
  }
  return servicesPromise
}

function uploadCapabilities(): WechatUploadCapabilities {
  const source: unknown = wx
  if (!isRecord(source)) throw new ApplicationUploadUnavailableError()
  const chooseMedia = source['chooseMedia']
  const getFileSystemManager = source['getFileSystemManager']
  const environment = source['env']
  if (
    typeof chooseMedia !== 'function' ||
    typeof getFileSystemManager !== 'function' ||
    !isRecord(environment) ||
    typeof environment['USER_DATA_PATH'] !== 'string' ||
    environment['USER_DATA_PATH'].length < 1
  ) {
    throw new ApplicationUploadUnavailableError()
  }

  const fileSource: unknown = Reflect.apply(getFileSystemManager, source, [])
  if (
    !isRecord(fileSource) ||
    !['open', 'read', 'close', 'writeFile', 'unlink', 'readdir'].every(
      (operation) => typeof fileSource[operation] === 'function',
    )
  ) {
    throw new ApplicationUploadUnavailableError()
  }

  return {
    mediaSource: {
      chooseMedia(options: WxChooseMediaOptions): unknown {
        return Reflect.apply(chooseMedia, source, [options])
      },
    },
    fileSource: fileSource as unknown as WxFileSystemManagerSource,
    userDataPath: environment['USER_DATA_PATH'],
  }
}

async function sourceIsReadable(
  files: ReturnType<typeof createWechatFileRuntime>,
  sourcePath: string,
): Promise<boolean> {
  let descriptor: string | undefined
  try {
    descriptor = await files.openRead(sourcePath)
    await files.close(descriptor)
    return true
  } catch {
    if (descriptor !== undefined) {
      try {
        await files.close(descriptor)
      } catch {
        // The source remains unreadable when its handle cannot be closed safely.
      }
    }
    return false
  }
}

function applicationUploadServices(): Promise<ApplicationUploadServices> {
  if (uploadServicesPromise === undefined) {
    const pending = (async () => {
      const { runtime, api, session } = await applicationServices()
      const capabilities = uploadCapabilities()
      const uploadFile = runtime.uploadFile
      if (uploadFile === undefined) throw new ApplicationUploadUnavailableError()

      const files = createWechatFileRuntime(capabilities.fileSource)
      const chunks = new ChunkFileService({
        files,
        userDataPath: capabilities.userDataPath,
      })
      await chunks.cleanupOrphans()

      const source = {
        isReadable: (sourcePath: string) => sourceIsReadable(files, sourcePath),
      }
      const transport = new AuthorizedUploadTransport({
        runtime: { uploadFile: (request) => uploadFile(request) },
        session,
        baseUrl: API_BASE_URL,
      })
      const resumeRegistry = createUploadResumeRegistry({
        getStorage: (key) => runtime.getStorage<unknown>(key),
        setStorage: (key, value) => {
          runtime.setStorage(key, value)
        },
        removeStorage: (key) => {
          runtime.removeStorage(key)
        },
      })
      const uploadApi = {
        initializeUpload: (request: Parameters<ApiClient['initializeUpload']>[0], key: string) =>
          api.initializeUpload(request, key, session),
        getUpload: (uploadId: string) => api.getUpload(uploadId, session),
        completeUpload: (uploadId: string, key: string) =>
          api.completeUpload(uploadId, key, session),
        abortUpload: (uploadId: string, reason: 'replaced', key: string) =>
          api.abortUpload(uploadId, reason, key, session),
      }

      const controller = (
        listeners?: MediaUploadRunnerListeners,
        retainedKey?: string,
        maxParallelParts?: 1 | 2,
      ): CompletionController<ValidatedMedia> =>
        new CompletionController<ValidatedMedia>({
          runner: new UploadRunner({
            api: uploadApi,
            transport,
            chunks,
            source,
            store: resumeRegistry.createStore(retainedKey),
            createIdempotencyKey: idempotencyKey,
            ...(maxParallelParts === undefined ? {} : { maxParallelParts }),
            ...(listeners === undefined
              ? {}
              : {
                  onProgress: listeners.onProgress,
                  onStatus: listeners.onStatus,
                }),
          }),
        })

      const mediaUpload = new MediaUploadService({
        picker: {
          chooseMedia: (maxCount) =>
            chooseMediaWithWechatRuntime(capabilities.mediaSource, maxCount),
        },
        source,
        runnerFactory: (listeners, options) =>
          controller(listeners, undefined, options?.maxParallelParts),
      })

      return {
        mediaUpload,
        retainedKeys: () => resumeRegistry.keys(),
        retainedRecord: (key: string) => resumeRegistry.record(key),
        removeRetained: (key: string) => {
          resumeRegistry.remove(key)
        },
      }
    })()
    uploadServicesPromise = pending
    void pending
      .catch(() => {
        if (uploadServicesPromise === pending) uploadServicesPromise = undefined
      })
      .catch(() => undefined)
  }
  return uploadServicesPromise
}

function pauseUploads(): Promise<void> {
  return applicationUploadServices().then(async (services) => {
    if (uploadBatchActive) await services.mediaUpload.pause()
  })
}

function foregroundUploads(): Promise<void> {
  if (foregroundPromise !== undefined) return foregroundPromise
  const pauseGenerationAtStart = applicationPauseGeneration
  const pending = applicationUploadServices().then(async (services) => {
    if (uploadBatchActive) {
      await services.mediaUpload.foreground()
      return
    }
    return
  })
  foregroundPromise = pending
  void pending
    .finally(() => {
      if (foregroundPromise === pending) foregroundPromise = undefined
      if (!applicationHidden && applicationPauseGeneration !== pauseGenerationAtStart) {
        void foregroundUploads().catch(() => undefined)
      }
    })
    .catch(() => undefined)
  return pending
}

async function dispatchUploadBatch(
  files: readonly ValidatedMedia[],
  onUpdate: (event: MediaUploadUiEvent) => void,
): Promise<UploadBatchHandle> {
  if (uploadBatchActive) throw new ApplicationUploadBusyError()
  uploadBatchActive = true
  let services: ApplicationUploadServices
  let mediaBatch: Awaited<ReturnType<ApplicationUploadServices['mediaUpload']['begin']>>
  try {
    services = await applicationUploadServices()
    mediaBatch = await services.mediaUpload.begin(files, onUpdate)
  } catch (error) {
    uploadBatchActive = false
    throw error
  }

  const completion = mediaBatch.completion.finally(() => {
    uploadBatchActive = false
  })
  return Object.freeze({ completion })
}

function retainedUploadFor(
  services: ApplicationUploadServices,
  uploadId: string,
  fileName: string,
  sizeBytes: number,
): { key: string; metadata: UploadRunnerResumeMetadata } | undefined {
  const records = services.retainedKeys().map((key) => ({
    key,
    metadata: services.retainedRecord(key),
  }))
  const exact = records.find((entry) => entry.metadata?.uploadId === uploadId)
  const fallback = [...records]
    .reverse()
    .find(
      (entry) =>
        entry.metadata?.file.fileName === fileName && entry.metadata.file.sizeBytes === sizeBytes,
    )
  const selected = exact ?? fallback
  return selected?.metadata === undefined
    ? undefined
    : { key: selected.key, metadata: selected.metadata }
}

const globalData: ApplicationGlobalData = {
  profileApi: {
    async updateNickname(request) {
      const { api, session } = await applicationServices()
      const user = await api.updateNickname(request, session)
      await session.replaceUser(user)
      globalData.publicUser = user
      return user
    },
  },

  mediaUpload: {
    async chooseMedia(maxCount) {
      const { mediaUpload } = await applicationUploadServices()
      return mediaUpload.chooseMedia(maxCount)
    },

    async dispatch(files) {
      const handle = await dispatchUploadBatch(files, () => undefined)
      void handle.completion.catch(() => undefined)
    },

    async start(files, onUpdate) {
      const handle = await dispatchUploadBatch(files, onUpdate)
      await handle.completion
    },
  },

  historyApi: {
    async list(query) {
      const { api, session } = await applicationServices()
      return api.getUploadHistory(query, session)
    },

    async getUpload(uploadId) {
      const { api, session } = await applicationServices()
      return api.getUpload(uploadId, session)
    },

    async cancel(uploadId) {
      const { api, session } = await applicationServices()
      await api.abortUpload(uploadId, 'userCancelled', await idempotencyKey(), session)
    },

    async clearUploaded() {
      const { api, session } = await applicationServices()
      const result = await api.clearUploadedHistory(session)
      return result.clearedCount
    },

    async retry(uploadId, fileName, sizeBytes) {
      const services = await applicationUploadServices()
      const retained = retainedUploadFor(services, uploadId, fileName, sizeBytes)
      if (retained === undefined) return false
      const file: ValidatedMedia = {
        ...retained.metadata.file,
        previewPath: retained.metadata.file.sourcePath,
      }
      try {
        const handle = await dispatchUploadBatch([file], () => undefined)
        services.removeRetained(retained.key)
        void handle.completion.catch(() => undefined)
        return true
      } catch {
        return false
      }
    },

    async deleteRecord(uploadId, fileName, sizeBytes) {
      const { api, session } = await applicationServices()
      await api.deleteUploadHistory(uploadId, session)
      const services = await applicationUploadServices()
      const retained = retainedUploadFor(services, uploadId, fileName, sizeBytes)
      if (retained !== undefined) services.removeRetained(retained.key)
    },
  },

  async ensureSession() {
    const { session } = await applicationServices()
    const current = await session.ensureSession()
    globalData.publicUser = current.user
    return current.user
  },
}

App({
  globalData,

  onLaunch() {
    void this.globalData.ensureSession().catch(() => undefined)
    void applicationUploadServices().catch(() => undefined)
  },

  onHide() {
    applicationHidden = true
    applicationPauseGeneration += 1
    void pauseUploads().catch(() => undefined)
  },

  onShow() {
    applicationHidden = false
    void foregroundUploads().catch(() => undefined)
  },
})
