import { readFileSync } from 'node:fs'

import type { PublicUser } from '@wx-upload/contracts'
import { describe, expect, it, vi } from 'vitest'

import {
  NicknameFlowController,
  type NicknamePrivacyAuthorizationRuntime,
  type NicknameProfileApi,
  type NicknameFlowSnapshot,
  uploadPageDefinition,
} from '../miniprogram/pages/upload/index.js'

const confirmedUser: PublicUser = {
  id: '01981d0c-ec80-7000-8000-000000000101',
  nickname: '小晴',
  nicknameConfirmed: true,
  nicknameConfirmedAt: '2026-07-15T05:00:00.000Z',
  createdAt: '2026-07-15T04:00:00.000Z',
  updatedAt: '2026-07-15T05:00:00.000Z',
}

function fixture(user?: PublicUser) {
  const updateNickname = vi
    .fn<NicknameProfileApi['updateNickname']>()
    .mockResolvedValue(confirmedUser)
  const controller = new NicknameFlowController({ updateNickname }, user)
  return { controller, updateNickname }
}

interface PrivacyHarness {
  readonly runtime: NicknamePrivacyAuthorizationRuntime
  readonly onNeedPrivacyAuthorization: ReturnType<typeof vi.fn>
  readonly requirePrivacyAuthorize: ReturnType<typeof vi.fn>
  succeed(): void
  fail(): void
}

function privacyHarness(): PrivacyHarness {
  let success: (() => void) | undefined
  let fail: (() => void) | undefined
  const onNeedPrivacyAuthorization = vi.fn()
  const requirePrivacyAuthorize = vi.fn(
    (options: Parameters<NicknamePrivacyAuthorizationRuntime['requirePrivacyAuthorize']>[0]) => {
      success = options.success
      fail = options.fail
    },
  )
  const runtime = {
    onNeedPrivacyAuthorization,
    requirePrivacyAuthorize,
  }
  return {
    runtime,
    onNeedPrivacyAuthorization,
    requirePrivacyAuthorize,
    succeed() {
      success?.()
    },
    fail() {
      fail?.()
    },
  }
}

function authorize(controller: NicknameFlowController): void {
  const privacy = privacyHarness()
  controller.requestPrivacyAuthorization()
  controller.agreePrivacyAuthorization(privacy.runtime)
  privacy.succeed()
  expect(controller.snapshot().nicknamePrivacyAuthorized).toBe(true)
}

