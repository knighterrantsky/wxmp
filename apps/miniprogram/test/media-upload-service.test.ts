import { describe, expect, it, vi } from 'vitest'

import {
  MediaUploadService,
  type MediaUploadRunner,
  type MediaUploadRunnerFactory,
  type MediaUploadRunnerListeners,
  type MediaUploadUiEvent,
} from '../miniprogram/services/media-upload-service.js'
import type { ValidatedMedia } from '../miniprogram/core/media-validation.js'
import type { WechatSelectedMedia } from '../miniprogram/runtime/wx-media.js'

function selected(
  sourcePath: string,
  overrides: Partial<WechatSelectedMedia> = {},
): WechatSelectedMedia {
  return {
    sourcePath,
    sizeBytes: 12,
    kind: 'image',
    ...overrides,
  }
}

function validated(sourcePath: string, overrides: Partial<ValidatedMedia> = {}): ValidatedMedia {
  return {
    sourcePath,
    fileName: sourcePath.slice(sourcePath.lastIndexOf('/') + 1),
    sizeBytes: 12,
    kind: 'image',
    mimeType: 'image/jpeg',
    ...overrides,
  }
}

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

function serviceWith(
  runnerFactory: MediaUploadRunnerFactory,
  options: {
    readonly selection?: readonly WechatSelectedMedia[]
    readonly isReadable?: (sourcePath: string) => Promise<boolean>
  } = {},
): MediaUploadService {
  return new MediaUploadService({
    picker: {
      chooseMedia: vi.fn(() => Promise.resolve([...(options.selection ?? [])])),
    },
    source: {
      isReadable: options.isReadable ?? vi.fn(() => Promise.resolve(true)),
    },
    runnerFactory,
  })
}

function uploadedRunner(
  listeners: MediaUploadRunnerListeners,
  run?: MediaUploadRunner['run'],
): MediaUploadRunner {
  const defaultRun: MediaUploadRunner['run'] = vi.fn(() => {
    listeners.onStatus({ status: 'uploading' })
    return Promise.resolve<'uploaded'>('uploaded')
  })
  return {
    run: run ?? defaultRun,
    pause: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve({ action: 'continued' })),
  }
}

describe('MediaUploadService selection', () => {
  it('checks readability sequentially and returns only normalized candidate fields', async () => {
    const selection = [
      selected('wxfile://tmp/photo.jpg'),
      selected('wxfile://tmp/private.mov', {
        sizeBytes: 24,
        kind: 'video',
      }),
    ]
    const order: string[] = []
    let active = 0
    let maximumActive = 0
    const isReadable = vi.fn(async (sourcePath: string) => {
      order.push(sourcePath)
      active += 1
      maximumActive = Math.max(maximumActive, active)
      await Promise.resolve()
      active -= 1
      if (sourcePath.endsWith('.mov')) throw new Error('wxfile://private native detail')
      return true
    })
    const picker = { chooseMedia: vi.fn(() => Promise.resolve(selection)) }
    const service = new MediaUploadService({
      picker,
      source: { isReadable },
      runnerFactory: (listeners) => uploadedRunner(listeners),
    })

    const candidates = await service.chooseMedia()

    expect(candidates).toEqual([
      {
        sourcePath: 'wxfile://tmp/photo.jpg',
        sizeBytes: 12,
        kind: 'image',
        readable: true,
      },
      {
        sourcePath: 'wxfile://tmp/private.mov',
        sizeBytes: 24,
        kind: 'video',
        readable: false,
      },
    ])
    expect(picker.chooseMedia).toHaveBeenCalledOnce()
    expect(order).toEqual(['wxfile://tmp/photo.jpg', 'wxfile://tmp/private.mov'])
    expect(maximumActive).toBe(1)
    expect(Object.keys(candidates[0] ?? {}).sort()).toEqual([
      'kind',
      'readable',
      'sizeBytes',
      'sourcePath',
    ])
  })
})

