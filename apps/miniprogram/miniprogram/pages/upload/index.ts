import type { NicknameRequest, PublicUser } from '@wx-upload/contracts'

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
  chooseMedia?: () => Promise<void>
}

interface UploadPageHost {
  data: NicknameFlowSnapshot
  setData(data: Partial<NicknameFlowSnapshot>): void
  nicknameFlow?: NicknameFlowController
  nicknameInteracted?: boolean
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
  data: new NicknameFlowController(unavailableProfileApi()).snapshot(),

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
    controller(this).requestPrivacyAuthorization()
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
    const privacy = controller(this).snapshot()
    if (privacy.nicknamePrivacyPromptVisible || privacy.nicknamePrivacyRequesting) {
      if (typeof wx === 'object') {
        void wx.showToast({ title: '请先完成或取消昵称隐私授权', icon: 'none' })
      }
      return
    }

    const chooseMedia = applicationData().chooseMedia
    if (chooseMedia !== undefined) {
      await chooseMedia()
      return
    }
    if (typeof wx === 'object') {
      void wx.showToast({ title: '素材选择功能准备中', icon: 'none' })
    }
  },
}

if (typeof Page === 'function') Page(uploadPageDefinition)
