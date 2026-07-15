import { describe, expect, it, vi } from 'vitest'

import {
  MAX_UNFINISHED_UPLOADS,
  SAFE_UPLOAD_FAILURE_MESSAGE,
  UploadQueue,
  UploadQueueActiveError,
  UploadQueueBusyError,
  UploadQueueInputError,
  type UploadQueueRunner,
} from '../miniprogram/core/upload-queue.js'

interface TestFile {
  readonly fileName: string
  readonly sourcePath: string
}

function files(count: number, prefix = 'file'): TestFile[] {
  return Array.from({ length: count }, (_, index) => ({
    fileName: `${prefix}-${String(index + 1)}.jpg`,
    sourcePath: `/tmp/${prefix}-${String(index + 1)}.jpg`,
  }))
}

function queueWith(run: UploadQueueRunner<TestFile>['run']): UploadQueue<TestFile> {
  return new UploadQueue({ run })
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
    resolve: (value) => {
      if (resolvePromise === undefined) throw new Error('deferred is not initialized')
      resolvePromise(value)
    },
  }
}

describe('upload queue', () => {
  it('does not call the runner or create queue items when second confirmation is cancelled', async () => {
    const run = vi.fn<UploadQueueRunner<TestFile>['run']>().mockResolvedValue('uploaded')
    const queue = queueWith(run)

    await expect(queue.run(files(3), { confirmed: false })).resolves.toEqual([])

    expect(run).not.toHaveBeenCalled()
    expect(queue.snapshot()).toEqual([])
  })

  it('accepts at most nine items and rejects invalid input before calling the runner', async () => {
    const run = vi.fn<UploadQueueRunner<TestFile>['run']>().mockResolvedValue('uploaded')
    const queue = queueWith(run)

    await expect(queue.run(files(9), { confirmed: true })).resolves.toHaveLength(9)
    expect(run).toHaveBeenCalledTimes(9)

    const invalidQueue = queueWith(run)
    await expect(invalidQueue.run(files(10), { confirmed: true })).rejects.toMatchObject({
      code: 'SELECTION_LIMIT_EXCEEDED',
    })
    await expect(invalidQueue.run([], { confirmed: true })).rejects.toMatchObject({
      code: 'SELECTION_EMPTY',
    })
    await expect(
      invalidQueue.run([{ fileName: '   ', sourcePath: '/tmp/a.jpg' }], { confirmed: true }),
    ).rejects.toMatchObject({ code: 'INVALID_QUEUE_ITEM' })
    expect(run).toHaveBeenCalledTimes(9)
  })

  it('runs exactly one file at a time and preserves selection order', async () => {
    const gates = [deferred<'uploaded'>(), deferred<'uploaded'>(), deferred<'uploaded'>()]
    let concurrent = 0
    let maximumConcurrent = 0
    const order: string[] = []
    const run = vi.fn<UploadQueueRunner<TestFile>['run']>(async (file) => {
      const gate = gates[order.length]
      if (gate === undefined) throw new Error('missing test gate')
      order.push(file.fileName)
      concurrent += 1
      maximumConcurrent = Math.max(maximumConcurrent, concurrent)
      const result = await gate.promise
      concurrent -= 1
      return result
    })
    const queue = queueWith(run)

    const pending = queue.run(files(3), { confirmed: true })
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(1)
    })
    expect(queue.snapshot().map((item) => item.status)).toEqual(['uploading', 'queued', 'queued'])

    gates[0]?.resolve('uploaded')
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(2)
    })
    gates[1]?.resolve('uploaded')
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledTimes(3)
    })
    gates[2]?.resolve('uploaded')
    await pending

    expect(order).toEqual(['file-1.jpg', 'file-2.jpg', 'file-3.jpg'])
    expect(maximumConcurrent).toBe(1)
    expect(queue.snapshot().map((item) => item.status)).toEqual([
      'uploaded',
      'uploaded',
      'uploaded',
    ])
  })

  it('continues a three-file queue after the second file fails and hides private errors', async () => {
    const run = vi
      .fn<UploadQueueRunner<TestFile>['run']>()
      .mockResolvedValueOnce('uploaded')
      .mockRejectedValueOnce(new Error('private upstream object key and token'))
      .mockResolvedValueOnce('uploaded')
    const queue = queueWith(run)

    await queue.run(files(3), { confirmed: true })

    expect(queue.snapshot().map((item) => item.status)).toEqual(['uploaded', 'failed', 'uploaded'])
    expect(queue.snapshot()[1]?.failureMessage).toBe(SAFE_UPLOAD_FAILURE_MESSAGE)
    expect(JSON.stringify(queue.snapshot())).not.toContain('private upstream')
    expect(run).toHaveBeenCalledTimes(3)
  })

  it('keeps finalizing results unfinished and never starts a sixth server session', async () => {
    const run = vi.fn<UploadQueueRunner<TestFile>['run']>().mockResolvedValue('finalizing')
    const queue = queueWith(run)

    await queue.run(files(9), { confirmed: true })

    expect(MAX_UNFINISHED_UPLOADS).toBe(5)
    expect(run).toHaveBeenCalledTimes(5)
    expect(queue.snapshot().map((item) => item.status)).toEqual([
      'finalizing',
      'finalizing',
      'finalizing',
      'finalizing',
      'finalizing',
      'queued',
      'queued',
      'queued',
      'queued',
    ])

    const first = queue.snapshot()[0]
    if (first === undefined) throw new Error('missing first queue item')
    queue.settleFinalizing(first.id, 'uploaded')
    await queue.resume()

    expect(run).toHaveBeenCalledTimes(6)
    expect(queue.snapshot().filter((item) => item.status === 'finalizing')).toHaveLength(5)
    expect(queue.snapshot().filter((item) => item.status === 'queued')).toHaveLength(3)

    await queue.resume()
    expect(run).toHaveBeenCalledTimes(6)
  })

  it('uses the persisted-session count across batches before starting another file', async () => {
    let persistedSessions = MAX_UNFINISHED_UPLOADS - 1
    const run = vi.fn<UploadQueueRunner<TestFile>['run']>(() => {
      persistedSessions += 1
      return Promise.reject(new Error('retry exhaustion leaves a resumable server session'))
    })
    const queue = new UploadQueue(
      { run },
      { unfinishedServerSessionCount: () => persistedSessions },
    )

    await queue.run(files(3), { confirmed: true })

    expect(run).toHaveBeenCalledOnce()
    expect(queue.snapshot().map((item) => item.status)).toEqual(['failed', 'queued', 'queued'])

    persistedSessions -= 1
    await queue.resume()
    expect(run).toHaveBeenCalledTimes(2)
    expect(queue.snapshot().map((item) => item.status)).toEqual(['failed', 'failed', 'queued'])
  })

  it('can safely fail only the files that never started after an external capacity stop', async () => {
    let persistedSessions = MAX_UNFINISHED_UPLOADS - 1
    const run = vi.fn<UploadQueueRunner<TestFile>['run']>(() => {
      persistedSessions += 1
      return Promise.reject(new Error('resumable failure'))
    })
    const queue = new UploadQueue(
      { run },
      { unfinishedServerSessionCount: () => persistedSessions },
    )
    await queue.run(files(3), { confirmed: true })

    queue.failQueued()

    expect(queue.snapshot().map((item) => item.status)).toEqual(['failed', 'failed', 'failed'])
    expect(queue.snapshot().map((item) => item.failureMessage)).toEqual([
      SAFE_UPLOAD_FAILURE_MESSAGE,
      SAFE_UPLOAD_FAILURE_MESSAGE,
      SAFE_UPLOAD_FAILURE_MESSAGE,
    ])
  })

  it('retains an explicit finalizing result and converts invalid runner output to safe failure', async () => {
    const run = vi
      .fn<UploadQueueRunner<TestFile>['run']>()
      .mockResolvedValueOnce('finalizing')
      .mockResolvedValueOnce('unexpected' as 'uploaded')
    const queue = queueWith(run)

    await queue.run(files(2), { confirmed: true })

    expect(queue.snapshot().map((item) => item.status)).toEqual(['finalizing', 'failed'])
    expect(queue.snapshot()[1]?.failureMessage).toBe(SAFE_UPLOAD_FAILURE_MESSAGE)
  })

  it('returns frozen copies so callers cannot alter queue state', async () => {
    const run = vi.fn<UploadQueueRunner<TestFile>['run']>().mockResolvedValue('uploaded')
    const queue = queueWith(run)
    await queue.run(files(1), { confirmed: true })

    const exposed = queue.snapshot()
    const item = exposed[0]
    if (item === undefined) throw new Error('missing queue item')
    expect(Object.isFrozen(exposed)).toBe(true)
    expect(Object.isFrozen(item)).toBe(true)
    expect(Reflect.set(item, 'status', 'failed')).toBe(false)
    expect(Reflect.set(exposed, '0', { ...item, status: 'failed' })).toBe(false)
    expect(queue.snapshot()[0]?.status).toBe('uploaded')
    expect(queue.snapshot()).not.toBe(exposed)
  })

  it('rejects a concurrent duplicate run without disturbing the active batch', async () => {
    const gate = deferred<'uploaded'>()
    const run = vi.fn<UploadQueueRunner<TestFile>['run']>(() => gate.promise)
    const queue = queueWith(run)

    const firstRun = queue.run(files(1, 'first'), { confirmed: true })
    await vi.waitFor(() => {
      expect(run).toHaveBeenCalledOnce()
    })

    await expect(queue.run(files(1, 'duplicate'), { confirmed: true })).rejects.toBeInstanceOf(
      UploadQueueBusyError,
    )
    expect(queue.snapshot()[0]?.fileName).toBe('first-1.jpg')

    gate.resolve('uploaded')
    await firstRun
    expect(run).toHaveBeenCalledOnce()
  })

  it('rejects replacement while a batch is unfinished but permits a new run after settlement', async () => {
    const run = vi.fn<UploadQueueRunner<TestFile>['run']>().mockResolvedValue('finalizing')
    const queue = queueWith(run)

    await queue.run(files(1, 'first'), { confirmed: true })
    await expect(queue.run(files(1, 'replacement'), { confirmed: true })).rejects.toBeInstanceOf(
      UploadQueueActiveError,
    )

    const first = queue.snapshot()[0]
    if (first === undefined) throw new Error('missing first queue item')
    queue.settleFinalizing(first.id, 'uploaded')
    await queue.run(files(1, 'replacement'), { confirmed: true })

    expect(run).toHaveBeenCalledTimes(2)
    expect(queue.snapshot()[0]?.fileName).toBe('replacement-1.jpg')
  })

  it('uses typed input errors without leaking rejected item data', () => {
    const error = new UploadQueueInputError('INVALID_QUEUE_ITEM')
    expect(error).toMatchObject({ name: 'UploadQueueInputError', code: 'INVALID_QUEUE_ITEM' })
    expect(error.message).toBe('INVALID_QUEUE_ITEM')
  })
})
