import type {
  Pagination,
  UploadDetailResponse,
  UploadHistoryQuery,
  UploadHistoryResponse,
} from '../../generated/contracts.js'

import { statusCopy, type StatusTone } from '../../core/status-copy.js'

const PAGE_SIZE = 20
const HISTORY_REFRESH_INTERVAL_MS = 5_000
const MAX_REFRESH_PAGE_SIZE = 100
const SAFE_HISTORY_ERROR = '上传记录加载失败，请稍后重试'
const SAFE_UPLOAD_FAILURE = '上传失败，请稍后重试'
const SAFE_CANCEL_ERROR = '取消上传失败，请稍后重试'
const SAFE_CLEAR_ERROR = '清空上传记录失败，请稍后重试'
const SAFE_RETRY_ERROR = '无法重新上传，请返回素材页重新选择文件'
const SAFE_DELETE_ERROR = '删除上传记录失败，请稍后重试'
const WATCH_NEW_UPLOAD_REFRESHES = 6

type HistoryItem = UploadHistoryResponse['data']['items'][number]

export interface HistoryPageResult {
  readonly items: readonly HistoryItem[]
  readonly pagination: Pagination
}

export interface HistoryApi {
  list(query: UploadHistoryQuery): Promise<HistoryPageResult>
  getUpload(uploadId: string): Promise<UploadDetailResponse['data']>
  cancel(uploadId: string): Promise<void>
  clearUploaded(): Promise<number>
  retry(uploadId: string, fileName: string, sizeBytes: number): Promise<boolean>
  deleteRecord(uploadId: string, fileName: string, sizeBytes: number): Promise<void>
}

export type HistoryScheduleHandle = unknown
export type HistorySchedule = (callback: () => void, delayMs: number) => HistoryScheduleHandle

export interface HistoryRecordView {
  readonly id: string
  readonly fileName: string
  readonly kindLabel: '图片' | '视频'
  readonly sizeLabel: string
  readonly status: HistoryItem['status']
  readonly statusLabel: string
  readonly tone: StatusTone
  readonly terminal: boolean
  readonly cancellable: boolean
  readonly cancelPending: boolean
  readonly retryable: boolean
  readonly retryPending: boolean
  readonly deletable: boolean
  readonly deletePending: boolean
  readonly percent: number
  readonly createdAtLabel: string
  readonly updatedAtLabel: string
  readonly failureMessage: string | null
}

export interface HistorySnapshot {
  readonly records: readonly HistoryRecordView[]
  readonly loading: boolean
  readonly refreshing: boolean
  readonly loadingMore: boolean
  readonly watchingForNewUpload: boolean
  readonly hasMore: boolean
  readonly clearingUploaded: boolean
  readonly error: string | null
}

interface HistoryControllerOptions {
  readonly api: HistoryApi
  readonly schedule?: HistorySchedule
  readonly cancel?: (handle: HistoryScheduleHandle) => void
  readonly onChange?: (snapshot: HistorySnapshot) => void
  readonly watchForNewUpload?: boolean
}

interface ScheduledRefresh {
  readonly generation: number
  readonly handle: HistoryScheduleHandle
  readonly token: symbol
}

