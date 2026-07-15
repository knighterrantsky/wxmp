import { describe, expect, expectTypeOf, it, vi } from 'vitest'

import {
  CompletionController,
  CompletionControllerError,
  type CompletionRunner,
  type CompletionRunnerResult,
  type CompletionRunnerResumeOutcome,
} from '../miniprogram/services/completion-controller.js'
import type { UploadRunner, UploadRunnerFile } from '../miniprogram/services/upload-runner.js'

interface TestFile {
  readonly fileName: string
}

const file: TestFile = { fileName: 'private.jpg' }

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return {
    promise,
    resolve(value) {
      if (resolvePromise === undefined) throw new Error('deferred promise is unavailable')
      resolvePromise(value)
    },
  }
}

interface RunnerHarness {
  readonly runner: CompletionRunner<TestFile>
  readonly run: ReturnType<typeof vi.fn<CompletionRunner<TestFile>['run']>>
  readonly pause: ReturnType<typeof vi.fn<CompletionRunner<TestFile>['pause']>>
  readonly foreground: ReturnType<typeof vi.fn<CompletionRunner<TestFile>['foreground']>>
  readonly resume: ReturnType<typeof vi.fn<CompletionRunner<TestFile>['resume']>>
  setPollAfterSeconds(value: number | null): void
}

function runnerHarness(
  options: {
    readonly run?: CompletionRunner<TestFile>['run']
    readonly resume?: CompletionRunner<TestFile>['resume']
    readonly pause?: CompletionRunner<TestFile>['pause']
    readonly foreground?: CompletionRunner<TestFile>['foreground']
    readonly pollAfterSeconds?: number | null
  } = {},
): RunnerHarness {
  let pollAfterSeconds = options.pollAfterSeconds === undefined ? 2 : options.pollAfterSeconds
  const run = vi.fn<CompletionRunner<TestFile>['run']>(
    options.run ?? (() => Promise.resolve('finalizing')),
  )
  const pause = vi.fn<CompletionRunner<TestFile>['pause']>(
    options.pause ?? (() => Promise.resolve()),
  )
  const foreground = vi.fn<CompletionRunner<TestFile>['foreground']>(
    options.foreground ?? (() => Promise.resolve()),
  )
  const resume = vi.fn<CompletionRunner<TestFile>['resume']>(
    options.resume ?? (() => Promise.resolve({ action: 'completed', result: 'uploaded' })),
  )
  return {
    runner: {
      get pollAfterSeconds() {
        return pollAfterSeconds
      },
      run,
      pause,
      foreground,
      resume,
    },
    run,
    pause,
    foreground,
    resume,
    setPollAfterSeconds(value) {
      pollAfterSeconds = value
    },
  }
}

async function expectControllerError(
  promise: Promise<unknown>,
  code: CompletionControllerError['code'],
): Promise<void> {
  try {
    await promise
    throw new Error('expected completion controller to reject')
  } catch (error) {
    expect(error).toBeInstanceOf(CompletionControllerError)
    expect(error).toMatchObject({ code, message: code })
  }
}

