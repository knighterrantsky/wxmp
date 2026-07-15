import {
  isTerminalUploadStatus,
  transitionUploadStatus,
  type UploadLifecycleStatus,
} from './upload-reducer.js'

export const MAX_QUEUE_ITEMS = 9
export const MAX_UNFINISHED_UPLOADS = 5
export const SAFE_UPLOAD_FAILURE_MESSAGE = '上传失败，请稍后重试'

export type UploadQueueItemStatus = 'queued' | 'uploading' | 'finalizing' | 'uploaded' | 'failed'

export type UploadQueueRunnerResult = 'finalizing' | 'uploaded'

export interface QueueableUpload {
  readonly fileName: string
}

export interface UploadQueueRunner<T extends QueueableUpload> {
  run(file: Readonly<T>): Promise<UploadQueueRunnerResult>
}

export interface UploadQueueRunOptions {
  readonly confirmed: boolean
}

export interface UploadQueueOptions {
  readonly unfinishedServerSessionCount?: (() => number) | undefined
}

export interface UploadQueueItemSnapshot {
  readonly id: string
  readonly fileName: string
  readonly status: UploadQueueItemStatus
  readonly failureMessage: string | null
}

export type UploadQueueInputErrorCode =
  | 'SELECTION_EMPTY'
  | 'SELECTION_LIMIT_EXCEEDED'
  | 'INVALID_QUEUE_ITEM'
  | 'INVALID_CONFIRMATION'
  | 'QUEUE_ITEM_NOT_FOUND'

export class UploadQueueInputError extends Error {
  override readonly name = 'UploadQueueInputError'
  readonly code: UploadQueueInputErrorCode

  constructor(code: UploadQueueInputErrorCode) {
    super(code)
    this.code = code
  }
}

export class UploadQueueBusyError extends Error {
  override readonly name = 'UploadQueueBusyError'

  constructor() {
    super('UPLOAD_QUEUE_BUSY')
  }
}

export class UploadQueueActiveError extends Error {
  override readonly name = 'UploadQueueActiveError'

  constructor() {
    super('UPLOAD_QUEUE_ACTIVE')
  }
}

interface UploadQueueItem<T extends QueueableUpload> {
  readonly id: string
  readonly file: Readonly<T>
  status: UploadLifecycleStatus
  failureMessage: string | null
}

function isQueueableUpload(value: unknown): value is QueueableUpload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'fileName' in value &&
    typeof value.fileName === 'string' &&
    value.fileName.trim() !== ''
  )
}

function validateSelection(files: readonly QueueableUpload[]): void {
  if (files.length === 0) throw new UploadQueueInputError('SELECTION_EMPTY')
  if (files.length > MAX_QUEUE_ITEMS) {
    throw new UploadQueueInputError('SELECTION_LIMIT_EXCEEDED')
  }
  if (!files.every(isQueueableUpload)) throw new UploadQueueInputError('INVALID_QUEUE_ITEM')
}

function publicStatus(status: UploadLifecycleStatus): UploadQueueItemStatus {
  switch (status) {
    case 'queued':
    case 'uploaded':
    case 'failed':
      return status
    case 'initializing':
    case 'uploading':
    case 'paused':
      return 'uploading'
    case 'finalizing':
    case 'cancelling':
      return 'finalizing'
    case 'selected':
      return 'queued'
    case 'cancelled':
    case 'aborted':
    case 'expired':
      return 'failed'
  }
}

function copiedFile<T extends QueueableUpload>(file: T): Readonly<T> {
  return Object.freeze({ ...file })
}

export class UploadQueue<T extends QueueableUpload> {
  readonly #runner: UploadQueueRunner<T>
  readonly #persistedSessionCount: (() => number) | undefined
  #items: UploadQueueItem<T>[] = []
  #running = false
  #batchNumber = 0

  constructor(runner: UploadQueueRunner<T>, options: UploadQueueOptions = {}) {
    this.#runner = runner
    this.#persistedSessionCount = options.unfinishedServerSessionCount
  }

