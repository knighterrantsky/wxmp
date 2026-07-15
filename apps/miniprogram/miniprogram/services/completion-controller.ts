import { MAX_UPLOAD_RETRIES, retryWithFullJitter, shouldRetryUploadFailure } from '../core/retry.js'

export type CompletionRunnerResult = 'finalizing' | 'uploaded'

export type CompletionRunnerResumeOutcome =
  | { readonly action: 'none' }
  | { readonly action: 'continued' }
  | { readonly action: 'replace' }
  | { readonly action: 'completed'; readonly result: CompletionRunnerResult }

export interface CompletionRunner<TFile extends { readonly fileName: string }> {
  readonly pollAfterSeconds: number | null
  run(file: Readonly<TFile>): Promise<CompletionRunnerResult>
  pause(): Promise<void>
  foreground(): Promise<void>
  resume(): Promise<CompletionRunnerResumeOutcome>
}

export interface CompletionControllerOptions<TFile extends { readonly fileName: string }> {
  readonly runner: CompletionRunner<TFile>
  readonly sleep?: ((delayMs: number) => Promise<void>) | undefined
  readonly backoff?: ((delayMs: number) => Promise<void>) | undefined
  readonly random?: (() => number) | undefined
  readonly shouldRetry?: ((error: unknown) => boolean) | undefined
}

export type CompletionControllerErrorCode =
  | 'BUSY'
  | 'INVALID_OUTCOME'
  | 'INVALID_POLL_DELAY'
  | 'COMPLETION_INTERRUPTED'
  | 'RUNNER_FAILED'
  | 'POLL_RETRY_EXHAUSTED'
  | 'POLL_DELAY_FAILED'
  | 'PAUSE_FAILED'
  | 'FOREGROUND_FAILED'

export class CompletionControllerError extends Error {
  override readonly name = 'CompletionControllerError'
  readonly code: CompletionControllerErrorCode
  readonly retryable: boolean

  constructor(code: CompletionControllerErrorCode) {
    super(code)
    this.code = code
    this.retryable = code === 'POLL_RETRY_EXHAUSTED'
  }
}

type DecodedResumeOutcome =
  | { readonly action: 'none' }
  | { readonly action: 'continued' }
  | { readonly action: 'replace' }
  | { readonly action: 'completed'; readonly result: CompletionRunnerResult }

const RESTORE_RETRY_DELAY_MS = 5_000

type PollResumeResult =
  { readonly exhausted: true } | { readonly exhausted: false; readonly value: unknown }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeResumeOutcome(value: unknown): DecodedResumeOutcome | undefined {
  if (!isRecord(value)) return undefined
  switch (value['action']) {
    case 'none':
    case 'continued':
    case 'replace':
      return { action: value['action'] }
    case 'completed':
      if (value['result'] === 'finalizing' || value['result'] === 'uploaded') {
        return { action: 'completed', result: value['result'] }
      }
      return undefined
    default:
      return undefined
  }
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs)
  })
}

export class CompletionController<TFile extends { readonly fileName: string }> {
  readonly #runner: CompletionRunner<TFile>
  readonly #sleep: (delayMs: number) => Promise<void>
  readonly #backoff: ((delayMs: number) => Promise<void>) | undefined
  readonly #random: (() => number) | undefined
  readonly #shouldRetry: (error: unknown) => boolean
  #busy = false
  #backgrounded = false
  #pauseGeneration = 0
  #foregroundWaiters = new Set<() => void>()
  #pauseOperation: Promise<void> | undefined

  constructor(options: CompletionControllerOptions<TFile>) {
    this.#runner = options.runner
    this.#sleep = options.sleep ?? defaultSleep
    this.#backoff = options.backoff
    this.#random = options.random
    this.#shouldRetry = options.shouldRetry ?? shouldRetryUploadFailure
  }

  async run(file: Readonly<TFile>): Promise<'uploaded'> {
    this.#begin()
    try {
      let result: unknown
      try {
        result = await this.#runner.run(file)
      } catch {
        throw new CompletionControllerError('RUNNER_FAILED')
      }
      if (result === 'uploaded') {
        await this.#waitUntilForeground()
        return 'uploaded'
      }
      if (result !== 'finalizing') throw new CompletionControllerError('INVALID_OUTCOME')
      return await this.#pollLiveCycle()
    } catch (error) {
      await this.#waitUntilForeground()
      throw error
    } finally {
      this.#busy = false
    }
  }