interface ActiveRefresh {
  readonly generation: number
  readonly token: symbol
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB'] as const
  let value = bytes / 1_024
  let index = 0
  while (value >= 1_024 && index < units.length - 1) {
    value /= 1_024
    index += 1
  }
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits).replace(/\.0+$/u, '')} ${units[index] ?? 'GB'}`
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0')
}

function localDateTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '时间未知'
  return `${String(date.getFullYear())}-${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}`
}

function safeFailureMessage(item: HistoryItem): string | null {
  if (item.status !== 'upload_failed' || item.failure === null) return null
  switch (item.failure.code) {
    case 'FILE_TOO_SMALL':
      return '文件内容无效，请重新选择素材'
    case 'MIME_MISMATCH':
      return '文件格式与内容不一致，请重新选择素材'
    case 'STORAGE_OBJECT_SIZE_MISMATCH':
      return '文件完整性校验失败，请重新上传'
    case 'STORAGE_UNAVAILABLE':
      return '服务器暂时无法接收，请稍后手动重试'
    default:
      return SAFE_UPLOAD_FAILURE
  }
}

function recordView(
  item: HistoryItem,
  cancelPending: boolean,
  retryPending: boolean,
  deletePending: boolean,
): HistoryRecordView {
  const presentedStatus =
    cancelPending && (item.status === 'uploading' || item.status === 'finalizing')
      ? 'cancelling'
      : item.status
  const copy = statusCopy(presentedStatus)
  return Object.freeze({
    id: item.id,
    fileName: item.fileName,
    kindLabel: item.kind === 'image' ? '图片' : '视频',
    sizeLabel: formatBytes(item.sizeBytes),
    status: presentedStatus,
    statusLabel: copy.label,
    tone: copy.tone,
    terminal: copy.terminal,
    cancellable: !cancelPending && (item.status === 'uploading' || item.status === 'finalizing'),
    cancelPending,
    retryable:
      !retryPending &&
      (item.status === 'upload_failed' || item.status === 'aborted' || item.status === 'expired'),
    retryPending,
    deletable: copy.terminal && !deletePending,
    deletePending,
    percent: Math.min(100, Math.max(0, item.progress.percent)),
    createdAtLabel: localDateTime(item.createdAt),
    updatedAtLabel: localDateTime(item.updatedAt),
    failureMessage: safeFailureMessage(item),
  })
}

function defaultSchedule(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(callback, delayMs)
}

export class HistoryController {
  readonly #api: HistoryApi
  readonly #schedule: HistorySchedule
  readonly #cancel: (handle: HistoryScheduleHandle) => void
  readonly #onChange: (snapshot: HistorySnapshot) => void
  #refreshTimer: ScheduledRefresh | undefined
  #activeRefresh: ActiveRefresh | undefined
  #items: HistoryItem[] = []
  #loading = false
  #refreshing = false
  #loadingMore = false
  #hasMore = false
  #nextCursor: string | null = null
  #error: string | null = null
  #clearingUploaded = false
  readonly #cancelPendingIds = new Set<string>()
  readonly #retryPendingIds = new Set<string>()
  readonly #deletePendingIds = new Set<string>()
  #watchRefreshesRemaining: number
  #generation = 0
  #paused = false
  #disposed = false

  constructor(options: HistoryControllerOptions) {
    this.#api = options.api
    this.#schedule = options.schedule ?? defaultSchedule
    this.#cancel =
      options.cancel ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>)
      })
    this.#onChange = options.onChange ?? (() => undefined)
    this.#watchRefreshesRemaining = options.watchForNewUpload ? WATCH_NEW_UPLOAD_REFRESHES : 0
  }

  snapshot(): HistorySnapshot {
    return Object.freeze({
      records: Object.freeze(
        this.#items.map((item) =>
          recordView(
            item,
            this.#cancelPendingIds.has(item.id),
            this.#retryPendingIds.has(item.id),
            this.#deletePendingIds.has(item.id),
          ),
        ),
      ),
      loading: this.#loading,
      refreshing: this.#refreshing,
      loadingMore: this.#loadingMore,
      watchingForNewUpload: this.#watchRefreshesRemaining > 0 && this.#items.length === 0,
      hasMore: this.#hasMore,
      clearingUploaded: this.#clearingUploaded,
      error: this.#error,
    })
  }

  async loadFirstPage(refreshing = false): Promise<void> {
    if (this.#loading || this.#refreshing || this.#paused || this.#disposed) return
    const generation = this.#startGeneration()
    this.#loadingMore = false
    this.#loading = !refreshing
    this.#refreshing = refreshing
    this.#error = null
    this.#emit()
    try {
      const result = await this.#api.list({ limit: PAGE_SIZE })
      if (!this.#isActive(generation)) return
      this.#items = result.items.map((item) => ({ ...item }))
      this.#hasMore = result.pagination.hasMore
      this.#nextCursor = result.pagination.nextCursor
      this.#ensureRefreshScheduled(generation)
    } catch {
      if (this.#isActive(generation)) {
        this.#error = SAFE_HISTORY_ERROR
        this.#ensureRefreshScheduled(generation)
      }
    } finally {
      if (this.#isActive(generation)) {
        this.#loading = false
        this.#refreshing = false
        this.#emit()
      }
    }
  }

  async loadNextPage(): Promise<void> {
    if (
      this.#disposed ||
      this.#paused ||
      this.#loading ||
      this.#refreshing ||
      this.#loadingMore ||
      !this.#hasMore ||
      this.#nextCursor === null
    ) {
      return
    }
    const generation = this.#generation
    const cursor = this.#nextCursor
    this.#loadingMore = true
    this.#error = null
    this.#emit()
    try {
      const result = await this.#api.list({ limit: PAGE_SIZE, cursor })
      if (!this.#isActive(generation)) return
      const byId = new Map(this.#items.map((item) => [item.id, item]))
      for (const item of result.items) if (!byId.has(item.id)) byId.set(item.id, { ...item })
      this.#items = [...byId.values()]
      this.#hasMore = result.pagination.hasMore
      this.#nextCursor = result.pagination.nextCursor
      this.#ensureRefreshScheduled(generation)
    } catch {
      if (this.#isActive(generation)) {
        this.#error = SAFE_HISTORY_ERROR
        this.#ensureRefreshScheduled(generation)
      }
    } finally {
      if (this.#isActive(generation)) {
        this.#loadingMore = false
        this.#emit()
      }
    }
  }

  async cancelUpload(uploadId: string): Promise<boolean> {
    if (this.#disposed || this.#paused || this.#cancelPendingIds.has(uploadId)) return false
    const item = this.#items.find((candidate) => candidate.id === uploadId)
    if (item === undefined || (item.status !== 'uploading' && item.status !== 'finalizing')) {
      return false
    }

    this.#cancelPendingIds.add(uploadId)
    this.#error = null
    this.#emit()
    try {
      await this.#api.cancel(uploadId)
      const current = this.#items.find((candidate) => candidate.id === uploadId)
      if (current?.status === 'uploading' || current?.status === 'finalizing') {
        this.#items = this.#items.map((candidate) =>
          candidate.id === uploadId ? { ...candidate, status: 'cancelling' as const } : candidate,
        )
      }
      return true
    } catch {
      this.#error = SAFE_CANCEL_ERROR
      return false
    } finally {
      this.#cancelPendingIds.delete(uploadId)
      this.#ensureRefreshScheduled(this.#generation)
      this.#emit()
    }
  }

  async clearUploadedRecords(): Promise<number | null> {
    if (this.#disposed || this.#paused || this.#clearingUploaded) return null

    this.#clearingUploaded = true
    const generation = this.#generation
    this.#error = null
    this.#emit()
    try {
      const clearedCount = await this.#api.clearUploaded()
      if (!this.#isActive(generation)) return null
      this.#items = this.#items.filter((item) => item.status !== 'uploaded')
      await this.loadFirstPage(true)
      return clearedCount
    } catch {
      if (this.#isActive(generation)) this.#error = SAFE_CLEAR_ERROR
      return null
    } finally {
      this.#clearingUploaded = false
      this.#emit()
    }
  }

  async retryUpload(uploadId: string): Promise<boolean> {
    if (this.#disposed || this.#paused || this.#retryPendingIds.has(uploadId)) return false
    const item = this.#items.find((candidate) => candidate.id === uploadId)
    if (item === undefined || !['upload_failed', 'aborted', 'expired'].includes(item.status)) {
      return false
    }
    this.#retryPendingIds.add(uploadId)
    this.#error = null
    this.#emit()
    try {
      const started = await this.#api.retry(item.id, item.fileName, item.sizeBytes)
      if (!started) this.#error = SAFE_RETRY_ERROR
      return started
    } catch {
      this.#error = SAFE_RETRY_ERROR
      return false
    } finally {
      this.#retryPendingIds.delete(uploadId)
      this.#ensureRefreshScheduled(this.#generation)
      this.#emit()
    }
  }

  async deleteRecord(uploadId: string): Promise<boolean> {
    if (this.#disposed || this.#paused || this.#deletePendingIds.has(uploadId)) return false
    const item = this.#items.find((candidate) => candidate.id === uploadId)
    if (item === undefined || !recordView(item, false, false, false).terminal) return false
    this.#deletePendingIds.add(uploadId)
    this.#error = null
    this.#emit()
    try {
      await this.#api.deleteRecord(uploadId, item.fileName, item.sizeBytes)
      this.#items = this.#items.filter((candidate) => candidate.id !== uploadId)
      return true
    } catch {
      this.#error = SAFE_DELETE_ERROR
      return false
    } finally {
      this.#deletePendingIds.delete(uploadId)
      this.#emit()
    }
  }

  pause(): void {
    if (this.#disposed || this.#paused) return
    this.#paused = true
    this.#invalidateGeneration()
    this.#loading = false
    this.#refreshing = false
    this.#loadingMore = false
  }

  async resume(): Promise<void> {
    if (this.#disposed || !this.#paused) return
    this.#paused = false
    await this.loadFirstPage(this.#items.length > 0)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#cancelPendingIds.clear()
    this.#retryPendingIds.clear()
    this.#deletePendingIds.clear()
    this.#invalidateGeneration()
  }

  async #refreshVisibleRecords(generation: number): Promise<void> {
    if (!this.#isActive(generation) || this.#activeRefresh !== undefined) return
    const token = Symbol('history-refresh')
    this.#activeRefresh = { generation, token }
    try {
      const result = await this.#api.list({
        limit: Math.min(MAX_REFRESH_PAGE_SIZE, Math.max(PAGE_SIZE, this.#items.length)),
      })
      if (!this.#ownsRefresh(generation, token)) return

      const refreshedIds = new Set(result.items.map((item) => item.id))
      this.#items = [
        ...result.items.map((item) => ({ ...item })),
        ...this.#items.filter((item) => !refreshedIds.has(item.id)),
      ]
      this.#error = null
    } catch {
      if (this.#ownsRefresh(generation, token)) this.#error = SAFE_HISTORY_ERROR
    } finally {
      if (this.#ownsRefresh(generation, token)) {
        this.#activeRefresh = undefined
        this.#ensureRefreshScheduled(generation)
        this.#emit()
      }
    }
  }

  #ensureRefreshScheduled(generation: number): void {
    if (!this.#isActive(generation) || !this.#hasRefreshableNonterminalRecord()) return
    if (this.#refreshTimer?.generation === generation) return
    this.#clearRefreshTimer()

    const token = Symbol('history-refresh-timer')
    const handle = this.#schedule(() => {
      const scheduled = this.#refreshTimer
      if (scheduled?.token !== token || scheduled.generation !== generation) return
      this.#refreshTimer = undefined
      if (this.#watchRefreshesRemaining > 0) this.#watchRefreshesRemaining -= 1
      if (this.#isActive(generation)) void this.#refreshVisibleRecords(generation)
    }, HISTORY_REFRESH_INTERVAL_MS)
    this.#refreshTimer = { generation, handle, token }
  }

  #hasRefreshableNonterminalRecord(): boolean {
    return (
      this.#watchRefreshesRemaining > 0 ||
      this.#items
        .slice(0, MAX_REFRESH_PAGE_SIZE)
        .some(
          (item) =>
            item.status === 'uploading' ||
            item.status === 'finalizing' ||
            item.status === 'cancelling',
        )
    )
  }

  #ownsRefresh(generation: number, token: symbol): boolean {
    return (
      this.#isActive(generation) &&
      this.#activeRefresh?.generation === generation &&
      this.#activeRefresh.token === token
    )
  }

  #startGeneration(): number {
    this.#invalidateGeneration()
    return this.#generation
  }

  #invalidateGeneration(): void {
    this.#generation += 1
    this.#clearRefreshTimer()
    this.#activeRefresh = undefined
  }

  #isActive(generation: number): boolean {
    return !this.#disposed && !this.#paused && generation === this.#generation
  }

  #clearRefreshTimer(): void {
    if (this.#refreshTimer === undefined) return
    this.#cancel(this.#refreshTimer.handle)
    this.#refreshTimer = undefined
  }

  #emit(): void {
    if (!this.#disposed) this.#onChange(this.snapshot())
  }
}

interface HistoryApplicationData {
  historyApi?: HistoryApi
}

interface HistoryPageHost {
  data: HistorySnapshot
  setData(data: Partial<HistorySnapshot>): void
  historyController?: HistoryController
}

function applicationData(): HistoryApplicationData {
  if (typeof getApp !== 'function') return {}
  return getApp<{ globalData: HistoryApplicationData }>().globalData
}

function pageController(page: HistoryPageHost): HistoryController {
  page.historyController ??= new HistoryController({
    api:
      applicationData().historyApi ??
      ({
        list: () => Promise.reject(new Error('history unavailable')),
        getUpload: () => Promise.reject(new Error('history unavailable')),
        cancel: () => Promise.reject(new Error('history unavailable')),
        clearUploaded: () => Promise.reject(new Error('history unavailable')),
        retry: () => Promise.reject(new Error('history unavailable')),
        deleteRecord: () => Promise.reject(new Error('history unavailable')),
      } satisfies HistoryApi),
    onChange: (snapshot) => {
      page.setData(snapshot)
    },
  })
  return page.historyController
}

const EMPTY_HISTORY: HistorySnapshot = {
  records: [],
  loading: false,
  refreshing: false,
  loadingMore: false,
  watchingForNewUpload: false,
  hasMore: false,
  clearingUploaded: false,
  error: null,
}

export const historyPageDefinition = {
  data: EMPTY_HISTORY,

  onLoad(this: HistoryPageHost, query: { readonly watch?: string } = {}): void {
    if (query.watch === '1' && this.historyController === undefined) {
      const api = applicationData().historyApi
      if (api !== undefined) {
        this.historyController = new HistoryController({
          api,
          watchForNewUpload: true,
          onChange: (snapshot) => {
            this.setData(snapshot)
          },
        })
      }
    }
    void pageController(this).loadFirstPage()
  },

  onShow(this: HistoryPageHost): void {
    const controller = this.historyController
    if (controller !== undefined) void controller.resume()
  },

  onHide(this: HistoryPageHost): void {
    this.historyController?.pause()
  },

  async onPullDownRefresh(this: HistoryPageHost): Promise<void> {
    await pageController(this).loadFirstPage(true)
    if (typeof wx === 'object' && typeof wx.stopPullDownRefresh === 'function') {
      void wx.stopPullDownRefresh()
    }
  },

  onReachBottom(this: HistoryPageHost): void {
    void pageController(this).loadNextPage()
  },

  async onCancelUpload(
    this: HistoryPageHost,
    event: { readonly currentTarget: { readonly dataset: { readonly uploadId?: unknown } } },
  ): Promise<void> {
    const uploadId = event.currentTarget.dataset.uploadId
    if (typeof uploadId !== 'string' || typeof wx !== 'object') return
    let confirmation: { readonly confirm?: boolean }
    try {
      confirmation = await wx.showModal({
        title: '取消上传',
        content: '取消后，本次未完成的上传内容将被清理。',
        confirmText: '确认取消',
        cancelText: '继续上传',
      })
    } catch {
      return
    }
    if (confirmation.confirm === true) await pageController(this).cancelUpload(uploadId)
  },

  async onClearUploadedHistory(this: HistoryPageHost): Promise<void> {
    if (typeof wx !== 'object') return
    let confirmation: { readonly confirm?: boolean }
    try {
      confirmation = await wx.showModal({
        title: '清空已上传记录',
        content: '只从你的列表中隐藏已上传记录，不删除服务器文件或后台元数据。',
        confirmText: '确认清空',
        cancelText: '保留记录',
      })
    } catch {
      return
    }
    if (confirmation.confirm === true) {
      const clearedCount = await pageController(this).clearUploadedRecords()
      if (clearedCount !== null && typeof wx.showToast === 'function') {
        void wx.showToast({
          title: clearedCount > 0 ? '已清空上传记录' : '没有已上传记录',
          icon: clearedCount > 0 ? 'success' : 'none',
        })
      }
    }
  },

  async onRetryUpload(
    this: HistoryPageHost,
    event: { readonly currentTarget: { readonly dataset: { readonly uploadId?: unknown } } },
  ): Promise<void> {
    const uploadId = event.currentTarget.dataset.uploadId
    if (typeof uploadId !== 'string' || typeof wx !== 'object') return
    const started = await pageController(this).retryUpload(uploadId)
    if (started && typeof wx.showToast === 'function') {
      void wx.showToast({ title: '已重新开始上传', icon: 'success' })
    }
  },

  async onDeleteRecord(
    this: HistoryPageHost,
    event: { readonly currentTarget: { readonly dataset: { readonly uploadId?: unknown } } },
  ): Promise<void> {
    const uploadId = event.currentTarget.dataset.uploadId
    if (typeof uploadId !== 'string' || typeof wx !== 'object') return
    let confirmation: { readonly confirm?: boolean }
    try {
      confirmation = await wx.showModal({
        title: '删除上传记录',
        content: '只从你的列表中隐藏该记录，不删除服务器文件或后台元数据。',
        confirmText: '删除记录',
        cancelText: '保留',
      })
    } catch {
      return
    }
    if (confirmation.confirm === true) await pageController(this).deleteRecord(uploadId)
  },

  onUnload(this: HistoryPageHost): void {
    this.historyController?.dispose()
    delete this.historyController
  },
}

if (typeof Page === 'function') Page(historyPageDefinition)
