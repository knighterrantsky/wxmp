import type {
  NicknameRequest,
  PublicUser,
  UploadDetailResponse,
  UploadHistoryQuery,
} from '@wx-upload/contracts'

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
  type MediaUploadUiStatus,
} from './services/media-upload-service.js'
import { SessionStore } from './services/session-store.js'
import { createUploadResumeRegistry } from './services/upload-resume-registry.js'
import { UploadRestoreCoordinator } from './services/upload-restore-coordinator.js'
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
  readonly restoreCoordinator: UploadRestoreCoordinator
  readonly retainedSessionCount: () => number
  readonly retainedKeys: () => readonly string[]
  readonly hasRetainedKeys: (keys: ReadonlySet<string>) => boolean
}

interface PendingRecoveryUpdates {
  readonly retainedKeys: Set<string>
  readonly listener: (event: MediaUploadUiEvent) => void
}

export interface ApplicationProfileApi {
  updateNickname(request: NicknameRequest): Promise<PublicUser>
}

export interface ApplicationMediaUploadApi {
  chooseMedia(): Promise<readonly MediaSelectionCandidate[]>
  start(
    files: readonly ValidatedMedia[],
    onUpdate: (event: MediaUploadUiEvent) => void,
  ): Promise<void>
}

export interface ApplicationHistoryApi {
  list(query: UploadHistoryQuery): Promise<UploadHistoryPage>
  getUpload(uploadId: string): Promise<UploadDetailResponse['data']>
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
let coldRestorePromise: Promise<void> | undefined
let foregroundPromise: Promise<void> | undefined
let uploadBatchActive = false
let applicationHidden = false
let applicationPauseGeneration = 0
let pendingRecoveryUpdates: PendingRecoveryUpdates | undefined

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

function publicRecoveryStatus(value: string): MediaUploadUiStatus | undefined {
  switch (value) {
    case 'initializing':
    case 'uploading':
      return 'uploading'
    case 'resuming':
      return undefined
    case 'paused':
    case 'finalizing':
    case 'uploaded':
    case 'failed':
      return value
    case 'replace-required':
      return 'failed'
    default:
      return undefined
  }
}

function recoveryListeners(
  retainedKey: string,
  metadata: UploadRunnerResumeMetadata | undefined,
): MediaUploadRunnerListeners | undefined {
  const recovery = pendingRecoveryUpdates
  if (metadata === undefined || !recovery?.retainedKeys.has(retainedKey)) {
    return undefined
  }

  const sourcePath = metadata.file.sourcePath
  const sizeBytes = metadata.file.sizeBytes
  let bytes = Math.min(sizeBytes, Math.max(0, metadata.confirmedBytes))
  let percent = sizeBytes === 0 ? 0 : Math.min(100, Math.max(0, (bytes / sizeBytes) * 100))
  let status: MediaUploadUiStatus = metadata.phase === 'finalizing' ? 'finalizing' : 'uploading'

  const publish = (): void => {
    try {
      recovery.listener(Object.freeze({ sourcePath, status, bytes, percent }))
    } catch {
      // A stale page callback must not interrupt retained-session recovery.
    }
  }

  return {
    onProgress(event) {
      if (Number.isFinite(event.bytes)) {
        bytes = Math.max(bytes, Math.min(sizeBytes, Math.max(0, event.bytes)))
      }
      if (Number.isFinite(event.percent)) {
        percent = Math.max(percent, Math.min(100, Math.max(0, event.percent)))
      }
      publish()
    },
    onStatus(event) {
      const next = publicRecoveryStatus(event.status)
      if (next !== undefined) status = next
      if (status === 'finalizing' || status === 'uploaded') {
        bytes = sizeBytes
        percent = 100
      }
      publish()
    },
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
      ): CompletionController<ValidatedMedia> =>
        new CompletionController<ValidatedMedia>({
          runner: new UploadRunner({
            api: uploadApi,
            transport,
            chunks,
            source,
            store: resumeRegistry.createStore(retainedKey),
            createIdempotencyKey: idempotencyKey,
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
          chooseMedia: () => chooseMediaWithWechatRuntime(capabilities.mediaSource),
        },
        source,
        runnerFactory: (listeners) => controller(listeners),
        unfinishedServerSessionCount: () => resumeRegistry.count(),
      })

      const restoreCoordinator = new UploadRestoreCoordinator({
        retainedKeys: () => resumeRegistry.keys(),
        controllerFor: (retainedKey) => {
          const listeners = recoveryListeners(retainedKey, resumeRegistry.record(retainedKey))
          const retainedController = controller(listeners, retainedKey)
          return {
            async restore() {
              const outcome = await retainedController.restore()
              if (outcome !== 'uploaded') listeners?.onStatus({ status: 'failed' })
              return outcome
            },
            pause: () => retainedController.pause(),
            foreground: () => retainedController.foreground(),
          }
        },
      })

      return {
        mediaUpload,
        restoreCoordinator,
        retainedSessionCount: () => resumeRegistry.count(),
        retainedKeys: () => resumeRegistry.keys(),
        hasRetainedKeys: (keys: ReadonlySet<string>) =>
          resumeRegistry.keys().some((key) => keys.has(key)),
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

function beginColdRestore(): void {
  if (coldRestorePromise !== undefined || uploadBatchActive) return
  const recoveryUpdates = pendingRecoveryUpdates
  let keepRecoveryUpdates = false
  const pending = (async () => {
    const selectedServicesPromise = applicationUploadServices()
    const services = await selectedServicesPromise
    try {
      const retainedBeforeRestore = services.retainedSessionCount()
      if (applicationHidden) await services.restoreCoordinator.pause()
      const restored = await services.restoreCoordinator.restoreAll()
      if (
        retainedBeforeRestore > 0 &&
        restored === retainedBeforeRestore &&
        services.retainedSessionCount() === 0 &&
        uploadServicesPromise === selectedServicesPromise
      ) {
        uploadServicesPromise = undefined
      }
    } finally {
      keepRecoveryUpdates =
        recoveryUpdates !== undefined && services.hasRetainedKeys(recoveryUpdates.retainedKeys)
    }
  })()
  coldRestorePromise = pending
  void pending
    .finally(() => {
      if (coldRestorePromise === pending) coldRestorePromise = undefined
      if (!keepRecoveryUpdates && pendingRecoveryUpdates === recoveryUpdates) {
        pendingRecoveryUpdates = undefined
      }
    })
    .catch(() => undefined)
}

function pauseUploads(): Promise<void> {
  return applicationUploadServices().then(async (services) => {
    if (uploadBatchActive) {
      await services.mediaUpload.pause()
    } else if (coldRestorePromise !== undefined) {
      await services.restoreCoordinator.pause()
    }
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
    if (coldRestorePromise !== undefined) {
      await services.restoreCoordinator.foreground()
      return
    }
    beginColdRestore()
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
    async chooseMedia() {
      const { mediaUpload } = await applicationUploadServices()
      return mediaUpload.chooseMedia()
    },

    async start(files, onUpdate) {
      const retainedRecoveryPending = (pendingRecoveryUpdates?.retainedKeys.size ?? 0) > 0
      if (uploadBatchActive || coldRestorePromise !== undefined || retainedRecoveryPending) {
        if (!uploadBatchActive && coldRestorePromise === undefined && retainedRecoveryPending) {
          beginColdRestore()
        }
        throw new ApplicationUploadBusyError()
      }
      const recoveryUpdates: PendingRecoveryUpdates = {
        retainedKeys: new Set(),
        listener: onUpdate,
      }
      pendingRecoveryUpdates = recoveryUpdates
      uploadBatchActive = true
      let services: ApplicationUploadServices | undefined
      let retainedBefore = new Set<string>()
      try {
        services = await applicationUploadServices()
        retainedBefore = new Set(services.retainedKeys())
        await services.mediaUpload.start(files, onUpdate)
      } finally {
        if (services !== undefined && pendingRecoveryUpdates === recoveryUpdates) {
          for (const retainedKey of services.retainedKeys()) {
            if (!retainedBefore.has(retainedKey)) recoveryUpdates.retainedKeys.add(retainedKey)
          }
        }
        uploadBatchActive = false
        beginColdRestore()
      }
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
