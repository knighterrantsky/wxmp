import type { NicknameRequest, PublicUser } from '@wx-upload/contracts'

import {
  MediaValidationError,
  validateMediaSelection,
  type MediaSelectionCandidate,
  type ValidatedMedia,
} from '../../core/media-validation.js'
import { WechatMediaSelectionError } from '../../runtime/wx-media.js'

export interface NicknameProfileApi {
  updateNickname(request: NicknameRequest): Promise<PublicUser>
}

export interface NicknameSubmitEvent {
  readonly detail: {
    readonly value: { readonly nickname?: unknown }
  }
}

export interface NicknameReviewEvent {
  readonly detail: {
    readonly pass: boolean
    readonly timeout: boolean
  }
}

export interface NicknamePrivacyAuthorizationRuntime {
  requirePrivacyAuthorize(options: {
    readonly success: () => void
    readonly fail: () => void
  }): void
}

export interface NicknameFlowSnapshot {
  readonly nickname: string | null
  readonly nicknameDraft: string
  readonly nicknameConfirmed: boolean
  readonly nicknameSaving: boolean
  readonly nicknameError: string | null
  readonly nicknamePrivacyAuthorized: boolean
  readonly nicknamePrivacyRequesting: boolean
  readonly nicknamePrivacyPromptVisible: boolean
  readonly nicknameReviewPending: boolean
  readonly canChooseMedia: true
  readonly canCreateUpload: boolean
}

export type UploadUiStatus =
  'ready' | 'queued' | 'uploading' | 'paused' | 'finalizing' | 'uploaded' | 'failed'

export interface UploadUiEvent {
  readonly sourcePath: string
  readonly status: Exclude<UploadUiStatus, 'ready'>
  readonly bytes: number
  readonly percent: number
}

export interface SelectedFileView {
  readonly id: string
  readonly fileName: string
  readonly kindLabel: '图片' | '视频'
  readonly sizeLabel: string
  readonly sizeBytes: number
  readonly status: UploadUiStatus
  readonly statusLabel: string
  readonly bytes: number
  readonly percent: number
}

export interface UploadPageData extends NicknameFlowSnapshot {
  readonly selectedFiles: readonly SelectedFileView[]
  readonly selectedTotalBytes: number
  readonly selectedTotalLabel: string
  readonly selectionError: string | null
  readonly uploadBatchRunning: boolean
}

export interface MediaUploadPageService {
  chooseMedia(): Promise<readonly MediaSelectionCandidate[]>
  start(files: readonly ValidatedMedia[], onUpdate: (event: UploadUiEvent) => void): Promise<void>
}

function normalizedNickname(value: string): string {
  return value.normalize('NFC').trim()
}

export class NicknameFlowController {
  readonly #api: NicknameProfileApi
  #nickname: string | null
  #nicknameDraft: string
  #nicknameConfirmed: boolean
  #nicknameSaving = false
  #nicknameError: string | null = null
  #nicknamePrivacyAuthorized = false
  #nicknamePrivacyRequesting = false
  #nicknamePrivacyPromptVisible = false
  #nicknamePrivacyRequestSequence = 0
  #nicknameReviewState: 'idle' | 'passed' | 'failed' | 'timeout' | 'consumed' = 'idle'
  #nicknameEditSequence = 0
  #nicknameReviewSequence: number | undefined
  #nicknameReviewPendingCount = 0
  #nicknameReviewAmbiguous = false
  #submittedNickname: string | null = null
  #submittedNicknameSequence: number | undefined

  constructor(api: NicknameProfileApi, user?: PublicUser) {
    this.#api = api
    this.#nickname = user?.nickname ?? null
    this.#nicknameDraft = user?.nickname ?? ''
    this.#nicknameConfirmed = user?.nicknameConfirmed === true && user.nickname !== null
  }