describe('CompletionController finalization cycle', () => {
  it('accepts the production UploadRunner interface without an adapter', () => {
    expectTypeOf<UploadRunner>().toExtend<CompletionRunner<UploadRunnerFile>>()
  })

  it('polls repeated finalizing outcomes at the current 2–30 second server delay until uploaded', async () => {
    let resumeNumber = 0
    const harness = runnerHarness({
      resume: () => {
        resumeNumber += 1
        if (resumeNumber === 1) {
          harness.setPollAfterSeconds(7)
          return Promise.resolve({ action: 'completed', result: 'finalizing' })
        }
        return Promise.resolve({ action: 'completed', result: 'uploaded' })
      },
    })
    const sleep = vi.fn<(delayMs: number) => Promise<void>>(() => Promise.resolve())
    const controller = new CompletionController({ runner: harness.runner, sleep })

    await expect(controller.run(file)).resolves.toBe('uploaded')

    expect(harness.run).toHaveBeenCalledOnce()
    expect(harness.run).toHaveBeenCalledWith(file)
    expect(harness.resume).toHaveBeenCalledTimes(2)
    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([2_000, 7_000])
  })

  it('continues when a poll falls back to uploading, repairs parts, and completes again', async () => {
    let repairCycles = 0
    const outcomes: CompletionRunnerResumeOutcome[] = [
      { action: 'completed', result: 'finalizing' },
      { action: 'completed', result: 'uploaded' },
    ]
    const harness = runnerHarness({
      resume: () => {
        repairCycles += 1
        const outcome = outcomes.shift()
        if (outcome === undefined) return Promise.reject(new Error('unexpected extra repair'))
        return Promise.resolve(outcome)
      },
    })
    const controller = new CompletionController({
      runner: harness.runner,
      sleep: () => Promise.resolve(),
    })

    await expect(controller.run(file)).resolves.toBe('uploaded')

    expect(repairCycles).toBe(2)
    expect(harness.run).toHaveBeenCalledOnce()
  })

  it('retries a transient polling network failure without restarting the upload', async () => {
    let resumeNumber = 0
    const harness = runnerHarness({
      resume: () => {
        resumeNumber += 1
        if (resumeNumber === 1) {
          return Promise.reject(
            Object.assign(new Error('transient private polling failure'), {
              networkError: true,
              privateDetail: 'signed request secret',
            }),
          )
        }
        return Promise.resolve({ action: 'completed', result: 'uploaded' })
      },
    })
    const backoff = vi.fn<(delayMs: number) => Promise<void>>(() => Promise.resolve())
    const controller = new CompletionController({
      runner: harness.runner,
      sleep: () => Promise.resolve(),
      backoff,
      random: () => 0.5,
    })

    await expect(controller.run(file)).resolves.toBe('uploaded')

    expect(harness.run).toHaveBeenCalledOnce()
    expect(harness.resume).toHaveBeenCalledTimes(2)
    expect(backoff).toHaveBeenCalledOnce()
    expect(backoff).toHaveBeenCalledWith(500)
  })

  it('starts a new poll cycle after one retryable resume batch is exhausted', async () => {
    let resumeNumber = 0
    const harness = runnerHarness({
      resume: () => {
        resumeNumber += 1
        if (resumeNumber <= 6) {
          return Promise.reject(
            Object.assign(new Error('temporary private polling failure'), {
              networkError: true,
            }),
          )
        }
        return Promise.resolve({ action: 'completed', result: 'uploaded' })
      },
    })
    const pollSleep = vi.fn<(delayMs: number) => Promise<void>>(() => Promise.resolve())
    const backoff = vi.fn<(delayMs: number) => Promise<void>>(() => Promise.resolve())
    const controller = new CompletionController({
      runner: harness.runner,
      sleep: pollSleep,
      backoff,
      random: () => 0,
    })

    await expect(controller.run(file)).resolves.toBe('uploaded')

    expect(harness.run).toHaveBeenCalledOnce()
    expect(harness.resume).toHaveBeenCalledTimes(7)
    expect(backoff).toHaveBeenCalledTimes(5)
    expect(pollSleep).toHaveBeenCalledTimes(2)
  })

  it('wakes a paused active upload through the underlying runner foreground hook', async () => {
    const runGate = deferred<CompletionRunnerResult>()
    const harness = runnerHarness({ run: () => runGate.promise })
    const controller = new CompletionController({
      runner: harness.runner,
      sleep: () => Promise.resolve(),
    })
    const running = controller.run(file)
    await vi.waitFor(() => {
      expect(harness.run).toHaveBeenCalledOnce()
    })

    await controller.pause()
    const foreground = controller.foreground()

    await expect(foreground).resolves.toBeUndefined()
    expect(harness.pause).toHaveBeenCalledOnce()
    expect(harness.foreground).toHaveBeenCalledOnce()

    runGate.resolve('finalizing')
    await expect(running).resolves.toBe('uploaded')
    await expect(controller.foreground()).resolves.toBeUndefined()
    expect(harness.foreground).toHaveBeenCalledOnce()
  })

  it('does not let a stale foreground operation override a newer pause', async () => {
    const runGate = deferred<CompletionRunnerResult>()
    const firstForeground = deferred<undefined>()
    const harness = runnerHarness({
      run: () => runGate.promise,
      foreground: () => firstForeground.promise,
    })
    const sleep = vi.fn(() => Promise.resolve())
    const controller = new CompletionController({ runner: harness.runner, sleep })
    const running = controller.run(file)
    await vi.waitFor(() => {
      expect(harness.run).toHaveBeenCalledOnce()
    })

    await controller.pause()
    const staleForeground = controller.foreground()
    await vi.waitFor(() => {
      expect(harness.foreground).toHaveBeenCalledOnce()
    })
    await controller.pause()
    firstForeground.resolve(undefined)
    await staleForeground
    runGate.resolve('finalizing')
    await Promise.resolve()
    await Promise.resolve()

    expect(sleep).not.toHaveBeenCalled()
    expect(harness.resume).not.toHaveBeenCalled()

    vi.mocked(harness.foreground).mockResolvedValueOnce(undefined)
    await controller.foreground()
    await expect(running).resolves.toBe('uploaded')
    expect(sleep).toHaveBeenCalledOnce()
    expect(harness.resume).toHaveBeenCalledOnce()
  })

  it('does not foreground the runner from a stale operation waiting on pause', async () => {
    const runGate = deferred<CompletionRunnerResult>()
    const pausing = deferred<undefined>()
    const harness = runnerHarness({
      run: () => runGate.promise,
      pause: () => pausing.promise,
    })
    const controller = new CompletionController({ runner: harness.runner })
    const running = controller.run(file)
    await vi.waitFor(() => {
      expect(harness.run).toHaveBeenCalledOnce()
    })

    const firstPause = controller.pause()
    const staleForeground = controller.foreground()
    const newerPause = controller.pause()
    pausing.resolve(undefined)
    await Promise.all([firstPause, newerPause, staleForeground])

    expect(harness.pause).toHaveBeenCalledOnce()
    expect(harness.foreground).not.toHaveBeenCalled()

    await controller.foreground()
    expect(harness.foreground).toHaveBeenCalledOnce()
    runGate.resolve('uploaded')
    await expect(running).resolves.toBe('uploaded')
  })

  it('does not report an in-flight direct upload success while backgrounded', async () => {
    const runGate = deferred<CompletionRunnerResult>()
    const harness = runnerHarness({ run: () => runGate.promise })
    const controller = new CompletionController({ runner: harness.runner })
    let settled = false
    const running = controller.run(file).finally(() => {
      settled = true
    })
    await vi.waitFor(() => {
      expect(harness.run).toHaveBeenCalledOnce()
    })

    await controller.pause()
    runGate.resolve('uploaded')
    await Promise.resolve()
    await Promise.resolve()

    expect(settled).toBe(false)
    await controller.foreground()
    await expect(running).resolves.toBe('uploaded')
  })

  it('does not report an in-flight runner failure while backgrounded', async () => {
    const failureGate = deferred<undefined>()
    const harness = runnerHarness({
      run: async () => {
        await failureGate.promise
        throw new Error('private runner failure')
      },
    })
    const controller = new CompletionController({ runner: harness.runner })
    let settled = false
    const running = controller.run(file).finally(() => {
      settled = true
    })
    await vi.waitFor(() => {
      expect(harness.run).toHaveBeenCalledOnce()
    })

    await controller.pause()
    failureGate.resolve(undefined)
    const runnerResult: unknown = harness.run.mock.results[0]?.value
    if (!(runnerResult instanceof Promise)) throw new Error('runner call result is unavailable')
    await expect(runnerResult).rejects.toThrow('private runner failure')

    expect(settled).toBe(false)
    await controller.foreground()
    await expectControllerError(running, 'RUNNER_FAILED')
  })

  it('blocks a new resume while backgrounded without cancelling an in-flight polling delay', async () => {
    const delay = deferred<undefined>()
    const harness = runnerHarness()
    const sleep = vi.fn(() => delay.promise)
    const controller = new CompletionController({ runner: harness.runner, sleep })
    const running = controller.run(file)
    await vi.waitFor(() => {
      expect(sleep).toHaveBeenCalledWith(2_000)
    })

    await controller.pause()
    delay.resolve(undefined)
    await Promise.resolve()
    await Promise.resolve()

    expect(harness.pause).toHaveBeenCalledOnce()
    expect(harness.resume).not.toHaveBeenCalled()

    await controller.foreground()
    await expect(running).resolves.toBe('uploaded')
    expect(harness.foreground).toHaveBeenCalledOnce()
    expect(harness.resume).toHaveBeenCalledOnce()
  })

  it('does not cancel an in-flight resume and schedules no next poll before foreground', async () => {
    const inFlightResume = deferred<CompletionRunnerResumeOutcome>()
    let resumeNumber = 0
    const harness = runnerHarness({
      resume: () => {
        resumeNumber += 1
        if (resumeNumber === 1) return inFlightResume.promise
        return Promise.resolve({ action: 'completed', result: 'uploaded' })
      },
    })
    const sleep = vi.fn(() => Promise.resolve())
    const controller = new CompletionController({ runner: harness.runner, sleep })
    const running = controller.run(file)
    await vi.waitFor(() => {
      expect(harness.resume).toHaveBeenCalledOnce()
    })

    await controller.pause()
    inFlightResume.resolve({ action: 'completed', result: 'finalizing' })
    await Promise.resolve()
    await Promise.resolve()

    expect(sleep).toHaveBeenCalledTimes(1)
    expect(harness.resume).toHaveBeenCalledOnce()

    await controller.resume()
    await expect(running).resolves.toBe('uploaded')
    expect(harness.foreground).toHaveBeenCalledOnce()
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(harness.resume).toHaveBeenCalledTimes(2)
  })

  it('does not finish a batch in the background when an in-flight poll reaches uploaded', async () => {
    const inFlightResume = deferred<CompletionRunnerResumeOutcome>()
    const harness = runnerHarness({ resume: () => inFlightResume.promise })
    const controller = new CompletionController({
      runner: harness.runner,
      sleep: () => Promise.resolve(),
    })
    let settled = false
    const running = controller.run(file).finally(() => {
      settled = true
    })
    await vi.waitFor(() => {
      expect(harness.resume).toHaveBeenCalledOnce()
    })

    await controller.pause()
    inFlightResume.resolve({ action: 'completed', result: 'uploaded' })
    for (let index = 0; index < 20; index += 1) await Promise.resolve()

    expect(settled).toBe(false)
    await controller.foreground()
    await expect(running).resolves.toBe('uploaded')
  })
})