describe('MediaUploadService batch coordination', () => {
  it('uses UploadQueue to run files sequentially and associates runner events with each source path', async () => {
    const files = [validated('wxfile://tmp/one.jpg'), validated('wxfile://tmp/two.jpg')]
    const gates = [deferred<'uploaded'>(), deferred<'uploaded'>()]
    const order: string[] = []
    let active = 0
    let maximumActive = 0
    const factory = vi.fn<MediaUploadRunnerFactory>((listeners) => {
      const index = order.length
      return uploadedRunner(listeners, async (file) => {
        order.push(file.sourcePath)
        active += 1
        maximumActive = Math.max(maximumActive, active)
        listeners.onStatus({ status: 'initializing' })
        listeners.onProgress({ bytes: 6, percent: 50 })
        const gate = gates[index]
        if (gate === undefined) throw new Error('missing upload gate')
        const result = await gate.promise
        active -= 1
        return result
      })
    })
    const service = serviceWith(factory)
    const events: MediaUploadUiEvent[] = []

    const running = service.start(files, (event) => events.push(event))
    await vi.waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(1)
    })
    expect(order).toEqual(['wxfile://tmp/one.jpg'])
    gates[0]?.resolve('uploaded')
    await vi.waitFor(() => {
      expect(factory).toHaveBeenCalledTimes(2)
    })
    expect(order).toEqual(['wxfile://tmp/one.jpg', 'wxfile://tmp/two.jpg'])
    gates[1]?.resolve('uploaded')
    await running

    expect(maximumActive).toBe(1)
    expect(events).toContainEqual({
      sourcePath: 'wxfile://tmp/one.jpg',
      status: 'uploading',
      bytes: 6,
      percent: 50,
    })
    expect(events).toContainEqual({
      sourcePath: 'wxfile://tmp/two.jpg',
      status: 'uploaded',
      bytes: 12,
      percent: 100,
    })
    expect(
      events.every(
        (event) => Object.keys(event).sort().join(',') === 'bytes,percent,sourcePath,status',
      ),
    ).toBe(true)
  })

  it('keeps at most five finalizing server sessions and leaves later files queued', async () => {
    const files = Array.from({ length: 9 }, (_, index) =>
      validated(`wxfile://tmp/${String(index + 1)}.jpg`),
    )
    const factory = vi.fn<MediaUploadRunnerFactory>((listeners) =>
      uploadedRunner(listeners, () => Promise.resolve('finalizing')),
    )
    const service = serviceWith(factory)
    const events: MediaUploadUiEvent[] = []

    await service.start(files, (event) => events.push(event))

    expect(factory).toHaveBeenCalledTimes(5)
    expect(events.filter((event) => event.status === 'finalizing')).toHaveLength(5)
    expect(events.filter((event) => event.status === 'queued')).toHaveLength(9)
    await expect(service.start(files, (event) => events.push(event))).rejects.toMatchObject({
      code: 'ACTIVE_BATCH',
    })
    expect(factory).toHaveBeenCalledTimes(5)
  })

  it('rejects capacity before queuing and permits a later batch after retained sessions clear', async () => {
    let retainedSessions = 5
    const factory = vi.fn<MediaUploadRunnerFactory>((listeners) => uploadedRunner(listeners))
    const service = new MediaUploadService({
      picker: { chooseMedia: vi.fn(() => Promise.resolve([])) },
      source: { isReadable: vi.fn(() => Promise.resolve(true)) },
      runnerFactory: factory,
      unfinishedServerSessionCount: () => retainedSessions,
    })
    const events: MediaUploadUiEvent[] = []

    await expect(
      service.start([validated('wxfile://tmp/waiting.jpg')], (event) => events.push(event)),
    ).rejects.toMatchObject({ code: 'ACTIVE_BATCH' })

    expect(factory).not.toHaveBeenCalled()
    expect(events).toEqual([])

    retainedSessions = 0
    await expect(
      service.start([validated('wxfile://tmp/replacement.jpg')], (event) => events.push(event)),
    ).resolves.toBeUndefined()
    expect(factory).toHaveBeenCalledOnce()
    expect(events.at(-1)).toMatchObject({ status: 'uploaded' })
  })

  it('releases files that never started when resumable failures fill capacity mid-batch', async () => {
    let retainedSessions = 4
    let runnerNumber = 0
    const factory = vi.fn<MediaUploadRunnerFactory>((listeners) => {
      runnerNumber += 1
      return uploadedRunner(listeners, () => {
        if (runnerNumber === 1) {
          retainedSessions = 5
          return Promise.reject(new Error('retry exhausted'))
        }
        return Promise.resolve('uploaded')
      })
    })
    const service = new MediaUploadService({
      picker: { chooseMedia: vi.fn(() => Promise.resolve([])) },
      source: { isReadable: vi.fn(() => Promise.resolve(true)) },
      runnerFactory: factory,
      unfinishedServerSessionCount: () => retainedSessions,
    })
    const events: MediaUploadUiEvent[] = []

    await expect(
      service.start(
        [validated('wxfile://tmp/failed.jpg'), validated('wxfile://tmp/not-started.jpg')],
        (event) => events.push(event),
      ),
    ).rejects.toMatchObject({ code: 'ACTIVE_BATCH' })
    expect(factory).toHaveBeenCalledOnce()
    expect(events.filter((event) => event.status === 'failed')).toEqual([
      expect.objectContaining({ sourcePath: 'wxfile://tmp/failed.jpg' }),
      expect.objectContaining({ sourcePath: 'wxfile://tmp/not-started.jpg' }),
    ])

    retainedSessions = 0
    await expect(
      service.start([validated('wxfile://tmp/retry.jpg')], () => undefined),
    ).resolves.toBeUndefined()
    expect(factory).toHaveBeenCalledTimes(2)
  })

  it('continues after one runner fails and emits no upstream error text', async () => {
    const files = [validated('wxfile://tmp/one.jpg'), validated('wxfile://tmp/two.jpg')]
    let runnerNumber = 0
    const factory: MediaUploadRunnerFactory = (listeners) => {
      runnerNumber += 1
      const current = runnerNumber
      return uploadedRunner(listeners, () => {
        if (current === 1) {
          return Promise.reject(new Error('bearer-secret r2/object-key raw upstream text'))
        }
        return Promise.resolve('uploaded')
      })
    }
    const service = serviceWith(factory)
    const events: MediaUploadUiEvent[] = []

    await service.start(files, (event) => events.push(event))

    expect(events).toContainEqual({
      sourcePath: 'wxfile://tmp/one.jpg',
      status: 'failed',
      bytes: 0,
      percent: 0,
    })
    expect(events).toContainEqual({
      sourcePath: 'wxfile://tmp/two.jpg',
      status: 'uploaded',
      bytes: 12,
      percent: 100,
    })
    expect(JSON.stringify(events)).not.toMatch(/bearer-secret|object-key|upstream text/u)
  })

  it('pauses only the current runner and resumes it on foreground', async () => {
    const gate = deferred<'uploaded'>()
    let listeners: MediaUploadRunnerListeners | undefined
    const pause = vi.fn(() => {
      listeners?.onStatus({ status: 'paused' })
      return Promise.resolve()
    })
    const resume = vi.fn(() => {
      listeners?.onStatus({ status: 'resuming' })
      return Promise.resolve({ action: 'continued' } as const)
    })
    const factory: MediaUploadRunnerFactory = (nextListeners) => {
      listeners = nextListeners
      return {
        run: vi.fn(() => gate.promise),
        pause,
        resume,
      }
    }
    const service = serviceWith(factory)
    const events: MediaUploadUiEvent[] = []
    const running = service.start([validated('wxfile://tmp/one.jpg')], (event) =>
      events.push(event),
    )
    await vi.waitFor(() => {
      expect(listeners).toBeDefined()
    })

    await service.pause()
    await service.foreground()

    expect(pause).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
    expect(events.map((event) => event.status)).toContain('paused')
    expect(events.map((event) => event.status)).toContain('uploading')

    gate.resolve('uploaded')
    await running
    await expect(service.pause()).resolves.toBeUndefined()
    await expect(service.foreground()).resolves.toBeUndefined()
    expect(pause).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledOnce()
  })

  it('restores finalizing after foreground instead of regressing to uploading', async () => {
    const gate = deferred<'uploaded'>()
    let listeners: MediaUploadRunnerListeners | undefined
    const factory: MediaUploadRunnerFactory = (nextListeners) => {
      listeners = nextListeners
      return {
        run: vi.fn(async () => {
          nextListeners.onStatus({ status: 'finalizing' })
          return await gate.promise
        }),
        pause: vi.fn(() => Promise.resolve()),
        resume: vi.fn(() => Promise.resolve({ action: 'continued' } as const)),
      }
    }
    const service = serviceWith(factory)
    const events: MediaUploadUiEvent[] = []
    const running = service.start([validated('wxfile://tmp/one.jpg')], (event) =>
      events.push(event),
    )
    await vi.waitFor(() => {
      expect(listeners).toBeDefined()
      expect(events.at(-1)?.status).toBe('finalizing')
    })

    await service.pause()
    expect(events.at(-1)?.status).toBe('paused')
    await service.foreground()

    expect(events.at(-1)?.status).toBe('finalizing')
    gate.resolve('uploaded')
    await running
  })

  it('clamps malformed runner progress and ignores late events from a finished runner', async () => {
    let listeners: MediaUploadRunnerListeners | undefined
    const factory: MediaUploadRunnerFactory = (nextListeners) => {
      listeners = nextListeners
      return uploadedRunner(nextListeners, () => {
        nextListeners.onProgress({ bytes: -10, percent: Number.NaN })
        nextListeners.onProgress({ bytes: 6, percent: 50 })
        nextListeners.onProgress({ bytes: 4, percent: 25 })
        nextListeners.onProgress({ bytes: 999, percent: 999 })
        return Promise.resolve('uploaded')
      })
    }
    const service = serviceWith(factory)
    const events: MediaUploadUiEvent[] = []

    await service.start([validated('wxfile://tmp/one.jpg')], (event) => events.push(event))
    const countAfterFinish = events.length
    listeners?.onProgress({ bytes: 1, percent: 1 })

    expect(events).toContainEqual({
      sourcePath: 'wxfile://tmp/one.jpg',
      status: 'uploading',
      bytes: 12,
      percent: 100,
    })
    expect(events).toHaveLength(countAfterFinish)
    expect(
      events.every((event, index) => index === 0 || event.bytes >= (events[index - 1]?.bytes ?? 0)),
    ).toBe(true)
    expect(
      events.every(
        (event, index) => index === 0 || event.percent >= (events[index - 1]?.percent ?? 0),
      ),
    ).toBe(true)
  })
})