  snapshot(): NicknameFlowSnapshot {
    return {
      nickname: this.#nickname,
      nicknameDraft: this.#nicknameDraft,
      nicknameConfirmed: this.#nicknameConfirmed,
      nicknameSaving: this.#nicknameSaving,
      nicknameError: this.#nicknameError,
      nicknamePrivacyAuthorized: this.#nicknamePrivacyAuthorized,
      nicknamePrivacyRequesting: this.#nicknamePrivacyRequesting,
      nicknamePrivacyPromptVisible: this.#nicknamePrivacyPromptVisible,
      nicknameReviewPending:
        this.#submittedNickname !== null &&
        (this.#nicknameReviewState === 'idle' || this.#nicknameReviewPendingCount > 0),
      canChooseMedia: true,
      canCreateUpload: this.#nicknameConfirmed,
    }
  }

  requestPrivacyAuthorization(onChange: () => void = () => undefined): void {
    if (
      this.#nicknamePrivacyAuthorized ||
      this.#nicknamePrivacyRequesting ||
      this.#nicknamePrivacyPromptVisible
    ) {
      return
    }

    this.#nicknamePrivacyRequestSequence += 1
    this.#nicknamePrivacyPromptVisible = true
    this.#nicknameError = null
    onChange()
  }

  agreePrivacyAuthorization(
    runtime: NicknamePrivacyAuthorizationRuntime,
    onChange: () => void = () => undefined,
  ): void {
    if (this.#nicknamePrivacyAuthorized || this.#nicknamePrivacyRequesting) return
    if (!this.#nicknamePrivacyPromptVisible) {
      this.#nicknameError = '昵称授权状态已失效，请重新申请授权'
      onChange()
      return
    }

    const requestSequence = this.#nicknamePrivacyRequestSequence
    this.#nicknamePrivacyRequesting = true
    this.#nicknamePrivacyPromptVisible = false
    this.#nicknameError = null
    onChange()
    try {
      runtime.requirePrivacyAuthorize({
        success: () => {
          this.#finishPrivacyRequest(requestSequence, true, null, onChange)
        },
        fail: () => {
          this.#finishPrivacyRequest(
            requestSequence,
            false,
            '微信昵称授权未完成，请确认隐私保护指引后重试',
            onChange,
          )
        },
      })
    } catch {
      this.#finishPrivacyRequest(
        requestSequence,
        false,
        '当前微信版本无法完成昵称授权，请升级微信后重试',
        onChange,
      )
    }
  }

  rejectPrivacyAuthorization(): void {
    this.#nicknamePrivacyRequestSequence += 1
    this.#nicknamePrivacyAuthorized = false
    this.#nicknamePrivacyRequesting = false
    this.#nicknamePrivacyPromptVisible = false
    this.#nicknameError = '你已暂不授权昵称使用，可稍后重试；开始上传前仍需确认昵称'
  }

  privacyAuthorizationUnavailable(): void {
    this.#nicknamePrivacyRequestSequence += 1
    this.#nicknamePrivacyAuthorized = false
    this.#nicknamePrivacyRequesting = false
    this.#nicknamePrivacyPromptVisible = false
    this.#nicknameError = '当前微信版本无法完成昵称授权，请升级微信后重试'
  }

