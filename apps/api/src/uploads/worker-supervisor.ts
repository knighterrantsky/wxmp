export interface UploadWorkerJob {
  readonly name: string
  readonly intervalMs: number
  run(signal: AbortSignal): Promise<unknown>
}

export interface UploadWorkerLogger {
  error(bindings: Record<string, unknown>, message: string): void
}

function waitForNextRun(intervalMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()

  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, intervalMs)

    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class UploadWorkerSupervisor {
  readonly #jobs: readonly UploadWorkerJob[]
  readonly #logger: UploadWorkerLogger
  #controller: AbortController | undefined
  #loops: Promise<void>[] = []

  constructor(input: { jobs: readonly UploadWorkerJob[]; logger: UploadWorkerLogger }) {
    if (input.jobs.length < 1) throw new Error('at least one upload worker job is required')
    for (const job of input.jobs) {
      if (
        job.name.length < 1 ||
        !Number.isSafeInteger(job.intervalMs) ||
        job.intervalMs < 1 ||
        job.intervalMs > 24 * 60 * 60 * 1_000
      ) {
        throw new Error('upload worker job configuration is invalid')
      }
    }
    this.#jobs = [...input.jobs]
    this.#logger = input.logger
  }

  start(): void {
    if (this.#controller !== undefined) return
    const controller = new AbortController()
    this.#controller = controller
    this.#loops = this.#jobs.map((job) => this.#loop(job, controller.signal))
  }

  async stop(): Promise<void> {
    const controller = this.#controller
    if (controller === undefined) return
    controller.abort()
    await Promise.all(this.#loops)
  }

  async #loop(job: UploadWorkerJob, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await job.run(signal)
      } catch {
        this.#logger.error(
          { worker: job.name, errorCode: 'WORKER_ITERATION_FAILED' },
          'worker failed',
        )
      }
      await waitForNextRun(job.intervalMs, signal)
    }
  }
}
