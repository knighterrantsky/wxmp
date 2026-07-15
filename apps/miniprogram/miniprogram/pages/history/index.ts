import type {
  Pagination,
  UploadDetailResponse,
  UploadHistoryQuery,
  UploadHistoryResponse,
} from '@wx-upload/contracts'

import { statusCopy, type StatusTone } from '../../core/status-copy.js'

const PAGE_SIZE = 20
const HISTORY_REFRESH_INTERVAL_MS = 5_000
const MAX_REFRESH_PAGE_SIZE = 100
const SAFE_HISTORY_ERROR = '上传记录加载失败，请稍后重试'
const SAFE_UPLOAD_FAILURE = '上传失败，请稍后重试'

type HistoryItem = UploadHistoryResponse['data']['items'][number]

export interface HistoryPageResult {
  readonly items: readonly HistoryItem[]
  readonly pagination: Pagination
}

export interface HistoryApi {
  list(query: UploadHistoryQuery): Promise<HistoryPageResult>
  getUpload(uploadId: string): Promise<UploadDetailResponse['data']>
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
  readonly hasMore: boolean
  readonly error: string | null
}

interface HistoryControllerOptions {
  readonly api: HistoryApi
  readonly schedule?: HistorySchedule
  readonly cancel?: (handle: HistoryScheduleHandle) => void
  readonly onChange?: (snapshot: HistorySnapshot) => void
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

function recordView(item: HistoryItem): HistoryRecordView {
  const copy = statusCopy(item.status)
  return Object.freeze({
    id: item.id,
    fileName: item.fileName,
    kindLabel: item.kind === 'image' ? '图片' : '视频',
    sizeLabel: formatBytes(item.sizeBytes),
    status: item.status,
    statusLabel: copy.label,
    tone: copy.tone,
    terminal: copy.terminal,
    percent: Math.min(100, Math.max(0, item.progress.percent)),
    createdAtLabel: localDateTime(item.createdAt),
    updatedAtLabel: localDateTime(item.updatedAt),
    failureMessage: item.status === 'upload_failed' ? SAFE_UPLOAD_FAILURE : null,
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
  }

  snapshot(): HistorySnapshot {
    return Object.freeze({
      records: Object.freeze(this.#items.map(recordView)),
      loading: this.#loading,
      refreshing: this.#refreshing,
      loadingMore: this.#loadingMore,
      hasMore: this.#hasMore,
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
      if (this.#isActive(generation)) void this.#refreshVisibleRecords(generation)
    }, HISTORY_REFRESH_INTERVAL_MS)
    this.#refreshTimer = { generation, handle, token }
  }

  #hasRefreshableNonterminalRecord(): boolean {
    return this.#items
      .slice(0, MAX_REFRESH_PAGE_SIZE)
      .some((item) => item.status === 'finalizing' || item.status === 'cancelling')
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
  hasMore: false,
  error: null,
}

export const historyPageDefinition = {
  data: EMPTY_HISTORY,

  onLoad(this: HistoryPageHost): void {
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

  onUnload(this: HistoryPageHost): void {
    this.historyController?.dispose()
    delete this.historyController
  },
}

if (typeof Page === 'function') Page(historyPageDefinition)
