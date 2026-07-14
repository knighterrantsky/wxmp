import { afterEach, describe, expect, it, vi } from 'vitest'

import { UploadWorkerSupervisor } from '../../src/uploads/worker-supervisor.js'

afterEach(() => {
  vi.useRealTimers()
})

describe('UploadWorkerSupervisor', () => {
  it('runs every job single-flight and waits for in-flight work during stop', async () => {
    vi.useFakeTimers()
    let releaseRun!: () => void
    const pending = new Promise<void>((resolve) => {
      releaseRun = resolve
    })
    const run = vi.fn().mockImplementation(() => pending)
    const supervisor = new UploadWorkerSupervisor({
      jobs: [{ name: 'finalizer', intervalMs: 1_000, run }],
      logger: { error: vi.fn() },
    })

    supervisor.start()
    await Promise.resolve()
    expect(run).toHaveBeenCalledOnce()

    await vi.advanceTimersByTimeAsync(10_000)
    expect(run).toHaveBeenCalledOnce()

    let stopped = false
    const stopping = supervisor.stop().then(() => {
      stopped = true
    })
    await Promise.resolve()
    expect(stopped).toBe(false)
    releaseRun()
    await stopping
    expect(stopped).toBe(true)
    expect(run).toHaveBeenCalledOnce()
  })

  it('contains one failed iteration without leaking raw error text', async () => {
    vi.useFakeTimers()
    const error = vi.fn()
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('private object key and upstream response'))
      .mockResolvedValue(undefined)
    const supervisor = new UploadWorkerSupervisor({
      jobs: [{ name: 'aborter', intervalMs: 100, run }],
      logger: { error },
    })

    supervisor.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(run).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()

    expect(run).toHaveBeenCalledTimes(2)
    expect(error).toHaveBeenCalledWith(
      { worker: 'aborter', errorCode: 'WORKER_ITERATION_FAILED' },
      'worker failed',
    )
    expect(JSON.stringify(error.mock.calls)).not.toContain('private object key')
    await supervisor.stop()
  })

  it('aborts the signal passed to in-flight work during stop', async () => {
    let observedSignal: AbortSignal | undefined
    const run = vi.fn((signal: AbortSignal) => {
      observedSignal = signal
      return new Promise<void>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve()
          },
          { once: true },
        )
      })
    })
    const supervisor = new UploadWorkerSupervisor({
      jobs: [{ name: 'reconciler', intervalMs: 1_000, run }],
      logger: { error: vi.fn() },
    })

    supervisor.start()
    await Promise.resolve()
    expect(observedSignal?.aborted).toBe(false)

    await supervisor.stop()

    expect(observedSignal?.aborted).toBe(true)
  })
})
