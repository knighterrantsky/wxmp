import { readFileSync } from 'node:fs'

import type { PublicUser } from '@wx-upload/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NicknameFlowController,
  uploadPageDefinition,
  type NicknameFlowSnapshot,
  type UploadPageData,
} from '../miniprogram/pages/upload/index.js'
import { WechatMediaSelectionError } from '../miniprogram/runtime/wx-media.js'

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
    previewPath: 'wxfile://tmp/summer.jpg',
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
      draftPicking: false,
      draftSubmitting: false,
      draftUploadFailed: false,
    } as UploadPageData,
    nicknameFlow,
    setData(data: Partial<UploadPageData & NicknameFlowSnapshot>) {
      this.data = { ...this.data, ...data }
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve
  })
  return { promise, resolve }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('upload draft selection and explicit submission', () => {
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

  it('renders a thumbnail draft without opening a modal or starting an upload', async () => {
    const page = host()
    const chooseMedia = vi.fn().mockResolvedValue(rawSelection)
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const showModal = vi.fn()
    vi.stubGlobal('getApp', () => ({ globalData: { mediaUpload: { chooseMedia, dispatch } } }))
    vi.stubGlobal('wx', { showModal, showToast: vi.fn() })

    await uploadPageDefinition.onChooseMedia.call(page)

    expect(page.data.selectedFiles).toEqual([
      expect.objectContaining({
        previewPath: 'wxfile://tmp/summer.jpg',
        hasThumbnail: true,
        fileName: 'summer.jpg',
        kindLabel: '图片',
        sizeLabel: '12 B',
      }),
    ])
    expect(page.data.selectedTotalBytes).toBe(12)
    expect(page.data.draftPicking).toBe(false)
    expect(showModal).not.toHaveBeenCalled()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('keeps the previous draft when the user cancels reselecting', async () => {
    const page = host()
    const chooseMedia = vi
      .fn()
      .mockResolvedValueOnce(rawSelection)
      .mockRejectedValueOnce(new WechatMediaSelectionError('CANCELLED'))
    vi.stubGlobal('getApp', () => ({
      globalData: { mediaUpload: { chooseMedia, dispatch: vi.fn() } },
    }))
    vi.stubGlobal('wx', { showToast: vi.fn() })

    await uploadPageDefinition.onChooseMedia.call(page)
    const previous = page.data.selectedFiles
    await uploadPageDefinition.onChooseMedia.call(page)

    expect(page.data.selectedFiles).toEqual(previous)
    expect(page.data.selectedTotalBytes).toBe(12)
    expect(page.data.selectionError).toBeNull()
    expect(page.data.draftPicking).toBe(false)
  })

  it('keeps the previous draft when an added selection is invalid', async () => {
    const page = host()
    const chooseMedia = vi
      .fn()
      .mockResolvedValueOnce(rawSelection)
      .mockResolvedValueOnce([
        {
          ...rawSelection[0],
          sourcePath: 'wxfile://tmp/oversized.jpg',
          fileName: 'oversized.jpg',
          sizeBytes: 209_715_201,
        },
      ])
    vi.stubGlobal('getApp', () => ({
      globalData: { mediaUpload: { chooseMedia, dispatch: vi.fn() } },
    }))
    vi.stubGlobal('wx', { showToast: vi.fn() })

    await uploadPageDefinition.onChooseMedia.call(page)
    const previous = page.data.selectedFiles
    await uploadPageDefinition.onChooseMedia.call(page)

    expect(page.data.selectedFiles).toEqual(previous)
    expect(page.data.selectedTotalBytes).toBe(12)
    expect(page.data.selectionError).toMatch(/200/u)
  })

  it('atomically adds a video to an existing image draft', async () => {
    const page = host()
    const replacement = [
      {
        ...rawSelection[0],
        sourcePath: 'wxfile://tmp/replacement.mp4',
        previewPath: 'wxfile://tmp/replacement-cover.jpg',
        fileName: 'replacement.mp4',
        sizeBytes: 24,
        kind: 'video' as const,
        mimeType: 'video/mp4',
      },
    ]
    const chooseMedia = vi
      .fn()
      .mockResolvedValueOnce(rawSelection)
      .mockResolvedValueOnce(replacement)
    vi.stubGlobal('getApp', () => ({
      globalData: { mediaUpload: { chooseMedia, dispatch: vi.fn() } },
    }))
    vi.stubGlobal('wx', { showToast: vi.fn() })

    await uploadPageDefinition.onChooseMedia.call(page)
    await uploadPageDefinition.onChooseMedia.call(page)

    expect(page.data.selectedFiles).toEqual([
      expect.objectContaining({ fileName: 'summer.jpg', isVideo: false }),
      expect.objectContaining({ fileName: 'replacement.mp4', isVideo: true }),
    ])
    expect(page.data.selectedTotalBytes).toBe(36)
    expect(chooseMedia).toHaveBeenNthCalledWith(1, 9)
    expect(chooseMedia).toHaveBeenNthCalledWith(2, 8)
  })

  it('allows only one active picker so late results cannot overwrite each other', async () => {
    const page = host()
    const selection = deferred<typeof rawSelection>()
    const chooseMedia = vi.fn(() => selection.promise)
    vi.stubGlobal('getApp', () => ({
      globalData: { mediaUpload: { chooseMedia, dispatch: vi.fn() } },
    }))
    vi.stubGlobal('wx', { showToast: vi.fn() })

    const first = uploadPageDefinition.onChooseMedia.call(page)
    const second = uploadPageDefinition.onChooseMedia.call(page)
    expect(chooseMedia).toHaveBeenCalledOnce()
    expect(page.data.draftPicking).toBe(true)

    selection.resolve(rawSelection)
    await Promise.all([first, second])
    expect(page.data.selectedFiles).toHaveLength(1)
  })

  it('removes one draft item and returns to empty after removing the last item', async () => {
    const page = host()
    const twoFiles = [
      rawSelection[0],
      {
        ...rawSelection[0],
        sourcePath: 'wxfile://tmp/movie.mp4',
        previewPath: 'wxfile://tmp/movie-cover.jpg',
        fileName: 'movie.mp4',
        sizeBytes: 24,
        kind: 'video' as const,
        mimeType: 'video/mp4',
      },
    ]
    vi.stubGlobal('getApp', () => ({
      globalData: {
        mediaUpload: { chooseMedia: vi.fn().mockResolvedValue(twoFiles), dispatch: vi.fn() },
      },
    }))
    vi.stubGlobal('wx', { showToast: vi.fn() })
    await uploadPageDefinition.onChooseMedia.call(page)

    uploadPageDefinition.onRemoveSelectedMedia.call(page, {
      currentTarget: { dataset: { index: 0 } },
    })
    expect(page.data.selectedFiles).toEqual([
      expect.objectContaining({ fileName: 'movie.mp4', isVideo: true, hasThumbnail: true }),
    ])
    expect(page.data.selectedTotalBytes).toBe(24)

    uploadPageDefinition.onRemoveSelectedMedia.call(page, {
      currentTarget: { dataset: { index: 0 } },
    })
    expect(page.data.selectedFiles).toEqual([])
    expect(page.data.selectedTotalLabel).toBe('0 B')
  })

  it('renames only the editable stem and preserves the fixed extension for dispatch', async () => {
    const page = host()
    const dispatch = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('getApp', () => ({
      globalData: {
        mediaUpload: { chooseMedia: vi.fn().mockResolvedValue(rawSelection), dispatch },
      },
    }))
    vi.stubGlobal('wx', { navigateTo: vi.fn(), showToast: vi.fn() })
    await uploadPageDefinition.onChooseMedia.call(page)

    uploadPageDefinition.onRenameSelectedMedia.call(page, {
      detail: { value: '杭州行程' },
      currentTarget: { dataset: { index: 0 } },
    })
    await uploadPageDefinition.onStartSelectedUpload.call(page)

    expect(dispatch.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ fileName: '杭州行程.jpg', mimeType: 'image/jpeg' }),
    ])
  })

  it('uses the preview button as confirmation, clears the draft, and opens watched history', async () => {
    const page = host()
    const chooseMedia = vi.fn().mockResolvedValue(rawSelection)
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const navigateTo = vi.fn()
    const showModal = vi.fn()
    vi.stubGlobal('getApp', () => ({ globalData: { mediaUpload: { chooseMedia, dispatch } } }))
    vi.stubGlobal('wx', { navigateTo, showModal, showToast: vi.fn() })
    await uploadPageDefinition.onChooseMedia.call(page)

    await uploadPageDefinition.onStartSelectedUpload.call(page)

    expect(dispatch).toHaveBeenCalledOnce()
    expect(dispatch.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({ fileName: 'summer.jpg', mimeType: 'image/jpeg' }),
    ])
    expect(showModal).not.toHaveBeenCalled()
    expect(page.data.selectedFiles).toEqual([])
    expect(page.data.draftSubmitting).toBe(false)
    expect(navigateTo).toHaveBeenCalledWith(
      expect.objectContaining({ url: '/pages/history/index?watch=1' }),
    )
  })

  it('blocks submission until nickname is confirmed while retaining the draft', async () => {
    const unconfirmedUser = { ...confirmedUser, nickname: null, nicknameConfirmed: false }
    const page = host(unconfirmedUser)
    const chooseMedia = vi.fn().mockResolvedValue(rawSelection)
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const showToast = vi.fn<(options: { title: string; icon: string }) => void>()
    vi.stubGlobal('getApp', () => ({ globalData: { mediaUpload: { chooseMedia, dispatch } } }))
    vi.stubGlobal('wx', { navigateTo: vi.fn(), showToast })
    await uploadPageDefinition.onChooseMedia.call(page)

    await uploadPageDefinition.onStartSelectedUpload.call(page)

    expect(page.data.selectedFiles).toHaveLength(1)
    expect(dispatch).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith({ title: '请先确认昵称', icon: 'none' })
  })

  it('keeps the draft when dispatch preflight rejects an expired local file', async () => {
    const page = host()
    const chooseMedia = vi.fn().mockResolvedValue(rawSelection)
    const dispatch = vi.fn().mockRejectedValue(new Error('private expired source path'))
    const navigateTo = vi.fn()
    vi.stubGlobal('getApp', () => ({ globalData: { mediaUpload: { chooseMedia, dispatch } } }))
    vi.stubGlobal('wx', { navigateTo, showToast: vi.fn() })
    await uploadPageDefinition.onChooseMedia.call(page)

    await uploadPageDefinition.onStartSelectedUpload.call(page)

    expect(page.data.selectedFiles).toHaveLength(1)
    expect(page.data.draftSubmitting).toBe(false)
    expect(page.data.selectionError).toBe('上传任务创建失败，请点击重试上传')
    expect(page.data.draftUploadFailed).toBe(true)
    expect(navigateTo).not.toHaveBeenCalled()
    expect(JSON.stringify(page.data)).not.toMatch(/private expired|source path/u)
  })

  it('sanitizes picker failures without exposing local paths', async () => {
    const page = host()
    const chooseMedia = vi
      .fn()
      .mockRejectedValue(new Error('wxfile://private bearer-secret raw picker text'))
    vi.stubGlobal('getApp', () => ({
      globalData: { mediaUpload: { chooseMedia, dispatch: vi.fn() } },
    }))
    vi.stubGlobal('wx', { showToast: vi.fn() })

    await uploadPageDefinition.onChooseMedia.call(page)

    expect(page.data.selectionError).toBe('素材选择失败，请重试')
    expect(JSON.stringify(page.data)).not.toMatch(/wxfile|bearer-secret|raw picker/u)
  })
})

describe('upload page visual contract', () => {
  it('separates local preview from upload status and uses one page-level confirmation', () => {
    const wxml = readFileSync(
      new URL('../miniprogram/pages/upload/index.wxml', import.meta.url),
      'utf8',
    )
    const pageSource = readFileSync(
      new URL('../miniprogram/pages/upload/index.ts', import.meta.url),
      'utf8',
    )

    expect(wxml).toMatch(/wx:for=["']\{\{selectedFiles\}\}["']/u)
    expect(wxml).toMatch(/<image[^>]+src=["']\{\{item\.previewPath\}\}["']/u)
    expect(wxml).toMatch(/catchtap=["']onRemoveSelectedMedia["']/u)
    expect(wxml).toMatch(/bindtap=["']onStartSelectedUpload["']/u)
    expect(wxml).toMatch(/继续添加/u)
    expect(wxml).toMatch(/bindinput=["']onRenameSelectedMedia["']/u)
    expect(wxml).toMatch(/\{\{item\.fileExtension\}\}/u)
    expect(wxml).not.toMatch(/item\.percent|item\.statusLabel|progress-track/u)
    expect(pageSource).not.toMatch(/showModal\(|确认上传素材/u)
  })
})
