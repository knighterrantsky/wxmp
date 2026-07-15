import { readFileSync } from 'node:fs'

import type { Pagination, UploadHistoryResponse } from '@wx-upload/contracts'
import { describe, expect, it, vi } from 'vitest'

import {
  HistoryController,
  historyPageDefinition,
  type HistoryApi,
  type HistorySchedule,
} from '../miniprogram/pages/history/index.js'

const now = '2026-07-15T05:10:00.000Z'
const uploadId = '01981d0c-ec80-7000-8000-000000000103'
const mediaId = '01981d0c-ec80-7000-8000-000000000104'

function historyItem(
  status: UploadHistoryResponse['data']['items'][number]['status'],
  overrides: { readonly id?: string; readonly fileName?: string } = {},
): UploadHistoryResponse['data']['items'][number] {
  return {
    id: uploadId,
    mediaId,
    status,
    fileName: 'summer.jpg',
    kind: 'image',
    mimeType: 'image/jpeg',
    sizeBytes: 12,
    progress: {
      confirmedBytes: status === 'uploading' ? 6 : 12,
      totalBytes: 12,
      percent: status === 'uploading' ? 50 : 100,
    },
    failure:
      status === 'upload_failed'
        ? {
            stage: 'storage',
            code: 'STORAGE_UNAVAILABLE',
            message: 'raw storage path and upstream text',
            failedAt: now,
          }
        : null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  }
}