describe('CompletionController cold restore', () => {
  it('resumes immediately, then keeps polling a restored finalizing upload until uploaded', async () => {
    const outcomes: CompletionRunnerResumeOutcome[] = [
      { action: 'completed', result: 'finalizing' },
      { action: 'completed', result: 'uploaded' },
    ]
    const harness = runnerHarness({
      resume: () => {
        const outcome = outcomes.shift()
        if (outcome === undefined) return Promise.reject(new Error('unexpected extra resume'))
        return Promise.resolve(outcome)
      },
    })
    const sleep = vi.fn(() => Promise.resolve())
    const controller = new CompletionController({ runner: harness.runner, sleep })

    await expect(controller.restore()).resolves.toBe('uploaded')

    expect(harness.run).not.toHaveBeenCalled()
    expect(harness.resume).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledOnce()
  })

  it('starts another cold-query batch after retry exhaustion without dropping restore state', async () => {
    let resumeNumber = 0
    const harness = runnerHarness({
      resume: () => {
        resumeNumber += 1
        if (resumeNumber <= 6) {
          return Promise.reject(
            Object.assign(new Error('temporary cold restore network failure'), {
              networkError: true,
            }),
          )
        }
        return Promise.resolve({ action: 'completed', result: 'uploaded' })
      },
    })
    const recoverySleep = vi.fn<(delayMs: number) => Promise<void>>(() => Promise.resolve())
    const backoff = vi.fn<(delayMs: number) => Promise<void>>(() => Promise.resolve())
    const controller = new CompletionController({
      runner: harness.runner,
      sleep: recoverySleep,
      backoff,
      random: () => 0,
    })

    await expect(controller.restore()).resolves.toBe('uploaded')

    expect(harness.run).not.toHaveBeenCalled()
    expect(harness.resume).toHaveBeenCalledTimes(7)
    expect(backoff).toHaveBeenCalledTimes(5)
    expect(recoverySleep).toHaveBeenCalledOnce()
    expect(recoverySleep).toHaveBeenCalledWith(5_000)
  })

  it.each([
    ['none', { action: 'none' }],
    ['replace', { action: 'replace' }],
  ] as const)('returns %s explicitly without starting a poll', async (expected, outcome) => {
    const harness = runnerHarness({ resume: () => Promise.resolve(outcome) })
    const sleep = vi.fn(() => Promise.resolve())
    const controller = new CompletionController({ runner: harness.runner, sleep })

    await expect(controller.restore()).resolves.toBe(expected)
    expect(harness.resume).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('CompletionController failure boundaries', () => {
  it.each([null, 1, 31, 2.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects unsafe pollAfterSeconds %s before sleeping',
    async (pollAfterSeconds) => {
      const harness = runnerHarness({ pollAfterSeconds })
      const sleep = vi.fn(() => Promise.resolve())
      const controller = new CompletionController({ runner: harness.runner, sleep })

      await expectControllerError(controller.run(file), 'INVALID_POLL_DELAY')
      expect(sleep).not.toHaveBeenCalled()
      expect(harness.resume).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['none outcome', { action: 'none' }],
    ['replace outcome', { action: 'replace' }],
  ] as const)('fails a live completion cycle safely on a %s', async (_label, outcome) => {
    const harness = runnerHarness({ resume: () => Promise.resolve(outcome) })
    const controller = new CompletionController({
      runner: harness.runner,
      sleep: () => Promise.resolve(),
    })

    await expectControllerError(controller.run(file), 'COMPLETION_INTERRUPTED')
  })

  it('rejects invalid restore outcomes without exposing their raw content', async () => {
    const harness = runnerHarness({
      resume: () =>
        Promise.resolve({ action: 'secret-action', objectKey: 'private/r2/key' } as never),
    })
    const controller = new CompletionController({ runner: harness.runner })
    const promise = controller.restore()

    await expectControllerError(promise, 'INVALID_OUTCOME')
    await expect(promise).rejects.not.toThrow(/secret-action|private\/r2/u)
  })

  it('sanitizes an upstream polling failure', async () => {
    const harness = runnerHarness({
      resume: () => Promise.reject(new Error('wxfile://private bearer-secret upstream response')),
    })
    const controller = new CompletionController({
      runner: harness.runner,
      sleep: () => Promise.resolve(),
    })
    const promise = controller.run(file)

    await expectControllerError(promise, 'RUNNER_FAILED')
    await expect(promise).rejects.not.toThrow(/wxfile|bearer-secret|upstream response/u)
  })
})
