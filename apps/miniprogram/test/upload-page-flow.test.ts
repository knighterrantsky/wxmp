import { readFileSync } from 'node:fs'

import type { PublicUser } from '@wx-upload/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NicknameFlowController,
  uploadPageDefinition,
  type NicknameFlowSnapshot,
  type UploadPageData,
  type UploadUiEvent,
} from '../miniprogram/pages/upload/index.js'

const confirmedUser: PublicUser = {
  id: '01981d0c-ec80-7000-8000-000000000101',
  nickname: '小晴',
  nicknameConfirmed: true,
  nicknameConfirmedAt: '2026-07-15T05:00:00.000Z',
  createdAt: '2026-07-15T04:00:00.000Z',
  updatedAt: '2026-07-15T05:00:00.000Z',
}

const rawSelection = [
  {
    sourcePath: 'wxfile://tmp/summer.jpg',
    fileName: 'summer.jpg',
    sizeBytes: 12,
    kind: 'image' as const,
    mimeType: 'image/jpeg',
    readable: true,
  },
]

function host(user: PublicUser = confirmedUser) {
  const nicknameFlow = new NicknameFlowController(
    { updateNickname: vi.fn().mockResolvedValue(user) },
    user,
  )
  return {
    data: {
      ...nicknameFlow.snapshot(),
      selectedFiles: [],
      selectedTotalBytes: 0,
      selectedTotalLabel: '0 B',
      selectionError: null,
      uploadBatchRunning: false,
    } as UploadPageData,
    nicknameFlow,
    setData(data: Partial<UploadPageData & NicknameFlowSnapshot>) {
      this.data = { ...this.data, ...data }
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('upload page selection and second confirmation', () => {
  it('shows an upgrade error before opening privacy UI on an unsupported base library', () => {
    const page = host({ ...confirmedUser, nickname: null, nicknameConfirmed: false })
    vi.stubGlobal('wx', {})

    uploadPageDefinition.onRequestNicknamePrivacy.call(page)

    expect(page.data).toMatchObject({
      nicknamePrivacyPromptVisible: false,
      nicknamePrivacyAuthorized: false,
      nicknameError: '当前微信版本无法完成昵称授权，请升级微信后重试',
    })
  })

  it('renders the validated list before an explicit cancel and creates no upload', async () => {
    const page = host()
    const chooseMedia = vi.fn().mockResolvedValue(rawSelection)
    const start = vi.fn().mockResolvedValue(undefined)
    const showModal = vi.fn(() => {
      expect(page.data.selectedFiles).toEqual([
        expect.objectContaining({
          fileName: 'summer.jpg',
          kindLabel: '图片',
          sizeLabel: '12 B',
          status: 'ready',
          percent: 0,
        }),
      ])
      expect(page.data.selectedTotalBytes).toBe(12)
      return Promise.resolve({ confirm: false, cancel: true })
    })
    vi.stubGlobal('getApp', () => ({ globalData: { mediaUpload: { chooseMedia, start } } }))
    vi.stubGlobal('wx', { showModal, showToast: vi.fn() })

    await uploadPageDefinition.onChooseMedia.call(page)

    expect(showModal).toHaveBeenCalledWith(
      expect.objectContaining({ confirmText: '开始上传', cancelText: '取消' }),
    )
    expect(start).not.toHaveBeenCalled()
    expect(page.data.uploadBatchRunning).toBe(false)
  })

  it('starts only after confirmation and applies real progress events to the matching file', async () => {
    const page = host()
    const chooseMedia = vi.fn().mockResolvedValue(rawSelection)
    const events: UploadUiEvent[] = [
      {
        sourcePath: rawSelection[0]?.sourcePath ?? '',
        status: 'uploading',
        bytes: 6,
        percent: 50,
      },
      {
        sourcePath: rawSelection[0]?.sourcePath ?? '',
        status: 'finalizing',
        bytes: 12,
        percent: 100,
      },
    ]
    const start = vi.fn((_files, onUpdate: (event: UploadUiEvent) => void) => {
      for (const event of events) onUpdate(event)
      return Promise.resolve()
    })
    vi.stubGlobal('getApp', () => ({ globalData: { mediaUpload: { chooseMedia, start } } }))
    vi.stubGlobal('wx', {
      showModal: vi.fn().mockResolvedValue({ confirm: true, cancel: false }),
      showToast: vi.fn(),
    })

    await uploadPageDefinition.onChooseMedia.call(page)

    expect(start).toHaveBeenCalledOnce()
    expect(start.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ fileName: 'summer.jpg', mimeType: 'image/jpeg' }),
    ])
    expect(page.data.selectedFiles[0]).toMatchObject({
      status: 'finalizing',
      bytes: 12,
      percent: 100,
    })
    expect(page.data.uploadBatchRunning).toBe(false)
  })

  it('blocks upload creation until nickname is confirmed while retaining the selection', async () => {
    const unconfirmedUser = { ...confirmedUser, nickname: null, nicknameConfirmed: false }
    const page = host(unconfirmedUser)
    const chooseMedia = vi.fn().mockResolvedValue(rawSelection)
    const start = vi.fn().mockResolvedValue(undefined)
    const showModal = vi.fn()
    const showToast = vi.fn<(options: { title: string; icon: string }) => void>()
    vi.stubGlobal('getApp', () => ({ globalData: { mediaUpload: { chooseMedia, start } } }))
    vi.stubGlobal('wx', { showModal, showToast })

    await uploadPageDefinition.onChooseMedia.call(page)

    expect(page.data.selectedFiles).toHaveLength(1)
    expect(showModal).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith({ title: '请先确认昵称', icon: 'none' })
  })

  it('fails closed on an invalid selection and never opens confirmation', async () => {
    const page = host()
    const chooseMedia = vi.fn().mockResolvedValue([{ ...rawSelection[0], sizeBytes: 209_715_201 }])
    const start = vi.fn().mockResolvedValue(undefined)
    const showModal = vi.fn()
    vi.stubGlobal('getApp', () => ({ globalData: { mediaUpload: { chooseMedia, start } } }))
    vi.stubGlobal('wx', { showModal, showToast: vi.fn() })

    await uploadPageDefinition.onChooseMedia.call(page)

    expect(page.data.selectedFiles).toEqual([])
    expect(page.data.selectionError).toMatch(/200/u)
    expect(showModal).not.toHaveBeenCalled()
    expect(start).not.toHaveBeenCalled()
  })

  it('does not expose raw picker or upload failures in page state', async () => {
    const page = host()
    const chooseMedia = vi
      .fn()
      .mockRejectedValue(new Error('wxfile://private bearer-secret raw picker text'))
    vi.stubGlobal('getApp', () => ({
      globalData: { mediaUpload: { chooseMedia, start: vi.fn() } },
    }))
    vi.stubGlobal('wx', { showModal: vi.fn(), showToast: vi.fn() })

    await uploadPageDefinition.onChooseMedia.call(page)

    expect(page.data.selectionError).toBe('素材选择失败，请重试')
    expect(JSON.stringify(page.data)).not.toMatch(/wxfile|bearer-secret|raw picker/u)
  })
})

describe('upload page visual contract', () => {
  it('shows file details, total size, progress, and a repeatable confirmation action', () => {
    const wxml = readFileSync(
      new URL('../miniprogram/pages/upload/index.wxml', import.meta.url),
      'utf8',
    )

    expect(wxml).toMatch(/wx:for=["']\{\{selectedFiles\}\}["']/u)
    expect(wxml).toMatch(/\{\{item\.fileName\}\}/u)
    expect(wxml).toMatch(/\{\{item\.kindLabel\}\}.*\{\{item\.sizeLabel\}\}/su)
    expect(wxml).toMatch(/\{\{selectedTotalLabel\}\}/u)
    expect(wxml).toMatch(/\{\{item\.percent\}\}%/u)
    expect(wxml).toMatch(/bindtap=["']onStartSelectedUpload["']/u)
  })
})
