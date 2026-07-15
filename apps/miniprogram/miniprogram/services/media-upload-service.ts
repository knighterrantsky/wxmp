import {
  MAX_UNFINISHED_UPLOADS,
  UploadQueue,
  type UploadQueueRunnerResult,
} from '../core/upload-queue.js'
import type { MediaSelectionCandidate, ValidatedMedia } from '../core/media-validation.js'
import type { WechatMediaRuntime, WechatSelectedMedia } from '../runtime/wx-media.js'

export type MediaUploadUiStatus =
  'queued' | 'uploading' | 'paused' | 'finalizing' | 'uploaded' | 'failed'

export interface MediaUploadUiEvent {
  readonly sourcePath: string
  readonly status: MediaUploadUiStatus
  readonly bytes: number
  readonly percent: number
}

export interface MediaUploadRunnerProgressEvent {
  readonly bytes: number
  readonly percent: number
}

export interface MediaUploadRunnerStatusEvent {
  readonly status: string
}

export interface MediaUploadRunnerListeners {
  readonly onProgress: (event: MediaUploadRunnerProgressEvent) => void
  readonly onStatus: (event: MediaUploadRunnerStatusEvent) => void
}

export interface MediaUploadRunner {
  run(file: Readonly<ValidatedMedia>): Promise<UploadQueueRunnerResult>
  pause(): Promise<void>
  resume(): Promise<unknown>
}

export type MediaUploadRunnerFactory = (listeners: MediaUploadRunnerListeners) => MediaUploadRunner

export interface MediaSourceRuntime {
  isReadable(sourcePath: string): Promise<boolean>
}

export interface MediaUploadServiceOptions {
  readonly picker: Pick<WechatMediaRuntime, 'chooseMedia'>
  readonly source: MediaSourceRuntime
  readonly runnerFactory: MediaUploadRunnerFactory
  readonly unfinishedServerSessionCount?: (() => number) | undefined
}

export type MediaUploadServiceErrorCode = 'ACTIVE_BATCH' | 'PAUSE_FAILED' | 'FOREGROUND_FAILED'

export class MediaUploadServiceError extends Error {
  override readonly name = 'MediaUploadServiceError'
  readonly code: MediaUploadServiceErrorCode

  constructor(code: MediaUploadServiceErrorCode) {
    super(code)
    this.code = code
  }
}

interface ActiveUpload {
  readonly file: Readonly<ValidatedMedia>
  readonly runner: MediaUploadRunner
  active: boolean
  status: MediaUploadUiStatus
  resumeStatus: Exclude<MediaUploadUiStatus, 'paused'>
  bytes: number
  percent: number
  lastEventSignature: string | null
}

function finiteClamped(value: unknown, minimum: number, maximum: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(maximum, Math.max(minimum, value))
}