  onNicknameInput(): void {
    if (this.#nicknameSaving) return
    if (this.#nicknameReviewPendingCount > 0) {
      this.#nicknameReviewAmbiguous = true
    } else {
      this.#nicknameReviewAmbiguous = false
      this.#nicknameReviewSequence = undefined
    }
    this.#nicknameEditSequence += 1
    this.#nicknameReviewState = 'idle'
    this.#submittedNickname = null
    this.#submittedNicknameSequence = undefined
    this.#nicknameError = null
  }

  onNicknameReviewStart(): void {
    if (this.#nicknameSaving) return
    if (this.#nicknameReviewPendingCount === 0 && !this.#nicknameReviewAmbiguous) {
      this.#nicknameReviewSequence = this.#nicknameEditSequence
      this.#nicknameReviewState = 'idle'
    } else {
      this.#nicknameReviewAmbiguous = true
    }
    this.#nicknameReviewPendingCount += 1
  }

  async onNicknameSubmit(event: NicknameSubmitEvent): Promise<boolean> {
    if (this.#nicknameSaving) return false
    if (!this.#nicknamePrivacyAuthorized) {
      this.#nicknameError = '请先完成微信昵称隐私授权'
      return false
    }
    if (this.#nicknameReviewState === 'failed' || this.#nicknameReviewState === 'timeout') {
      this.#submittedNickname = null
      this.#submittedNicknameSequence = undefined
      this.#nicknameDraft = this.#safeNicknameDraft()
      return false
    }
    if (this.#nicknameReviewState === 'consumed') {
      this.#nicknameError = '请重新选择昵称并等待微信审核'
      return false
    }

    const submittedValue = event.detail.value.nickname
    const nickname = typeof submittedValue === 'string' ? normalizedNickname(submittedValue) : ''
    if (nickname === '') {
      this.#submittedNickname = null
      this.#submittedNicknameSequence = undefined
      this.#nicknameDraft = this.#safeNicknameDraft()
      this.#nicknameError = '请先在微信昵称选择框中选择昵称'
      return false
    }

    this.#nicknameDraft = nickname
    this.#submittedNickname = nickname
    this.#submittedNicknameSequence = this.#nicknameEditSequence
    if (this.#nicknameReviewAmbiguous) {
      this.#nicknameError = '昵称在审核期间发生变化，请重新选择并确认'
      return false
    }
    if (
      this.#nicknameReviewState !== 'passed' ||
      this.#nicknameReviewSequence !== this.#submittedNicknameSequence
    ) {
      this.#nicknameError = '微信正在审核昵称，审核通过后将自动确认'
      return false
    }
    return this.#saveReviewedNickname()
  }

  async onNicknameReview(event: NicknameReviewEvent): Promise<boolean> {
    if (this.#nicknameSaving || this.#nicknameReviewState === 'consumed') return false
    if (this.#nicknameReviewPendingCount === 0) {
      this.#failAmbiguousReview()
      return false
    }
    this.#nicknameReviewPendingCount -= 1
    if (
      this.#nicknameReviewAmbiguous ||
      this.#nicknameReviewSequence === undefined ||
      this.#nicknameReviewSequence !== this.#nicknameEditSequence
    ) {
      if (this.#nicknameReviewPendingCount === 0) this.#failAmbiguousReview()
      return false
    }
    if (!this.#nicknamePrivacyAuthorized) {
      this.#nicknameReviewState = 'failed'
      this.#submittedNickname = null
      this.#submittedNicknameSequence = undefined
      this.#nicknameDraft = this.#safeNicknameDraft()
      this.#nicknameError = '请先完成微信昵称隐私授权'
      return false
    }
    if (event.detail.timeout) {
      this.#nicknameReviewState = 'timeout'
      this.#submittedNickname = null
      this.#submittedNicknameSequence = undefined
      this.#nicknameDraft = this.#safeNicknameDraft()
      this.#nicknameError = '微信昵称审核超时，请重新选择昵称后重试'
      return false
    }
    if (!event.detail.pass) {
      this.#nicknameReviewState = 'failed'
      this.#submittedNickname = null
      this.#submittedNicknameSequence = undefined
      this.#nicknameDraft = this.#safeNicknameDraft()
      this.#nicknameError = '该昵称未通过微信安全审核，请重新选择昵称'
      return false
    }

    this.#nicknameReviewState = 'passed'
    this.#nicknameError = null
    return this.#saveReviewedNickname()
  }

  async #saveReviewedNickname(): Promise<boolean> {
    const nickname = this.#submittedNickname
    if (
      this.#nicknameReviewState !== 'passed' ||
      nickname === null ||
      this.#submittedNicknameSequence === undefined ||
      this.#submittedNicknameSequence !== this.#nicknameReviewSequence ||
      this.#nicknameSaving
    ) {
      return false
    }

    const wasConfirmed = this.#nicknameConfirmed
    this.#nicknameReviewState = 'consumed'
    this.#submittedNickname = null
    this.#submittedNicknameSequence = undefined
    this.#nicknameReviewSequence = undefined
    this.#nicknameSaving = true
    this.#nicknameError = null
    try {
      const user = await this.#api.updateNickname({
        nickname,
        source: 'wechatNicknameInput',
        confirmed: true,
      })
      if (!user.nicknameConfirmed || user.nickname === null) {
        throw new Error('nickname confirmation response is invalid')
      }
      this.#nickname = user.nickname
      this.#nicknameDraft = user.nickname
      this.#nicknameConfirmed = true
      return true
    } catch {
      this.#nicknameConfirmed = wasConfirmed
      this.#nicknameDraft = nickname
      this.#nicknameError = '昵称确认失败，请稍后重试'
      return false
    } finally {
      this.#nicknameSaving = false
    }
  }

  #safeNicknameDraft(): string {
    return this.#nicknameConfirmed ? (this.#nickname ?? '') : ''
  }

  #failAmbiguousReview(): void {
    this.#nicknameReviewState = 'failed'
    this.#submittedNickname = null
    this.#submittedNicknameSequence = undefined
    this.#nicknameReviewSequence = undefined
    this.#nicknameDraft = this.#safeNicknameDraft()
    this.#nicknameError = '昵称在审核期间发生变化，请重新选择并确认'
  }