  snapshot(): readonly UploadQueueItemSnapshot[] {
    return Object.freeze(
      this.#items.map((item) =>
        Object.freeze({
          id: item.id,
          fileName: item.file.fileName,
          status: publicStatus(item.status),
          failureMessage: item.failureMessage,
        }),
      ),
    )
  }

  async run(
    files: readonly T[],
    options: UploadQueueRunOptions,
  ): Promise<readonly UploadQueueItemSnapshot[]> {
    validateSelection(files)
    if (typeof options.confirmed !== 'boolean') {
      throw new UploadQueueInputError('INVALID_CONFIRMATION')
    }
    if (this.#running) throw new UploadQueueBusyError()
    if (this.#hasUnfinishedBatch()) throw new UploadQueueActiveError()

    if (!options.confirmed) {
      this.#items = []
      return this.snapshot()
    }

    this.#batchNumber += 1
    const batch = String(this.#batchNumber)
    this.#items = files.map((file, index) => ({
      id: `queue-${batch}-${String(index + 1)}`,
      file: copiedFile(file),
      status: 'queued',
      failureMessage: null,
    }))
    return this.#drain()
  }

  async resume(): Promise<readonly UploadQueueItemSnapshot[]> {
    if (this.#running) throw new UploadQueueBusyError()
    return this.#drain()
  }

  settleFinalizing(itemId: string, result: 'uploaded' | 'failed'): void {
    const item = this.#items.find((candidate) => candidate.id === itemId)
    if (item === undefined) throw new UploadQueueInputError('QUEUE_ITEM_NOT_FOUND')
    item.status = transitionUploadStatus(item.status, result)
    item.failureMessage = result === 'failed' ? SAFE_UPLOAD_FAILURE_MESSAGE : null
  }

  failQueued(): void {
    if (this.#running) throw new UploadQueueBusyError()
    for (const item of this.#items) {
      if (item.status !== 'queued') continue
      item.status = transitionUploadStatus(item.status, 'failed')
      item.failureMessage = SAFE_UPLOAD_FAILURE_MESSAGE
    }
  }

  #hasUnfinishedBatch(): boolean {
    return this.#items.some((item) => !isTerminalUploadStatus(item.status))
  }

  #unfinishedServerSessionCount(): number {
    const visibleCount = this.#items.filter((item) =>
      ['initializing', 'uploading', 'finalizing', 'cancelling'].includes(item.status),
    ).length
    if (this.#persistedSessionCount === undefined) return visibleCount
    try {
      const persistedCount = this.#persistedSessionCount()
      if (!Number.isSafeInteger(persistedCount) || persistedCount < 0) {
        return MAX_UNFINISHED_UPLOADS
      }
      return Math.max(visibleCount, persistedCount)
    } catch {
      return MAX_UNFINISHED_UPLOADS
    }
  }

  async #drain(): Promise<readonly UploadQueueItemSnapshot[]> {
    if (this.#running) throw new UploadQueueBusyError()
    this.#running = true
    try {
      for (;;) {
        if (this.#unfinishedServerSessionCount() >= MAX_UNFINISHED_UPLOADS) break
        const item = this.#items.find((candidate) => candidate.status === 'queued')
        if (item === undefined) break

        item.status = transitionUploadStatus(item.status, 'initializing')
        item.status = transitionUploadStatus(item.status, 'uploading')
        try {
          const result: unknown = await this.#runner.run(item.file)
          if (result !== 'finalizing' && result !== 'uploaded') {
            throw new Error('upload runner returned an invalid result')
          }
          item.status = transitionUploadStatus(item.status, 'finalizing')
          if (result === 'uploaded') {
            item.status = transitionUploadStatus(item.status, 'uploaded')
          }
        } catch {
          item.status = transitionUploadStatus(item.status, 'failed')
          item.failureMessage = SAFE_UPLOAD_FAILURE_MESSAGE
        }
      }
      return this.snapshot()
    } finally {
      this.#running = false
    }
  }
}
