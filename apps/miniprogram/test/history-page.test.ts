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
  const cancelUpload = vi.fn<HistoryApi['cancel']>().mockResolvedValue(undefined)
  const clearUploaded = vi.fn<HistoryApi['clearUploaded']>().mockResolvedValue(1)
  const retry = vi.fn<HistoryApi['retry']>().mockResolvedValue(true)
  const deleteRecord = vi.fn<HistoryApi['deleteRecord']>().mockResolvedValue(undefined)
  const api: HistoryApi = {
    list,
    getUpload,
    cancel: cancelUpload,
    clearUploaded,
    retry,
    deleteRecord,
  }
  const scheduled: { callback: () => void; delayMs: number }[] = []
  const schedule: HistorySchedule = (callback, delayMs) => {
    scheduled.push({ callback, delayMs })
    return scheduled.length
  }
  const cancel = vi.fn()
  const controller = new HistoryController({ api, schedule, cancel })
  return {
    api,
    list,
    getUpload,
    cancelUpload,
    clearUploaded,
    retry,
    deleteRecord,
    scheduled,
    cancel,
    controller,
  }
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

  it('refreshes uploading, finalizing, and cancelling records with one list request', async () => {
    const cancellingId = '01981d0c-ec80-7000-8000-000000000106'
    const finalizing = historyItem('finalizing')
    const cancelling = historyItem('cancelling', {
      id: cancellingId,
      fileName: 'cancel.mov',
    })
    const uploading = historyItem('uploading', {
      id: '01981d0c-ec80-7000-8000-000000000107',
      fileName: 'active.jpg',
    })
    const fixture = harness(page([uploading, finalizing, cancelling]))
    fixture.list
      .mockResolvedValueOnce(page([uploading, finalizing, cancelling]))
      .mockResolvedValueOnce(
        page([
          historyItem('uploaded', {
            id: '01981d0c-ec80-7000-8000-000000000107',
            fileName: 'active.jpg',
          }),
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

  it('maps public failure codes to actionable copy without server or storage details', async () => {
    const { controller } = harness(page([historyItem('upload_failed')]))

    await controller.loadFirstPage()

    expect(controller.snapshot().records[0]?.failureMessage).toBe(
      '服务器暂时无法接收，请稍后手动重试',
    )
    expect(JSON.stringify(controller.snapshot())).not.toMatch(/raw storage|upstream|mediaId/u)
  })

  it('cancels pending poll timers on dispose', async () => {
    const fixture = harness(page([historyItem('finalizing')]))
    await fixture.controller.loadFirstPage()

    fixture.controller.dispose()

    expect(fixture.cancel).toHaveBeenCalledOnce()
  })

  it('optimistically marks an active upload as cancelling and prevents duplicate requests', async () => {
    const fixture = harness(page([historyItem('uploading')]))
    const request = deferred<undefined>()
    fixture.cancelUpload.mockImplementation(() => request.promise)
    await fixture.controller.loadFirstPage()

    const first = fixture.controller.cancelUpload(uploadId)
    const second = fixture.controller.cancelUpload(uploadId)

    expect(fixture.cancelUpload).toHaveBeenCalledOnce()
    expect(fixture.controller.snapshot().records[0]).toMatchObject({
      status: 'cancelling',
      statusLabel: '正在取消',
      cancellable: false,
      cancelPending: true,
    })
    await expect(second).resolves.toBe(false)

    request.resolve(undefined)
    await expect(first).resolves.toBe(true)
    expect(fixture.controller.snapshot().records[0]).toMatchObject({
      status: 'cancelling',
      cancellable: false,
      cancelPending: false,
    })
  })

  it('restores a cancellable record and shows safe feedback when cancellation fails', async () => {
    const fixture = harness(page([historyItem('finalizing')]))
    fixture.cancelUpload.mockRejectedValue(new Error('r2 secret abort failure'))
    await fixture.controller.loadFirstPage()

    await expect(fixture.controller.cancelUpload(uploadId)).resolves.toBe(false)

    expect(fixture.controller.snapshot().records[0]).toMatchObject({
      status: 'finalizing',
      cancellable: true,
      cancelPending: false,
    })
    expect(fixture.controller.snapshot().error).toBe('取消上传失败，请稍后重试')
    expect(JSON.stringify(fixture.controller.snapshot())).not.toMatch(/r2 secret|abort failure/u)
  })

  it('clears only uploaded history and keeps active records visible', async () => {
    const uploaded = historyItem('uploaded')
    const active = historyItem('uploading', {
      id: '01981d0c-ec80-7000-8000-000000000108',
      fileName: 'active.mov',
    })
    const fixture = harness(page([uploaded, active]))
    fixture.list
      .mockResolvedValueOnce(page([uploaded, active]))
      .mockResolvedValueOnce(page([active]))
    await fixture.controller.loadFirstPage()

    await expect(fixture.controller.clearUploadedRecords()).resolves.toBe(1)

    expect(fixture.clearUploaded).toHaveBeenCalledOnce()
    expect(fixture.controller.snapshot()).toMatchObject({
      clearingUploaded: false,
    })
    expect(fixture.controller.snapshot().records.map((record) => record.fileName)).toEqual([
      'active.mov',
    ])
  })

  it('starts a retry only after an explicit user action', async () => {
    const fixture = harness(page([historyItem('upload_failed')]))
    await fixture.controller.loadFirstPage()

    expect(fixture.retry).not.toHaveBeenCalled()
    await expect(fixture.controller.retryUpload(uploadId)).resolves.toBe(true)

    expect(fixture.retry).toHaveBeenCalledOnce()
    expect(fixture.retry).toHaveBeenCalledWith(uploadId, 'summer.jpg', 12)
    expect(fixture.controller.snapshot().records[0]?.retryPending).toBe(false)
  })

  it('soft-deletes one terminal record from the visible list', async () => {
    const fixture = harness(page([historyItem('uploaded')]))
    await fixture.controller.loadFirstPage()

    await expect(fixture.controller.deleteRecord(uploadId)).resolves.toBe(true)

    expect(fixture.deleteRecord).toHaveBeenCalledWith(uploadId, 'summer.jpg', 12)
    expect(fixture.controller.snapshot().records).toEqual([])
  })

  it('temporarily watches for a newly created record after navigation from upload', async () => {
    const list = vi.fn<HistoryApi['list']>().mockResolvedValue(page([]))
    const scheduled: { callback: () => void; delayMs: number }[] = []
    const controller = new HistoryController({
      api: {
        list,
        getUpload: vi.fn(),
        cancel: vi.fn(),
        clearUploaded: vi.fn(),
        retry: vi.fn(),
        deleteRecord: vi.fn(),
      },
      watchForNewUpload: true,
      schedule(callback, delayMs) {
        scheduled.push({ callback, delayMs })
        return scheduled.length
      },
    })

    await controller.loadFirstPage()

    expect(controller.snapshot().records).toEqual([])
    expect(controller.snapshot().watchingForNewUpload).toBe(true)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.delayMs).toBe(5_000)
  })

  it('keeps the short watch active when only older terminal records are initially visible', async () => {
    const scheduled: { callback: () => void; delayMs: number }[] = []
    const controller = new HistoryController({
      api: {
        list: vi.fn().mockResolvedValue(page([historyItem('uploaded')])),
        getUpload: vi.fn(),
        cancel: vi.fn(),
        clearUploaded: vi.fn(),
        retry: vi.fn(),
        deleteRecord: vi.fn(),
      },
      watchForNewUpload: true,
      schedule(callback, delayMs) {
        scheduled.push({ callback, delayMs })
        return scheduled.length
      },
    })

    await controller.loadFirstPage()

    expect(controller.snapshot().watchingForNewUpload).toBe(false)
    expect(scheduled).toHaveLength(1)
    expect(scheduled[0]?.delayMs).toBe(5_000)
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
  it('requires destructive confirmation before forwarding a cancellation', async () => {
    const fixture = harness(page([historyItem('uploading')]))
    await fixture.controller.loadFirstPage()
    const showModal = vi.fn().mockResolvedValue({ confirm: true, cancel: false })
    vi.stubGlobal('wx', { showModal })
    const host = {
      data: fixture.controller.snapshot(),
      historyController: fixture.controller,
      setData(): void {
        // The controller is asserted directly; rendering behavior has separate contract coverage.
      },
    }

    await historyPageDefinition.onCancelUpload.call(host, {
      currentTarget: { dataset: { uploadId } },
    })

    expect(showModal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: '取消上传',
        confirmText: '确认取消',
        cancelText: '继续上传',
      }),
    )
    expect(fixture.cancelUpload).toHaveBeenCalledWith(uploadId)
  })

  it('offers cancellation, manual retry, and history deletion without content access or storage internals', () => {
    const wxml = readFileSync(
      new URL('../miniprogram/pages/history/index.wxml', import.meta.url),
      'utf8',
    )

    expect(wxml).toMatch(/\{\{item\.fileName\}\}/u)
    expect(wxml).toMatch(/\{\{item\.statusLabel\}\}/u)
    expect(wxml).toMatch(/\{\{item\.percent\}\}%/u)
    expect(wxml).toMatch(/bindtap=["']onCancelUpload["']/u)
    expect(wxml).toMatch(/bindtap=["']onClearUploadedHistory["']/u)
    expect(wxml).toMatch(/bindtap=["']onRetryUpload["']/u)
    expect(wxml).toMatch(/bindtap=["']onDeleteRecord["']/u)
    expect(wxml).toMatch(/清空已上传记录/u)
    expect(wxml).not.toMatch(/preview|download|share|objectKey|r2|etag/iu)
  })
})