  #finishPrivacyRequest(
    requestSequence: number,
    authorized: boolean,
    error: string | null,
    onChange: () => void,
  ): void {
    if (requestSequence !== this.#nicknamePrivacyRequestSequence) return
    this.#nicknamePrivacyAuthorized = authorized
    this.#nicknamePrivacyRequesting = false
    this.#nicknamePrivacyPromptVisible = false
    this.#nicknameError = error
    onChange()
  }
}

interface UploadApplicationGlobalData {
  profileApi?: NicknameProfileApi
  publicUser?: PublicUser
  ensureSession?: () => Promise<PublicUser>
  mediaUpload?: MediaUploadPageService
  chooseMedia?: () => Promise<void>
}

interface UploadPageHost {
  data: UploadPageData
  setData(data: Partial<UploadPageData>): void
  nicknameFlow?: NicknameFlowController
  nicknameInteracted?: boolean
  selectedMedia?: readonly ValidatedMedia[]
}

const EMPTY_UPLOAD_PAGE_DATA = {
  selectedFiles: [],
  selectedTotalBytes: 0,
  selectedTotalLabel: '0 B',
  selectionError: null,
  uploadBatchRunning: false,
} as const satisfies Omit<UploadPageData, keyof NicknameFlowSnapshot>

const UPLOAD_STATUS_LABELS: Readonly<Record<UploadUiStatus, string>> = {
  ready: '等待确认',
  queued: '排队中',
  uploading: '上传中',
  paused: '已暂停',
  finalizing: '正在写入私有存储',
  uploaded: '已上传',
  failed: '上传失败',
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB'] as const
  let value = bytes / 1_024
  let unitIndex = 0
  while (value >= 1_024 && unitIndex < units.length - 1) {
    value /= 1_024
    unitIndex += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  const unit = units[unitIndex]
  if (unit === undefined) return `${String(bytes)} B`
  return `${value.toFixed(digits).replace(/\.0+$/u, '')} ${unit}`
}

function selectionErrorMessage(error: unknown): string | null {
  if (error instanceof WechatMediaSelectionError && error.code === 'CANCELLED') return null
  if (error instanceof MediaValidationError) {
    switch (error.code) {
      case 'FILE_TOO_SMALL':
        return '单个文件至少需要 12 B'
      case 'FILE_TOO_LARGE':
        return '单个文件不能超过 200 MB'
      case 'SELECTION_LIMIT_EXCEEDED':
        return '一次最多选择 9 个文件'
      case 'DUPLICATE_SOURCE_PATH':
        return '请勿重复选择同一素材'
      case 'UNSUPPORTED_MEDIA_TYPE':
      case 'MIME_EXTENSION_MISMATCH':
      case 'KIND_MISMATCH':
        return '仅支持指定格式的图片和视频'
      case 'FILE_UNREADABLE':
        return '所选文件已失效，请重新选择'
      case 'SELECTION_EMPTY':
      case 'INVALID_FILE_SIZE':
        return '所选素材无效，请重新选择'
    }
  }
  return '素材选择失败，请重试'
}

function selectedFileViews(files: readonly ValidatedMedia[]): SelectedFileView[] {
  return files.map((file, index) => ({
    id: `selected-${String(index + 1)}`,
    fileName: file.fileName,
    kindLabel: file.kind === 'image' ? '图片' : '视频',
    sizeLabel: formatBytes(file.sizeBytes),
    sizeBytes: file.sizeBytes,
    status: 'ready',
    statusLabel: UPLOAD_STATUS_LABELS.ready,
    bytes: 0,
    percent: 0,
  }))
}

function queuedFileViews(files: readonly SelectedFileView[]): SelectedFileView[] {
  return files.map((file) => ({
    ...file,
    status: 'queued',
    statusLabel: UPLOAD_STATUS_LABELS.queued,
    bytes: 0,
    percent: 0,
  }))
}

function applyUploadEvent(page: UploadPageHost, event: UploadUiEvent): void {
  const selectedMedia = page.selectedMedia ?? []
  const index = selectedMedia.findIndex((file) => file.sourcePath === event.sourcePath)
  if (index < 0) return
  const current = page.data.selectedFiles[index]
  const media = selectedMedia[index]
  if (current === undefined || media === undefined) return

  const bytes = Number.isFinite(event.bytes)
    ? Math.max(current.bytes, Math.min(media.sizeBytes, Math.max(0, event.bytes)))
    : current.bytes
  const percent = Number.isFinite(event.percent)
    ? Math.max(current.percent, Math.min(100, Math.max(0, event.percent)))
    : current.percent
  const updated = page.data.selectedFiles.map((file, itemIndex) =>
    itemIndex === index
      ? {
          ...file,
          status: event.status,
          statusLabel: UPLOAD_STATUS_LABELS[event.status],
          bytes,
          percent,
        }
      : file,
  )
  page.setData({ selectedFiles: updated })
}

async function confirmAndStartUpload(page: UploadPageHost): Promise<void> {
  const selected = page.selectedMedia ?? []
  const service = applicationData().mediaUpload
  if (selected.length === 0 || service === undefined || page.data.uploadBatchRunning) return

  if (!controller(page).snapshot().canCreateUpload) {
    if (typeof wx === 'object') {
      void wx.showToast({ title: '请先确认昵称', icon: 'none' })
    }
    return
  }
  if (typeof wx !== 'object' || typeof wx.showModal !== 'function') {
    page.setData({ selectionError: '当前微信版本无法确认上传，请升级后重试' })
    return
  }

  const totalBytes = selected.reduce((sum, file) => sum + file.sizeBytes, 0)
  let confirmation: { confirm?: boolean }
  try {
    confirmation = await wx.showModal({
      title: '确认上传素材',
      content: `共 ${String(selected.length)} 个文件，总计 ${formatBytes(totalBytes)}。确认后将上传到私有存储。`,
      confirmText: '开始上传',
      cancelText: '取消',
    })
  } catch {
    page.setData({ selectionError: '上传确认未完成，请重试' })
    return
  }
  if (confirmation.confirm !== true) return

  page.setData({
    selectedFiles: queuedFileViews(page.data.selectedFiles),
    selectionError: null,
    uploadBatchRunning: true,
  })
  try {
    await service.start([...selected], (event) => {
      applyUploadEvent(page, event)
    })
  } catch {
    const failed = page.data.selectedFiles.map((file) =>
      file.status === 'uploaded' || file.status === 'finalizing'
        ? file
        : {
            ...file,
            status: 'failed' as const,
            statusLabel: UPLOAD_STATUS_LABELS.failed,
          },
    )
    page.setData({
      selectedFiles: failed,
      selectionError: '部分素材上传失败，可稍后重试',
    })
  } finally {
    page.setData({ uploadBatchRunning: false })
  }
}

function unavailableProfileApi(): NicknameProfileApi {
  return {
    updateNickname: () => Promise.reject(new Error('profile service unavailable')),
  }
}

function applicationData(): UploadApplicationGlobalData {
  if (typeof getApp !== 'function') return {}
  const application = getApp<{ globalData: UploadApplicationGlobalData }>()
  return application.globalData
}

function controller(page: UploadPageHost): NicknameFlowController {
  page.nicknameFlow ??= new NicknameFlowController(
    applicationData().profileApi ?? unavailableProfileApi(),
    applicationData().publicUser,
  )
  return page.nicknameFlow
}

function synchronize(page: UploadPageHost): void {
  page.setData(controller(page).snapshot())
}

export const uploadPageDefinition = {
  data: {
    ...new NicknameFlowController(unavailableProfileApi()).snapshot(),
    ...EMPTY_UPLOAD_PAGE_DATA,
  } satisfies UploadPageData,

  onLoad(this: UploadPageHost): void {
    const application = applicationData()
    if (application.publicUser !== undefined) {
      this.nicknameFlow = new NicknameFlowController(
        application.profileApi ?? unavailableProfileApi(),
        application.publicUser,
      )
    }
    synchronize(this)

    if (application.ensureSession !== undefined) {
      void application
        .ensureSession()
        .then((user) => {
          if (!this.nicknameInteracted) {
            this.nicknameFlow = new NicknameFlowController(
              application.profileApi ?? unavailableProfileApi(),
              user,
            )
            synchronize(this)
          }
        })
        .catch(() => {
          if (typeof wx === 'object') {
            void wx.showToast({ title: '登录失败，请稍后重试', icon: 'none' })
          }
        })
    }
  },

  onRequestNicknamePrivacy(this: UploadPageHost): void {
    this.nicknameInteracted = true
    const flow = controller(this)
    if (typeof wx !== 'object' || typeof wx.requirePrivacyAuthorize !== 'function') {
      flow.privacyAuthorizationUnavailable()
      synchronize(this)
      return
    }
    flow.requestPrivacyAuthorization()
    synchronize(this)
  },

  onAgreeNicknamePrivacy(this: UploadPageHost): void {
    this.nicknameInteracted = true
    const flow = controller(this)
    if (typeof wx !== 'object' || typeof wx.requirePrivacyAuthorize !== 'function') {
      flow.privacyAuthorizationUnavailable()
      synchronize(this)
      return
    }
    flow.agreePrivacyAuthorization(wx, () => {
      synchronize(this)
    })
    synchronize(this)
  },

  onRejectNicknamePrivacy(this: UploadPageHost): void {
    this.nicknameInteracted = true
    controller(this).rejectPrivacyAuthorization()
    synchronize(this)
  },

  onOpenNicknamePrivacyContract(): void {
    if (typeof wx !== 'object' || typeof wx.openPrivacyContract !== 'function') {
      if (typeof wx === 'object') {
        void wx.showToast({ title: '当前微信版本无法打开隐私保护指引', icon: 'none' })
      }
      return
    }

    wx.openPrivacyContract({
      fail: () => {
        void wx.showToast({ title: '隐私保护指引打开失败，请稍后重试', icon: 'none' })
      },
    })
  },

  onNicknameInput(this: UploadPageHost): void {
    this.nicknameInteracted = true
    controller(this).onNicknameInput()
    synchronize(this)
  },

  onNicknameReviewStart(this: UploadPageHost): void {
    this.nicknameInteracted = true
    controller(this).onNicknameReviewStart()
    synchronize(this)
  },

  async onConfirmNickname(this: UploadPageHost, event: NicknameSubmitEvent): Promise<void> {
    this.nicknameInteracted = true
    const pending = controller(this).onNicknameSubmit(event)
    synchronize(this)
    const saved = await pending
    synchronize(this)
    if (saved && typeof wx === 'object') {
      void wx.showToast({ title: '昵称已确认', icon: 'success' })
    }
  },

  async onNicknameReview(this: UploadPageHost, event: NicknameReviewEvent): Promise<void> {
    this.nicknameInteracted = true
    const pending = controller(this).onNicknameReview(event)
    synchronize(this)
    const saved = await pending
    synchronize(this)
    if (saved && typeof wx === 'object') {
      void wx.showToast({ title: '昵称已确认', icon: 'success' })
    }
  },

  async onChooseMedia(this: UploadPageHost): Promise<void> {
    if (this.data.uploadBatchRunning) return
    const privacy = controller(this).snapshot()
    if (privacy.nicknamePrivacyPromptVisible || privacy.nicknamePrivacyRequesting) {
      if (typeof wx === 'object') {
        void wx.showToast({ title: '请先完成或取消昵称隐私授权', icon: 'none' })
      }
      return
    }

    const application = applicationData()
    const mediaUpload = application.mediaUpload
    if (mediaUpload !== undefined) {
      try {
        const selected = validateMediaSelection(await mediaUpload.chooseMedia())
        const totalBytes = selected.reduce((sum, file) => sum + file.sizeBytes, 0)
        this.selectedMedia = Object.freeze(selected.map((file) => Object.freeze({ ...file })))
        this.setData({
          selectedFiles: selectedFileViews(selected),
          selectedTotalBytes: totalBytes,
          selectedTotalLabel: formatBytes(totalBytes),
          selectionError: null,
          uploadBatchRunning: false,
        })
      } catch (error) {
        const message = selectionErrorMessage(error)
        if (message !== null) {
          this.selectedMedia = []
          this.setData({
            selectedFiles: [],
            selectedTotalBytes: 0,
            selectedTotalLabel: '0 B',
            selectionError: message,
            uploadBatchRunning: false,
          })
        }
        return
      }
      await confirmAndStartUpload(this)
      return
    }
    const chooseMedia = application.chooseMedia
    if (chooseMedia !== undefined) {
      await chooseMedia()
      return
    }
    if (typeof wx === 'object') {
      void wx.showToast({ title: '素材选择功能准备中', icon: 'none' })
    }
  },

  async onStartSelectedUpload(this: UploadPageHost): Promise<void> {
    await confirmAndStartUpload(this)
  },

  onOpenHistory(): void {
    if (typeof wx === 'object' && typeof wx.navigateTo === 'function') {
      void wx.navigateTo({ url: '/pages/history/index' })
    }
  },
}

if (typeof Page === 'function') Page(uploadPageDefinition)
