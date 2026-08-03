import type { NicknameRequest, PublicUser } from '../../generated/contracts.js'

import {
  MediaValidationError,
  renameValidatedMedia,
  splitMediaFileName,
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

export interface NicknameInputEvent {
  readonly detail: {
    readonly value?: unknown
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
  readonly nicknameEditing: boolean
  readonly nicknameReviewPending: boolean
  readonly canChooseMedia: true
  readonly canCreateUpload: boolean
}

export interface SelectedFileView {
  readonly id: string
  readonly previewPath: string
  readonly isVideo: boolean
  readonly hasThumbnail: boolean
  readonly fileName: string
  readonly fileNameStem: string
  readonly fileExtension: string
  readonly kindLabel: '图片' | '视频'
  readonly sizeLabel: string
  readonly sizeBytes: number
}

export interface UploadPageData extends NicknameFlowSnapshot {
  readonly selectedFiles: readonly SelectedFileView[]
  readonly selectedTotalBytes: number
  readonly selectedTotalLabel: string
  readonly selectionError: string | null
  readonly draftPicking: boolean
  readonly draftSubmitting: boolean
}

export interface MediaUploadPageService {
  chooseMedia(maxCount?: number): Promise<readonly MediaSelectionCandidate[]>
  dispatch(files: readonly ValidatedMedia[]): Promise<void>
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
  #nicknameEditing = false
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
      nicknameEditing: this.#nicknameEditing,
      nicknameReviewPending:
        this.#submittedNickname !== null &&
        (this.#nicknameReviewState === 'idle' || this.#nicknameReviewPendingCount > 0),
      canChooseMedia: true,
      canCreateUpload: this.#nicknameConfirmed && !this.#nicknameSaving,
    }
  }

  requestPrivacyAuthorization(onChange: () => void = () => undefined): void {
    if (this.#nicknamePrivacyRequesting || this.#nicknamePrivacyPromptVisible) {
      return
    }

    this.#nicknameEditing = true
    if (this.#nicknamePrivacyAuthorized) {
      this.#nicknameError = null
      onChange()
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
    this.#nicknameEditing = !this.#nicknameConfirmed
    this.#nicknameError = '你已暂不授权昵称使用，可稍后重试；开始上传前仍需确认昵称'
  }

  privacyAuthorizationUnavailable(): void {
    this.#nicknamePrivacyRequestSequence += 1
    this.#nicknamePrivacyAuthorized = false
    this.#nicknamePrivacyRequesting = false
    this.#nicknamePrivacyPromptVisible = false
    this.#nicknameEditing = !this.#nicknameConfirmed
    this.#nicknameError = '当前微信版本无法完成昵称授权，请升级微信后重试'
  }

  onNicknameInput(value: unknown): void {
    if (this.#nicknameSaving) return
    this.#nicknameDraft = typeof value === 'string' ? value : ''
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
      this.#nicknameEditing = false
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
    if (!authorized && this.#nicknameConfirmed) this.#nicknameEditing = false
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
  draftPicking: false,
  draftSubmitting: false,
} as const satisfies Omit<UploadPageData, keyof NicknameFlowSnapshot>

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
  return files.map((file, index) => {
    const previewPath = file.previewPath ?? file.sourcePath
    const name = splitMediaFileName(file.fileName)
    return {
      id: `selected-${String(index + 1)}`,
      previewPath,
      isVideo: file.kind === 'video',
      hasThumbnail: file.kind === 'image' || previewPath !== file.sourcePath,
      fileName: file.fileName,
      fileNameStem: name.stem,
      fileExtension: name.extension,
      kindLabel: file.kind === 'image' ? '图片' : '视频',
      sizeLabel: formatBytes(file.sizeBytes),
      sizeBytes: file.sizeBytes,
    }
  })
}

function emptyDraft(page: UploadPageHost): void {
  page.selectedMedia = []
  page.setData({
    selectedFiles: [],
    selectedTotalBytes: 0,
    selectedTotalLabel: '0 B',
    selectionError: null,
    draftPicking: false,
    draftSubmitting: false,
  })
}

function navigateToHistory(watchForNewUpload: boolean): void {
  if (typeof wx !== 'object' || typeof wx.navigateTo !== 'function') return
  wx.navigateTo({
    url: watchForNewUpload ? '/pages/history/index?watch=1' : '/pages/history/index',
    fail: () => {
      if (typeof wx.showToast !== 'function') return
      void wx.showToast({
        title: watchForNewUpload ? '上传已开始，可从上传记录查看' : '上传记录打开失败，请重试',
        icon: 'none',
      })
    },
  })
}

async function startSelectedUpload(page: UploadPageHost): Promise<void> {
  const selected = page.selectedMedia ?? []
  const service = applicationData().mediaUpload
  if (
    selected.length === 0 ||
    service === undefined ||
    page.data.draftPicking ||
    page.data.draftSubmitting
  ) {
    return
  }

  const nickname = controller(page).snapshot()
  if (nickname.nicknameSaving) {
    if (typeof wx === 'object') {
      void wx.showToast({ title: '昵称正在更新，请稍候', icon: 'none' })
    }
    return
  }
  if (!nickname.canCreateUpload) {
    if (typeof wx === 'object') {
      void wx.showToast({ title: '请先确认昵称', icon: 'none' })
    }
    return
  }

  page.setData({ selectionError: null, draftSubmitting: true })
  try {
    await service.dispatch([...selected])
  } catch {
    page.setData({ selectionError: '上传任务创建失败，请稍后重试', draftSubmitting: false })
    return
  }

  emptyDraft(page)
  navigateToHistory(true)
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

  onNicknameInput(this: UploadPageHost, event: NicknameInputEvent): void {
    this.nicknameInteracted = true
    controller(this).onNicknameInput(event.detail.value)
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
    if (this.data.draftPicking || this.data.draftSubmitting) return
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
      const current = this.selectedMedia ?? []
      const remainingCount = 9 - current.length
      if (remainingCount < 1) {
        this.setData({ selectionError: '一次最多选择 9 个文件' })
        return
      }
      this.setData({ draftPicking: true, selectionError: null })
      try {
        const newlySelected = await mediaUpload.chooseMedia(remainingCount)
        const selected = validateMediaSelection([
          ...current.map((file) => ({ ...file, readable: true })),
          ...newlySelected,
        ])
        const totalBytes = selected.reduce((sum, file) => sum + file.sizeBytes, 0)
        this.selectedMedia = Object.freeze(selected.map((file) => Object.freeze({ ...file })))
        this.setData({
          selectedFiles: selectedFileViews(selected),
          selectedTotalBytes: totalBytes,
          selectedTotalLabel: formatBytes(totalBytes),
          selectionError: null,
          draftPicking: false,
        })
      } catch (error) {
        const message = selectionErrorMessage(error)
        if (message !== null) {
          this.setData({
            selectionError: message,
            draftPicking: false,
          })
        } else {
          this.setData({ draftPicking: false })
        }
        return
      }
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

  onRemoveSelectedMedia(
    this: UploadPageHost,
    event: { readonly currentTarget: { readonly dataset: { readonly index?: unknown } } },
  ): void {
    if (this.data.draftPicking || this.data.draftSubmitting) return
    const index = Number(event.currentTarget.dataset.index)
    const selected = this.selectedMedia ?? []
    if (!Number.isSafeInteger(index) || index < 0 || index >= selected.length) return

    const remaining = selected.filter((_file, itemIndex) => itemIndex !== index)
    if (remaining.length === 0) {
      emptyDraft(this)
      return
    }
    const totalBytes = remaining.reduce((sum, file) => sum + file.sizeBytes, 0)
    this.selectedMedia = Object.freeze(remaining)
    this.setData({
      selectedFiles: selectedFileViews(remaining),
      selectedTotalBytes: totalBytes,
      selectedTotalLabel: formatBytes(totalBytes),
      selectionError: null,
    })
  },

  onRenameSelectedMedia(
    this: UploadPageHost,
    event: {
      readonly detail: { readonly value?: unknown }
      readonly currentTarget: { readonly dataset: { readonly index?: unknown } }
    },
  ): void {
    if (this.data.draftPicking || this.data.draftSubmitting) return
    const index = Number(event.currentTarget.dataset.index)
    const nextStem = event.detail.value
    const selected = this.selectedMedia ?? []
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= selected.length ||
      typeof nextStem !== 'string'
    ) {
      return
    }

    const current = selected[index]
    if (current === undefined) return
    try {
      const renamed = renameValidatedMedia(current, nextStem)
      const next = selected.map((file, itemIndex) => (itemIndex === index ? renamed : file))
      this.selectedMedia = Object.freeze(next.map((file) => Object.freeze({ ...file })))
      this.setData({ selectedFiles: selectedFileViews(next), selectionError: null })
    } catch {
      this.setData({ selectionError: '文件名不能为空，且不能包含斜杠或控制字符' })
    }
  },

  async onStartSelectedUpload(this: UploadPageHost): Promise<void> {
    await startSelectedUpload(this)
  },

  onOpenHistory(): void {
    navigateToHistory(false)
  },
}

if (typeof Page === 'function') Page(uploadPageDefinition)