function page(items: UploadHistoryResponse['data']['items'], pagination?: Partial<Pagination>) {
  return {
    items,
    pagination: {
      limit: 20,
      hasMore: false,
      nextCursor: null,
      ...pagination,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

function harness(firstPage = page([historyItem('uploaded')])) {
  const list = vi.fn<HistoryApi['list']>().mockResolvedValue(firstPage)
  const getUpload = vi.fn<HistoryApi['getUpload']>()
  const api: HistoryApi = {
    list,
    getUpload,
  }
  const scheduled: { callback: () => void; delayMs: number }[] = []
  const schedule: HistorySchedule = (callback, delayMs) => {
    scheduled.push({ callback, delayMs })
    return scheduled.length
  }
  const cancel = vi.fn()
  const controller = new HistoryController({ api, schedule, cancel })
  return { api, list, getUpload, scheduled, cancel, controller }
}

describe('history controller', () => {
  it('renders uploaded as terminal success and never polls it', async () => {
    const { getUpload, scheduled, controller } = harness()

    await controller.loadFirstPage()

    expect(controller.snapshot().records).toEqual([
      expect.objectContaining({
        fileName: 'summer.jpg',
        kindLabel: '图片',
        sizeLabel: '12 B',
        statusLabel: '已上传',
        tone: 'success',
        terminal: true,
        percent: 100,
      }),
    ])
    expect(getUpload).not.toHaveBeenCalled()
    expect(scheduled).toEqual([])
  })

  it('refreshes multiple nonterminal records with one five-second list request and stops at terminal states', async () => {
    const cancellingId = '01981d0c-ec80-7000-8000-000000000106'
    const finalizing = historyItem('finalizing')
    const cancelling = historyItem('cancelling', {
      id: cancellingId,
      fileName: 'cancel.mov',
    })
    const fixture = harness(page([finalizing, cancelling]))
    fixture.list.mockResolvedValueOnce(page([finalizing, cancelling])).mockResolvedValueOnce(
      page([
        historyItem('uploaded'),
        historyItem('aborted', {
          id: cancellingId,
          fileName: 'cancel.mov',
        }),
      ]),
    )

    await fixture.controller.loadFirstPage()

    expect(fixture.list).toHaveBeenCalledOnce()
    expect(fixture.getUpload).not.toHaveBeenCalled()
    expect(fixture.scheduled).toHaveLength(1)
    expect(fixture.scheduled[0]?.delayMs).toBe(5_000)
    expect(60_000 / (fixture.scheduled[0]?.delayMs ?? 1)).toBeLessThan(60)

    fixture.scheduled[0]?.callback()
    await vi.waitFor(() => {
      expect(fixture.controller.snapshot().records.map((record) => record.status)).toEqual([
        'uploaded',
        'aborted',
      ])
    })
    expect(fixture.scheduled).toHaveLength(1)
    expect(fixture.getUpload).not.toHaveBeenCalled()
  })

  it('uses the opaque next cursor, appends once, and deduplicates records by id', async () => {
    const first = historyItem('uploaded')
    const second = { ...first, id: '01981d0c-ec80-7000-8000-000000000105', fileName: 'next.mov' }
    const fixture = harness(page([first], { hasMore: true, nextCursor: 'signed+/cursor=' }))
    fixture.list
      .mockResolvedValueOnce(page([first], { hasMore: true, nextCursor: 'signed+/cursor=' }))
      .mockResolvedValueOnce(page([first, second]))

    await fixture.controller.loadFirstPage()
    await fixture.controller.loadNextPage()

    expect(fixture.list).toHaveBeenNthCalledWith(2, {
      limit: 20,
      cursor: 'signed+/cursor=',
    })
    expect(fixture.controller.snapshot().records.map((record) => record.fileName)).toEqual([
      'summer.jpg',
      'next.mov',
    ])
  })

  it('keeps one centralized timer when pagination adds another nonterminal record', async () => {
    const first = historyItem('finalizing')
    const second = historyItem('cancelling', {
      id: '01981d0c-ec80-7000-8000-000000000105',
      fileName: 'next.mov',
    })
    const fixture = harness(page([first], { hasMore: true, nextCursor: 'signed-cursor' }))
    fixture.list
      .mockResolvedValueOnce(page([first], { hasMore: true, nextCursor: 'signed-cursor' }))
      .mockResolvedValueOnce(page([second]))

    await fixture.controller.loadFirstPage()
    await fixture.controller.loadNextPage()

    expect(fixture.controller.snapshot().records).toHaveLength(2)
    expect(fixture.scheduled).toHaveLength(1)
    expect(fixture.scheduled[0]?.delayMs).toBe(5_000)
    expect(fixture.getUpload).not.toHaveBeenCalled()
  })

  it('does not poll forever for a stale nonterminal record outside the 100-item refresh window', async () => {
    const newestWindow = Array.from({ length: 100 }, (_, index) =>
      historyItem(index === 0 ? 'finalizing' : 'uploaded', { id: `upload-${String(index)}` }),
    )
    const staleOlderRecord = historyItem('finalizing', { id: 'upload-older-than-window' })
    const refreshedWindow = newestWindow.map((item) => ({
      ...item,
      status: 'uploaded' as const,
    }))
    const fixture = harness(page([...newestWindow, staleOlderRecord]))
    fixture.list
      .mockResolvedValueOnce(page([...newestWindow, staleOlderRecord]))
      .mockResolvedValueOnce(page(refreshedWindow))

    await fixture.controller.loadFirstPage()
    fixture.scheduled[0]?.callback()
    await vi.waitFor(() => {
      expect(fixture.list).toHaveBeenCalledTimes(2)
    })

    expect(fixture.list).toHaveBeenNthCalledWith(2, { limit: 100 })
    expect(fixture.controller.snapshot().records.at(-1)?.status).toBe('finalizing')
    expect(fixture.scheduled).toHaveLength(1)
  })

  it('uses fixed failure copy instead of server or storage details', async () => {
    const { controller } = harness(page([historyItem('upload_failed')]))

    await controller.loadFirstPage()

    expect(controller.snapshot().records[0]?.failureMessage).toBe('上传失败，请稍后重试')
    expect(JSON.stringify(controller.snapshot())).not.toMatch(/raw storage|upstream|mediaId/u)
  })

  it('cancels pending poll timers on dispose', async () => {
    const fixture = harness(page([historyItem('finalizing')]))
    await fixture.controller.loadFirstPage()

    fixture.controller.dispose()

    expect(fixture.cancel).toHaveBeenCalledOnce()
  })

  it('ignores an old centralized refresh after a first-page refresh starts a new generation', async () => {
    const fixture = harness(page([historyItem('finalizing')]))
    const oldRefresh = deferred<ReturnType<typeof page>>()
    fixture.list
      .mockResolvedValueOnce(page([historyItem('finalizing')]))
      .mockImplementationOnce(() => oldRefresh.promise)
      .mockResolvedValueOnce(page([historyItem('uploaded')]))

    await fixture.controller.loadFirstPage()
    fixture.scheduled[0]?.callback()
    await vi.waitFor(() => {
      expect(fixture.list).toHaveBeenCalledTimes(2)
    })

    await fixture.controller.loadFirstPage(true)
    expect(fixture.controller.snapshot().records[0]?.status).toBe('uploaded')

    oldRefresh.resolve(page([historyItem('finalizing')]))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(fixture.controller.snapshot().records[0]?.status).toBe('uploaded')
    expect(fixture.scheduled).toHaveLength(1)
    expect(fixture.getUpload).not.toHaveBeenCalled()
  })

  it('ignores an old cursor page that resolves after a first-page refresh', async () => {
    const first = historyItem('uploaded')
    const staleNext = {
      ...first,
      id: '01981d0c-ec80-7000-8000-000000000105',
      fileName: 'stale-next.mov',
    }
    const fresh = { ...first, fileName: 'fresh-first.jpg' }
    const oldPage = deferred<ReturnType<typeof page>>()
    const fixture = harness(page([first], { hasMore: true, nextCursor: 'old-cursor' }))
    fixture.list
      .mockResolvedValueOnce(page([first], { hasMore: true, nextCursor: 'old-cursor' }))
      .mockImplementationOnce(() => oldPage.promise)
      .mockResolvedValueOnce(page([fresh]))

    await fixture.controller.loadFirstPage()
    const loadingMore = fixture.controller.loadNextPage()
    await vi.waitFor(() => {
      expect(fixture.list).toHaveBeenCalledTimes(2)
    })

    await fixture.controller.loadFirstPage(true)
    oldPage.resolve(page([staleNext]))
    await loadingMore

    expect(fixture.controller.snapshot().records.map((record) => record.fileName)).toEqual([
      'fresh-first.jpg',
    ])
  })

  it('retries a transient centralized refresh failure after five seconds and clears the safe error', async () => {
    const fixture = harness(page([historyItem('finalizing')]))
    fixture.list
      .mockResolvedValueOnce(page([historyItem('finalizing')]))
      .mockRejectedValueOnce(new Error('raw r2 path and bearer secret'))
      .mockResolvedValueOnce(page([historyItem('uploaded')]))

    await fixture.controller.loadFirstPage()

    expect(fixture.controller.snapshot().error).toBeNull()
    expect(fixture.scheduled).toHaveLength(1)
    expect(fixture.scheduled[0]?.delayMs).toBe(5_000)

    fixture.scheduled[0]?.callback()
    await vi.waitFor(() => {
      expect(fixture.controller.snapshot().error).toBe('上传记录加载失败，请稍后重试')
    })
    expect(fixture.scheduled).toHaveLength(2)
    expect(fixture.scheduled[1]?.delayMs).toBe(5_000)
    expect(JSON.stringify(fixture.controller.snapshot())).not.toMatch(/r2 path|bearer secret/u)

    fixture.scheduled[1]?.callback()
    await vi.waitFor(() => {
      expect(fixture.controller.snapshot().records[0]?.status).toBe('uploaded')
    })
    expect(fixture.controller.snapshot().error).toBeNull()
    expect(fixture.scheduled).toHaveLength(2)
    expect(fixture.getUpload).not.toHaveBeenCalled()
  })

  it('restores polling for retained nonterminal records when a pull refresh fails', async () => {
    const fixture = harness(page([historyItem('finalizing')]))
    fixture.list
      .mockResolvedValueOnce(page([historyItem('finalizing')]))
      .mockRejectedValueOnce(new Error('temporary list failure'))

    await fixture.controller.loadFirstPage()
    expect(fixture.scheduled).toHaveLength(1)

    await fixture.controller.loadFirstPage(true)

    expect(fixture.controller.snapshot().records[0]?.status).toBe('finalizing')
    expect(fixture.controller.snapshot().error).toBe('上传记录加载失败，请稍后重试')
    expect(fixture.cancel).toHaveBeenCalledOnce()
    expect(fixture.scheduled).toHaveLength(2)
    expect(fixture.scheduled[1]?.delayMs).toBe(5_000)
    expect(fixture.getUpload).not.toHaveBeenCalled()
  })

  it('pauses timers on page hide and reloads exactly once on repeated page show', async () => {
    const fixture = harness(page([historyItem('finalizing')]))
    fixture.list.mockResolvedValue(page([historyItem('finalizing')]))
    await fixture.controller.loadFirstPage()
    const hiddenTimer = fixture.scheduled[0]
    const host = { historyController: fixture.controller }
    const lifecycle = historyPageDefinition as unknown as {
      onHide(this: typeof host): void
      onShow(this: typeof host): void
    }

    lifecycle.onHide.call(host)
    hiddenTimer?.callback()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fixture.cancel).toHaveBeenCalledOnce()
    expect(fixture.list).toHaveBeenCalledOnce()

    lifecycle.onShow.call(host)
    lifecycle.onShow.call(host)
    await vi.waitFor(() => {
      expect(fixture.list).toHaveBeenCalledTimes(2)
    })
    expect(fixture.scheduled).toHaveLength(2)
    expect(fixture.getUpload).not.toHaveBeenCalled()
  })
})

describe('history page privacy contract', () => {
  it('has no preview, download, share, delete, R2 path, ETag, or content action', () => {
    const wxml = readFileSync(
      new URL('../miniprogram/pages/history/index.wxml', import.meta.url),
      'utf8',
    )

    expect(wxml).toMatch(/\{\{item\.fileName\}\}/u)
    expect(wxml).toMatch(/\{\{item\.statusLabel\}\}/u)
    expect(wxml).toMatch(/\{\{item\.percent\}\}%/u)
    expect(wxml).not.toMatch(/preview|download|share|delete|objectKey|r2|etag|bindtap/iu)
  })
})