describe('explicit WeChat nickname privacy authorization', () => {
  it('calls require only after the official agree button event and never installs a global listener', () => {
    const { controller, updateNickname } = fixture()
    const privacy = privacyHarness()

    expect(controller.snapshot()).toMatchObject({
      nicknamePrivacyAuthorized: false,
      nicknamePrivacyRequesting: false,
      nicknamePrivacyPromptVisible: false,
      canCreateUpload: false,
    })

    controller.requestPrivacyAuthorization()
    expect(controller.snapshot()).toMatchObject({
      nicknamePrivacyAuthorized: false,
      nicknamePrivacyRequesting: false,
      nicknamePrivacyPromptVisible: true,
    })
    expect(privacy.onNeedPrivacyAuthorization).not.toHaveBeenCalled()
    expect(privacy.requirePrivacyAuthorize).not.toHaveBeenCalled()

    controller.agreePrivacyAuthorization(privacy.runtime)
    expect(privacy.requirePrivacyAuthorize).toHaveBeenCalledOnce()
    expect(controller.snapshot()).toMatchObject({
      nicknamePrivacyAuthorized: false,
      nicknamePrivacyRequesting: true,
      nicknamePrivacyPromptVisible: false,
    })

    privacy.succeed()
    expect(controller.snapshot()).toMatchObject({
      nicknamePrivacyAuthorized: true,
      nicknamePrivacyRequesting: false,
      nicknamePrivacyPromptVisible: false,
      nicknameError: null,
    })
    expect(updateNickname).not.toHaveBeenCalled()
  })

  it('keeps upload creation blocked and shows a safe message after refusal or platform cancel', () => {
    const { controller, updateNickname } = fixture()
    const privacy = privacyHarness()

    controller.requestPrivacyAuthorization()
    controller.rejectPrivacyAuthorization()
    expect(privacy.onNeedPrivacyAuthorization).not.toHaveBeenCalled()
    expect(privacy.requirePrivacyAuthorize).not.toHaveBeenCalled()
    expect(controller.snapshot()).toMatchObject({
      nicknamePrivacyAuthorized: false,
      nicknamePrivacyRequesting: false,
      nicknamePrivacyPromptVisible: false,
      nicknameError: '你已暂不授权昵称使用，可稍后重试；开始上传前仍需确认昵称',
      canCreateUpload: false,
    })

    controller.requestPrivacyAuthorization()
    controller.agreePrivacyAuthorization(privacy.runtime)
    privacy.fail()
    expect(controller.snapshot()).toMatchObject({
      nicknamePrivacyAuthorized: false,
      nicknamePrivacyRequesting: false,
      nicknameError: '微信昵称授权未完成，请确认隐私保护指引后重试',
      canCreateUpload: false,
    })
    expect(updateNickname).not.toHaveBeenCalled()
  })

  it('disables and guards media selection while the privacy panel is active', async () => {
    const { controller } = fixture()
    const chooseMedia = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)
    const host = {
      data: controller.snapshot(),
      nicknameFlow: controller,
      setData(data: Partial<NicknameFlowSnapshot>) {
        this.data = { ...this.data, ...data }
      },
    }
    vi.stubGlobal('getApp', () => ({ globalData: { chooseMedia } }))

    try {
      controller.requestPrivacyAuthorization()
      await uploadPageDefinition.onChooseMedia.call(host)
      expect(chooseMedia).not.toHaveBeenCalled()

      controller.rejectPrivacyAuthorization()
      await uploadPageDefinition.onChooseMedia.call(host)
      expect(chooseMedia).toHaveBeenCalledOnce()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('race-free WeChat nickname review and form submission', () => {
  it('waits for review pass when submit arrives first and uses only the submitted form value', async () => {
    const { controller, updateNickname } = fixture()
    authorize(controller)

    controller.onNicknameInput()
    controller.onNicknameReviewStart()
    await controller.onNicknameSubmit({ detail: { value: { nickname: ' 小晴 ' } } })

    expect(updateNickname).not.toHaveBeenCalled()
    expect(controller.snapshot()).toMatchObject({
      nicknameDraft: '小晴',
      nicknameReviewPending: true,
      nicknameConfirmed: false,
      canCreateUpload: false,
    })

    await controller.onNicknameReview({ detail: { pass: true, timeout: false } })

    expect(updateNickname).toHaveBeenCalledOnce()
    expect(updateNickname).toHaveBeenCalledWith({
      nickname: '小晴',
      source: 'wechatNicknameInput',
      confirmed: true,
    })
    expect(controller.snapshot()).toMatchObject({
      nickname: '小晴',
      nicknameConfirmed: true,
      nicknameReviewPending: false,
      canCreateUpload: true,
    })
  })

  it('waits for the visible form submit when review pass arrives first', async () => {
    const { controller, updateNickname } = fixture()
    authorize(controller)

    controller.onNicknameInput()
    controller.onNicknameReviewStart()
    await controller.onNicknameReview({ detail: { pass: true, timeout: false } })
    expect(updateNickname).not.toHaveBeenCalled()

    await controller.onNicknameSubmit({ detail: { value: { nickname: '阿远' } } })

    expect(updateNickname).toHaveBeenCalledOnce()
    expect(updateNickname).toHaveBeenCalledWith({
      nickname: '阿远',
      source: 'wechatNicknameInput',
      confirmed: true,
    })
  })

  it.each([
    {
      name: 'failed review after submit',
      reviewFirst: false,
      review: { pass: false, timeout: false },
      message: '该昵称未通过微信安全审核，请重新选择昵称',
    },
    {
      name: 'timed-out review before submit',
      reviewFirst: true,
      review: { pass: false, timeout: true },
      message: '微信昵称审核超时，请重新选择昵称后重试',
    },
  ])('never saves a $name', async ({ reviewFirst, review, message }) => {
    const { controller, updateNickname } = fixture()
    authorize(controller)
    controller.onNicknameInput()
    controller.onNicknameReviewStart()

    if (reviewFirst) {
      await controller.onNicknameReview({ detail: review })
      await controller.onNicknameSubmit({ detail: { value: { nickname: '不应保存' } } })
    } else {
      await controller.onNicknameSubmit({ detail: { value: { nickname: '不应保存' } } })
      await controller.onNicknameReview({ detail: review })
    }

    expect(updateNickname).not.toHaveBeenCalled()
    expect(controller.snapshot()).toMatchObject({
      nicknameDraft: '',
      nicknameConfirmed: false,
      nicknameReviewPending: false,
      nicknameError: message,
      canCreateUpload: false,
    })
  })

  it('does not reuse one review pass for a second form submission', async () => {
    const { controller, updateNickname } = fixture()
    authorize(controller)
    controller.onNicknameInput()
    controller.onNicknameReviewStart()
    await controller.onNicknameReview({ detail: { pass: true, timeout: false } })
    await controller.onNicknameSubmit({ detail: { value: { nickname: '小晴' } } })

    await controller.onNicknameSubmit({ detail: { value: { nickname: '另一个昵称' } } })

    expect(updateNickname).toHaveBeenCalledOnce()
  })

  it('fails closed when a late review can belong to an earlier edited value', async () => {
    const { controller, updateNickname } = fixture()
    authorize(controller)

    controller.onNicknameInput()
    controller.onNicknameReviewStart()
    await controller.onNicknameSubmit({ detail: { value: { nickname: '第一个昵称' } } })

    controller.onNicknameInput()
    controller.onNicknameReviewStart()
    await controller.onNicknameSubmit({ detail: { value: { nickname: '第二个昵称' } } })
    await controller.onNicknameReview({ detail: { pass: true, timeout: false } })
    await controller.onNicknameReview({ detail: { pass: true, timeout: false } })

    expect(updateNickname).not.toHaveBeenCalled()
    expect(controller.snapshot()).toMatchObject({
      nicknameConfirmed: false,
      nicknameReviewPending: false,
      nicknameError: '昵称在审核期间发生变化，请重新选择并确认',
      canCreateUpload: false,
    })

    controller.onNicknameInput()
    controller.onNicknameReviewStart()
    await controller.onNicknameSubmit({ detail: { value: { nickname: '最终昵称' } } })
    await controller.onNicknameReview({ detail: { pass: true, timeout: false } })

    expect(updateNickname).toHaveBeenCalledOnce()
    expect(updateNickname).toHaveBeenCalledWith({
      nickname: '最终昵称',
      source: 'wechatNicknameInput',
      confirmed: true,
    })
  })

  it('keeps the last confirmed nickname usable when a later reviewed update fails', async () => {
    const updateNickname = vi
      .fn<NicknameProfileApi['updateNickname']>()
      .mockRejectedValue(new Error('offline'))
    const controller = new NicknameFlowController({ updateNickname }, confirmedUser)
    authorize(controller)

    controller.onNicknameInput()
    controller.onNicknameReviewStart()
    await controller.onNicknameSubmit({ detail: { value: { nickname: '新昵称' } } })
    await controller.onNicknameReview({ detail: { pass: true, timeout: false } })

    expect(controller.snapshot()).toMatchObject({
      nickname: '小晴',
      nicknameDraft: '新昵称',
      nicknameConfirmed: true,
      canCreateUpload: true,
      nicknameError: '昵称确认失败，请稍后重试',
    })
  })
})

describe('nickname page contract', () => {
  it('uses the official privacy button and gates every nickname input behind authorization', () => {
    const wxml = readFileSync(
      new URL('../miniprogram/pages/upload/index.wxml', import.meta.url),
      'utf8',
    )
    const pageSource = readFileSync(
      new URL('../miniprogram/pages/upload/index.ts', import.meta.url),
      'utf8',
    )

    expect(wxml).toMatch(/bindtap=["']onRequestNicknamePrivacy["']/u)
    expect(wxml).toMatch(
      /id=["']nickname-privacy-agree["'][^>]+open-type=["']agreePrivacyAuthorization["'][^>]+bindagreeprivacyauthorization=["']onAgreeNicknamePrivacy["']/u,
    )
    expect(wxml).toMatch(/bindtap=["']onOpenNicknamePrivacyContract["']/u)
    expect(wxml).toMatch(/bindtap=["']onRejectNicknamePrivacy["']/u)
    expect(wxml).toMatch(/后台.*隐私保护指引.*声明.*昵称收集/su)
    expect(wxml).toMatch(/wx:if=["']\{\{nicknamePrivacyAuthorized\}\}["'][^>]*>\s*<form/su)
    expect(wxml).toMatch(
      /<button[^>]+class=["']upload-button["'][^>]+disabled=["']\{\{nicknamePrivacyPromptVisible \|\| nicknamePrivacyRequesting\}\}["']/u,
    )
    expect(pageSource).not.toMatch(/onNeedPrivacyAuthorization|NicknamePrivacyResolve/u)
  })

  it('collects nickname only through a reviewed form and keeps a separate submit button', () => {
    const wxml = readFileSync(
      new URL('../miniprogram/pages/upload/index.wxml', import.meta.url),
      'utf8',
    )

    expect(wxml).toMatch(/<form[^>]+bindsubmit=["']onConfirmNickname["']/u)
    expect(wxml).toMatch(
      /<input[^>]+name=["']nickname["'][^>]+type=["']nickname["'][^>]+bindnicknamereview=["']onNicknameReview["']/u,
    )
    expect(wxml).toMatch(/bindblur=["']onNicknameReviewStart["']/u)
    expect(wxml).toMatch(/<button[^>]+form-type=["']submit["'][^>]*>\s*确认使用此昵称/su)
    expect(wxml).not.toMatch(/bindblur=["']onNicknameBlur["']|bindtap=["']onConfirmNickname["']/u)
    expect(wxml).toMatch(/<button[^>]+bindtap=["']onChooseMedia["']/u)
    expect(wxml).toMatch(/开始上传前.*确认昵称/su)
    expect(wxml).not.toMatch(/静默获取|实名认证成功|身份已验证/u)
  })
})