  async restore(): Promise<'none' | 'uploaded' | 'replace'> {
    this.#begin()
    try {
      const outcome = decodeResumeOutcome(await this.#resumeInitialRestore())
      if (outcome === undefined || outcome.action === 'continued') {
        throw new CompletionControllerError('INVALID_OUTCOME')
      }
      if (outcome.action === 'none' || outcome.action === 'replace') return outcome.action
      if (outcome.result === 'uploaded') return 'uploaded'
      return await this.#pollRestoreCycle()
    } finally {
      this.#busy = false
    }
  }

  pause(): Promise<void> {
    this.#pauseGeneration += 1
    this.#backgrounded = true
    if (!this.#busy) return Promise.resolve()
    if (this.#pauseOperation !== undefined) return this.#pauseOperation

    const operation = (async () => {
      try {
        await this.#runner.pause()
      } catch {
        throw new CompletionControllerError('PAUSE_FAILED')
      }
    })()
    this.#pauseOperation = operation
    void operation
      .finally(() => {
        if (this.#pauseOperation === operation) this.#pauseOperation = undefined
      })
      .catch(() => undefined)
    return operation
  }

  async foreground(): Promise<void> {
    const pauseGeneration = this.#pauseGeneration
    const pauseOperation = this.#pauseOperation
    if (pauseOperation !== undefined) await pauseOperation
    if (this.#pauseGeneration !== pauseGeneration) return
    if (this.#busy) {
      try {
        await this.#runner.foreground()
      } catch {
        throw new CompletionControllerError('FOREGROUND_FAILED')
      }
    }
    if (this.#pauseGeneration !== pauseGeneration) return
    this.#backgrounded = false
    const waiters = [...this.#foregroundWaiters]
    this.#foregroundWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  async resume(): Promise<{ readonly action: 'continued' }> {
    await this.foreground()
    return Object.freeze({ action: 'continued' })
  }

  #begin(): void {
    if (this.#busy) throw new CompletionControllerError('BUSY')
    this.#busy = true
  }

  async #pollLiveCycle(): Promise<'uploaded'> {
    for (;;) {
      await this.#waitUntilForeground()
      await this.#pollDelay()
      await this.#waitUntilForeground()
      const resumed = await this.#resumePollCycle()
      if (resumed.exhausted) continue
      const outcome = decodeResumeOutcome(resumed.value)
      if (outcome === undefined || outcome.action === 'continued') {
        throw new CompletionControllerError('INVALID_OUTCOME')
      }
      if (outcome.action === 'none' || outcome.action === 'replace') {
        throw new CompletionControllerError('COMPLETION_INTERRUPTED')
      }
      if (outcome.result === 'uploaded') return 'uploaded'
    }
  }

  async #pollRestoreCycle(): Promise<'none' | 'uploaded' | 'replace'> {
    for (;;) {
      await this.#waitUntilForeground()
      await this.#pollDelay()
      await this.#waitUntilForeground()
      const resumed = await this.#resumePollCycle()
      if (resumed.exhausted) continue
      const outcome = decodeResumeOutcome(resumed.value)
      if (outcome === undefined || outcome.action === 'continued') {
        throw new CompletionControllerError('INVALID_OUTCOME')
      }
      if (outcome.action === 'none' || outcome.action === 'replace') return outcome.action
      if (outcome.result === 'uploaded') return 'uploaded'
    }
  }

  async #pollDelay(): Promise<void> {
    let pollAfterSeconds: unknown
    try {
      pollAfterSeconds = this.#runner.pollAfterSeconds
    } catch {
      throw new CompletionControllerError('INVALID_POLL_DELAY')
    }
    if (
      typeof pollAfterSeconds !== 'number' ||
      !Number.isSafeInteger(pollAfterSeconds) ||
      pollAfterSeconds < 2 ||
      pollAfterSeconds > 30
    ) {
      throw new CompletionControllerError('INVALID_POLL_DELAY')
    }
    try {
      await this.#sleep(pollAfterSeconds * 1_000)
    } catch {
      throw new CompletionControllerError('POLL_DELAY_FAILED')
    }
  }

  async #resumeWithRetries(): Promise<unknown> {
    let attempts = 0
    try {
      return await retryWithFullJitter(
        async () => {
          await this.#waitUntilForeground()
          attempts += 1
          return await this.#runner.resume()
        },
        {
          sleep: this.#backoff,
          random: this.#random,
          shouldRetry: (error) => this.#safelyShouldRetry(error),
        },
      )
    } catch (error) {
      if (attempts === MAX_UPLOAD_RETRIES + 1 && this.#safelyShouldRetry(error)) {
        throw new CompletionControllerError('POLL_RETRY_EXHAUSTED')
      }
      throw new CompletionControllerError('RUNNER_FAILED')
    }
  }

  async #resumePollCycle(): Promise<PollResumeResult> {
    try {
      const value = await this.#resumeWithRetries()
      await this.#waitUntilForeground()
      return { exhausted: false, value }
    } catch (error) {
      if (error instanceof CompletionControllerError && error.code === 'POLL_RETRY_EXHAUSTED') {
        return { exhausted: true }
      }
      throw error
    }
  }

  async #resumeInitialRestore(): Promise<unknown> {
    for (;;) {
      try {
        const value = await this.#resumeWithRetries()
        await this.#waitUntilForeground()
        return value
      } catch (error) {
        if (
          !(error instanceof CompletionControllerError) ||
          error.code !== 'POLL_RETRY_EXHAUSTED'
        ) {
          throw error
        }
      }
      await this.#waitUntilForeground()
      try {
        await this.#sleep(RESTORE_RETRY_DELAY_MS)
      } catch {
        throw new CompletionControllerError('POLL_DELAY_FAILED')
      }
      await this.#waitUntilForeground()
    }
  }

  #safelyShouldRetry(error: unknown): boolean {
    try {
      return this.#shouldRetry(error)
    } catch {
      return false
    }
  }

  async #waitUntilForeground(): Promise<void> {
    while (this.#backgrounded) {
      await new Promise<void>((resolve) => {
        this.#foregroundWaiters.add(resolve)
      })
    }
  }
}