function publicRunnerStatus(value: unknown): MediaUploadUiStatus | undefined {
  switch (value) {
    case 'initializing':
    case 'uploading':
    case 'resuming':
      return 'uploading'
    case 'paused':
    case 'finalizing':
    case 'uploaded':
    case 'failed':
      return value
    case 'replace-required':
      return 'failed'
    default:
      return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class MediaUploadService {
  readonly #picker: Pick<WechatMediaRuntime, 'chooseMedia'>
  readonly #source: MediaSourceRuntime
  readonly #runnerFactory: MediaUploadRunnerFactory
  readonly #unfinishedServerSessionCount: (() => number) | undefined
  readonly #queue: UploadQueue<ValidatedMedia>
  #active: ActiveUpload | undefined
  #batchListener: ((event: MediaUploadUiEvent) => void) | undefined
  #batchLocked = false

  constructor(options: MediaUploadServiceOptions) {
    this.#picker = options.picker
    this.#source = options.source
    this.#runnerFactory = options.runnerFactory
    this.#unfinishedServerSessionCount = options.unfinishedServerSessionCount
    this.#queue = new UploadQueue(
      {
        run: (file) => this.#runFile(file),
      },
      { unfinishedServerSessionCount: options.unfinishedServerSessionCount },
    )
  }

  async chooseMedia(): Promise<readonly MediaSelectionCandidate[]> {
    const selected = await this.#picker.chooseMedia()
    const candidates: MediaSelectionCandidate[] = []
    for (const file of selected) {
      candidates.push({
        ...this.#candidateFields(file),
        readable: await this.#isReadable(file.sourcePath),
      })
    }
    return candidates
  }

  async start(
    files: readonly ValidatedMedia[],
    onUpdate: (event: MediaUploadUiEvent) => void,
  ): Promise<void> {
    if (this.#batchLocked) throw new MediaUploadServiceError('ACTIVE_BATCH')
    if (this.#serverSessionCapacityReached()) {
      throw new MediaUploadServiceError('ACTIVE_BATCH')
    }
    this.#batchLocked = true
    this.#batchListener = onUpdate
    for (const file of files) {
      this.#emitDirect(file.sourcePath, 'queued', 0, 0)
    }

    try {
      const snapshot = await this.#queue.run(files, { confirmed: true })
      if (
        snapshot.some((item) => item.status === 'queued') &&
        this.#serverSessionCapacityReached()
      ) {
        for (let index = 0; index < snapshot.length; index += 1) {
          if (snapshot[index]?.status !== 'queued') continue
          const file = files[index]
          if (file !== undefined) this.#emitDirect(file.sourcePath, 'failed', 0, 0)
        }
        this.#queue.failQueued()
        throw new MediaUploadServiceError('ACTIVE_BATCH')
      }
      this.#batchLocked = snapshot.some(
        (item) => item.status !== 'uploaded' && item.status !== 'failed',
      )
    } catch (error) {
      this.#batchLocked = false
      throw error
    } finally {
      this.#batchListener = undefined
    }
  }

  #serverSessionCapacityReached(): boolean {
    if (this.#unfinishedServerSessionCount === undefined) return false
    try {
      const count = this.#unfinishedServerSessionCount()
      return !Number.isSafeInteger(count) || count < 0 || count >= MAX_UNFINISHED_UPLOADS
    } catch {
      return true
    }
  }

  async pause(): Promise<void> {
    const active = this.#active
    if (!active?.active) return
    try {
      await active.runner.pause()
      if (this.#active === active) this.#emitStatus(active, 'paused')
    } catch {
      throw new MediaUploadServiceError('PAUSE_FAILED')
    }
  }

  async foreground(): Promise<void> {
    const active = this.#active
    if (!active?.active) return
    let outcome: unknown
    try {
      outcome = await active.runner.resume()
    } catch {
      throw new MediaUploadServiceError('FOREGROUND_FAILED')
    }
    if (this.#active !== active) return

    if (!isRecord(outcome)) throw new MediaUploadServiceError('FOREGROUND_FAILED')
    switch (outcome['action']) {
      case 'continued':
        if (active.status === 'paused') this.#emitStatus(active, active.resumeStatus)
        return
      case 'replace':
        this.#emitStatus(active, 'failed')
        return
      case 'completed': {
        const status = publicRunnerStatus(outcome['result'])
        if (status !== 'finalizing' && status !== 'uploaded') {
          throw new MediaUploadServiceError('FOREGROUND_FAILED')
        }
        this.#emitStatus(active, status)
        return
      }
      case 'none':
        return
      default:
        throw new MediaUploadServiceError('FOREGROUND_FAILED')
    }
  }

  #candidateFields(file: WechatSelectedMedia): Omit<MediaSelectionCandidate, 'readable'> {
    return {
      sourcePath: file.sourcePath,
      sizeBytes: file.sizeBytes,
      kind: file.kind,
    }
  }

  async #isReadable(sourcePath: string): Promise<boolean> {
    try {
      return await this.#source.isReadable(sourcePath)
    } catch {
      return false
    }
  }

  async #runFile(file: Readonly<ValidatedMedia>): Promise<UploadQueueRunnerResult> {
    let runner: MediaUploadRunner
    let active: ActiveUpload | undefined
    this.#emitDirect(file.sourcePath, 'uploading', 0, 0)
    try {
      runner = this.#runnerFactory({
        onProgress: (event) => {
          if (!active?.active) return
          try {
            this.#emitProgress(active, event)
          } catch {
            // Runtime callback data is untrusted and must not interrupt the queue.
          }
        },
        onStatus: (event) => {
          if (!active?.active) return
          try {
            const status = publicRunnerStatus(event.status)
            if (status !== undefined) this.#emitStatus(active, status)
          } catch {
            // Runtime callback data is untrusted and must not interrupt the queue.
          }
        },
      })
      active = {
        file,
        runner,
        active: true,
        status: 'uploading',
        resumeStatus: 'uploading',
        bytes: 0,
        percent: 0,
        lastEventSignature: null,
      }
      this.#active = active
      const result: unknown = await runner.run(file)
      if (result !== 'finalizing' && result !== 'uploaded') {
        throw new Error('invalid upload runner result')
      }
      this.#emitStatus(active, result)
      return result
    } catch (error) {
      if (active === undefined) {
        this.#emitDirect(file.sourcePath, 'failed', 0, 0)
      } else {
        this.#emitStatus(active, 'failed')
      }
      throw error
    } finally {
      if (active !== undefined) {
        active.active = false
        if (this.#active === active) this.#active = undefined
      }
    }
  }

  #emitProgress(active: ActiveUpload, event: MediaUploadRunnerProgressEvent): void {
    const bytes = finiteClamped(event.bytes, 0, active.file.sizeBytes)
    const percent = finiteClamped(event.percent, 0, 100)
    active.bytes = Math.max(active.bytes, bytes ?? active.bytes)
    active.percent = Math.max(active.percent, percent ?? active.percent)
    this.#emitActive(active)
  }

  #emitStatus(active: ActiveUpload, status: MediaUploadUiStatus): void {
    active.status = status
    if (status !== 'paused') active.resumeStatus = status
    if (status === 'finalizing' || status === 'uploaded') {
      active.bytes = active.file.sizeBytes
      active.percent = 100
    }
    this.#emitActive(active)
  }

  #emitActive(active: ActiveUpload): void {
    const signature = `${active.status}:${String(active.bytes)}:${String(active.percent)}`
    if (active.lastEventSignature === signature) return
    active.lastEventSignature = signature
    this.#emitDirect(active.file.sourcePath, active.status, active.bytes, active.percent)
  }

  #emitDirect(
    sourcePath: string,
    status: MediaUploadUiStatus,
    bytes: number,
    percent: number,
  ): void {
    const listener = this.#batchListener
    if (listener === undefined) return
    try {
      listener(Object.freeze({ sourcePath, status, bytes, percent }))
    } catch {
      // A view callback must not cancel or corrupt an upload batch.
    }
  }
}
