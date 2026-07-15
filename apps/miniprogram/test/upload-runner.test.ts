/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unused-vars, @typescript-eslint/require-await, @typescript-eslint/unbound-method -- Vitest's mutable mock call records intentionally expose partial and deferred test values. */
import {
  PART_SIZE_BYTES,
  planUploadParts,
  type AbortUploadResponse,
  type CompleteUploadResponse,
  type InitializeUploadRequest,
  type InitializeUploadResponse,
  type UploadDetailResponse,
  type UploadPartPlan,
  type UploadPartResponse,
} from '@wx-upload/contracts'
import { describe, expect, it, vi } from 'vitest'

import {
  UploadRunner,
  UploadRunnerBusyError,
  type UploadPartTransport,
  type UploadResumeStore,
  type UploadRunnerApi,
  type UploadRunnerFile,
  type UploadRunnerResumeMetadata,
} from '../miniprogram/services/upload-runner.js'

const uploadId = '0190b397-fa7b-7607-8809-0a0b0c0d0e0f'
const mediaId = '0190b397-fa7b-7607-8809-0a0b0c0d0e10'
const initializeKey = '0190b397-fa7b-7607-8809-0a0b0c0d0e11'
const completeKey = '0190b397-fa7b-7607-8809-0a0b0c0d0e12'
const abortKey = '0190b397-fa7b-7607-8809-0a0b0c0d0e13'
const now = '2026-07-15T00:00:00.000Z'
const later = '2026-07-16T00:00:00.000Z'

const hashFor = (partNumber: number) => partNumber.toString(16).padStart(64, '0')

const file = (sizeBytes = PART_SIZE_BYTES * 3 + 12): UploadRunnerFile => ({
  sourcePath: 'wxfile://tmp/private-source.mov',
  fileName: 'private-source.mov',
  sizeBytes,
  kind: 'video',
  mimeType: 'video/quicktime',
})

function initializeData(input: UploadRunnerFile): InitializeUploadResponse['data'] {
  const parts = planUploadParts(input.sizeBytes)
  return {
    upload: {
      id: uploadId,
      mediaId,
      status: 'uploading',
      fileName: input.fileName,
      kind: input.kind,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      partSizeBytes: PART_SIZE_BYTES,
      partCount: parts.length,
      expiresAt: later,
      createdAt: now,
    },
    parts: parts.map((part) => ({ ...part, status: 'pending' })),
  } as InitializeUploadResponse['data']
}

function partResult(
  part: UploadPartPlan,
  totalBytes: number,
  confirmedBytes: number,
): UploadPartResponse['data'] {
  return {
    part: {
      partNumber: part.partNumber,
      sizeBytes: part.sizeBytes,
      sha256: hashFor(part.partNumber),
      status: 'uploaded',
      uploadedAt: now,
    },
    progress: {
      confirmedBytes,
      totalBytes,
      uploadedParts: Math.min(part.partNumber, Math.ceil(totalBytes / PART_SIZE_BYTES)),
      totalParts: Math.ceil(totalBytes / PART_SIZE_BYTES),
      percent: (confirmedBytes / totalBytes) * 100,
    },
    replayed: false,
  }
}

function detailData(
  input: UploadRunnerFile,
  statuses: Readonly<Record<number, 'pending' | 'uploaded' | 'verified'>>,
  confirmedBytes: number,
  status: UploadDetailResponse['data']['upload']['status'] = 'uploading',
): UploadDetailResponse['data'] {
  const parts = planUploadParts(input.sizeBytes)
  return {
    upload: {
      id: uploadId,
      mediaId,
      status,
      fileName: input.fileName,
      kind: input.kind,
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      progress: {
        confirmedBytes,
        totalBytes: input.sizeBytes,
        uploadedParts: Object.values(statuses).filter((value) => value !== 'pending').length,
        totalParts: parts.length,
        percent: (confirmedBytes / input.sizeBytes) * 100,
      },
      expiresAt: later,
      failure: null,
      createdAt: now,
      updatedAt: now,
    },
    partDetailsRetained: true,
    partsAvailableUntil: null,
    parts: parts.map((part) => {
      const partStatus = statuses[part.partNumber] ?? 'pending'
      return {
        ...part,
        status: partStatus,
        sha256: partStatus === 'pending' ? null : hashFor(part.partNumber),
      }
    }),
    pollAfterSeconds: status === 'uploading' || status === 'finalizing' ? 2 : null,
  } as UploadDetailResponse['data']
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function memoryStore(initial?: unknown) {
  let current = initial
  const saves: UploadRunnerResumeMetadata[] = []
  const store: UploadResumeStore = {
    load: vi.fn(() => current),
    save: vi.fn((value) => {
      const copy = JSON.parse(JSON.stringify(value)) as UploadRunnerResumeMetadata
      saves.push(copy)
      current = copy
    }),
    clear: vi.fn(() => {
      current = undefined
    }),
  }
  return { store, saves, current: () => current }
}

function chunkHarness() {
  return {
    create: vi.fn(async (_sourcePath: string, part: UploadPartPlan) => ({
      partNumber: part.partNumber,
      sizeBytes: part.sizeBytes,
      sha256: hashFor(part.partNumber),
      tempPath: `wxfile://usr/private-${String(part.partNumber)}.part`,
    })),
    delete: vi.fn(async () => undefined),
  }
}

function completeData(status: 'finalizing' | 'uploaded' = 'finalizing') {
  if (status === 'uploaded') return { upload: { id: uploadId, status } } as const
  return {
    upload: {
      id: uploadId,
      status,
      progress: { confirmedBytes: 1, totalBytes: 1, percent: 100 },
    },
    pollAfterSeconds: 2,
  } satisfies CompleteUploadResponse['data']
}

function abortData(): AbortUploadResponse['data'] {
  return { upload: { id: uploadId, status: 'cancelling' }, pollAfterSeconds: 2 }
}

function apiHarness(input: UploadRunnerFile) {
  const api: UploadRunnerApi = {
    initializeUpload: vi.fn(async (_request: InitializeUploadRequest, _key: string) =>
      initializeData(input),
    ),
    getUpload: vi.fn(async () => detailData(input, {}, 0)),
    completeUpload: vi.fn(async () => completeData()),
    abortUpload: vi.fn(async () => abortData()),
  }
  return api
}

function keys() {
  const values = [initializeKey, completeKey, abortKey]
  return vi.fn(() => {
    const value = values.shift()
    if (value === undefined) throw new Error('test ran out of idempotency keys')
    return value
  })
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('UploadRunner scheduling and retry', () => {
  it('uploads part 1 alone, then keeps at most two later parts in flight', async () => {
    const selected = file()
    const parts = planUploadParts(selected.sizeBytes)
    const api = apiHarness(selected)
    const chunks = chunkHarness()
    const store = memoryStore()
    const waiting = new Map<number, ReturnType<typeof deferred<UploadPartResponse['data']>>>()
    const starts: number[] = []
    let active = 0
    let maximumActive = 0
    const transport: UploadPartTransport = {
      uploadPart: vi.fn(async (request) => {
        starts.push(request.partNumber)
        active += 1
        maximumActive = Math.max(maximumActive, active)
        try {
          if (request.partNumber === 1)
            return partResult(parts[0]!, selected.sizeBytes, parts[0]!.sizeBytes)
          const pending = deferred<UploadPartResponse['data']>()
          waiting.set(request.partNumber, pending)
          return await pending.promise
        } finally {
          active -= 1
        }
      }),
    }
    const runner = new UploadRunner({
      api,
      transport,
      chunks,
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: keys(),
    })

    const running = runner.run(selected)
    await vi.waitFor(() => {
      expect(starts).toEqual([1, 2, 3])
    })
    expect(maximumActive).toBe(2)
    waiting
      .get(2)
      ?.resolve(
        partResult(parts[1]!, selected.sizeBytes, parts[0]!.sizeBytes + parts[1]!.sizeBytes),
      )
    await vi.waitFor(() => {
      expect(starts).toEqual([1, 2, 3, 4])
    })
    waiting
      .get(3)
      ?.resolve(partResult(parts[2]!, selected.sizeBytes, selected.sizeBytes - parts[3]!.sizeBytes))
    waiting.get(4)?.resolve(partResult(parts[3]!, selected.sizeBytes, selected.sizeBytes))

    await expect(running).resolves.toBe('finalizing')
    expect(runner.pollAfterSeconds).toBe(2)
    expect(maximumActive).toBe(2)
    expect(chunks.delete).toHaveBeenCalledTimes(4)
    expect(api.completeUpload).toHaveBeenCalledWith(uploadId, completeKey)
    expect(store.store.clear).not.toHaveBeenCalled()
    expect(store.current()).toMatchObject({
      phase: 'finalizing',
      uploadId,
      completeIdempotencyKey: completeKey,
    })
  })

  it('never schedules part 2 when first-part validation fails and still deletes its temp file', async () => {
    const selected = file(PART_SIZE_BYTES + 12)
    const api = apiHarness(selected)
    const chunks = chunkHarness()
    const failure = Object.assign(new Error('first-part validation failed'), {
      statusCode: 415,
      retryable: false,
    })
    const transport: UploadPartTransport = {
      uploadPart: vi.fn(async () => Promise.reject(failure)),
    }
    const runner = new UploadRunner({
      api,
      transport,
      chunks,
      source: { isReadable: vi.fn(async () => true) },
      store: memoryStore().store,
      createIdempotencyKey: keys(),
    })

    await expect(runner.run(selected)).rejects.toBe(failure)
    expect(transport.uploadPart).toHaveBeenCalledOnce()
    expect(chunks.create).toHaveBeenCalledOnce()
    expect(chunks.delete).toHaveBeenCalledOnce()
    expect(api.completeUpload).not.toHaveBeenCalled()
  })

  it('makes one initial request plus at most five documented network retries', async () => {
    const selected = file(12)
    const api = apiHarness(selected)
    const chunks = chunkHarness()
    const failure = Object.assign(new Error('network failed'), { networkError: true })
    const sleep = vi.fn(async () => undefined)
    const transport: UploadPartTransport = {
      uploadPart: vi.fn(async () => Promise.reject(failure)),
    }
    const runner = new UploadRunner({
      api,
      transport,
      chunks,
      source: { isReadable: vi.fn(async () => true) },
      store: memoryStore().store,
      createIdempotencyKey: keys(),
      sleep,
      random: () => 0,
    })

    await expect(runner.run(selected)).rejects.toBe(failure)
    expect(transport.uploadPart).toHaveBeenCalledTimes(6)
    expect(sleep).toHaveBeenCalledTimes(5)
    expect(chunks.create).toHaveBeenCalledOnce()
    expect(chunks.delete).toHaveBeenCalledOnce()
  })

  it('recreates a chunk after PART_CHECKSUM_MISMATCH but not for ordinary retries', async () => {
    const selected = file(12)
    const part = planUploadParts(selected.sizeBytes)[0]!
    const api = apiHarness(selected)
    const chunks = chunkHarness()
    const firstChunk = {
      partNumber: 1,
      sizeBytes: part.sizeBytes,
      sha256: 'a'.repeat(64),
      tempPath: 'wxfile://usr/private-checksum-first.part',
    }
    const refreshedChunk = {
      ...firstChunk,
      sha256: 'b'.repeat(64),
      tempPath: 'wxfile://usr/private-checksum-refreshed.part',
    }
    chunks.create.mockResolvedValueOnce(firstChunk).mockResolvedValueOnce(refreshedChunk)
    const checksumMismatch = Object.assign(new Error('private checksum mismatch'), {
      code: 'PART_CHECKSUM_MISMATCH',
      statusCode: 422,
      retryable: true,
    })
    const refreshedResult = partResult(part, selected.sizeBytes, selected.sizeBytes)
    const uploadPart = vi
      .fn<UploadPartTransport['uploadPart']>()
      .mockRejectedValueOnce(checksumMismatch)
      .mockResolvedValueOnce({
        ...refreshedResult,
        part: { ...refreshedResult.part, sha256: refreshedChunk.sha256 },
      })
    const sleep = vi.fn(async () => undefined)
    const runner = new UploadRunner({
      api,
      transport: { uploadPart },
      chunks,
      source: { isReadable: vi.fn(async () => true) },
      store: memoryStore().store,
      createIdempotencyKey: keys(),
      sleep,
      random: () => 0,
    })

    await expect(runner.run(selected)).resolves.toBe('finalizing')
    expect(chunks.create).toHaveBeenCalledTimes(2)
    expect(uploadPart).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        sha256: firstChunk.sha256,
        tempPath: firstChunk.tempPath,
      }),
    )
    expect(uploadPart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sha256: refreshedChunk.sha256,
        tempPath: refreshedChunk.tempPath,
      }),
    )
    expect(chunks.delete).toHaveBeenNthCalledWith(1, firstChunk)
    expect(chunks.delete).toHaveBeenNthCalledWith(2, refreshedChunk)
    expect(sleep).toHaveBeenCalledOnce()
  })

  it('retries initialization with the original request and idempotency key', async () => {
    const selected = file(12)
    const api = apiHarness(selected)
    const failure = Object.assign(new Error('network failed'), { networkError: true })
    api.initializeUpload = vi
      .fn<UploadRunnerApi['initializeUpload']>()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(initializeData(selected))
    const part = planUploadParts(selected.sizeBytes)[0]!
    const transport: UploadPartTransport = {
      uploadPart: vi.fn(async () => partResult(part, selected.sizeBytes, selected.sizeBytes)),
    }
    const sleep = vi.fn(async () => undefined)
    const runner = new UploadRunner({
      api,
      transport,
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: memoryStore().store,
      createIdempotencyKey: keys(),
      sleep,
      random: () => 0,
    })

    await expect(runner.run(selected)).resolves.toBe('finalizing')
    expect(api.initializeUpload).toHaveBeenCalledTimes(3)
    for (const call of vi.mocked(api.initializeUpload).mock.calls) {
      expect(call).toEqual([
        {
          fileName: selected.fileName,
          kind: selected.kind,
          mimeType: selected.mimeType,
          sizeBytes: selected.sizeBytes,
        },
        initializeKey,
      ])
    }
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('bounds initialization retries and preserves resumable metadata after exhaustion', async () => {
    const selected = file(12)
    const api = apiHarness(selected)
    const failure = Object.assign(new Error('network failed'), { networkError: true })
    api.initializeUpload = vi.fn<UploadRunnerApi['initializeUpload']>().mockRejectedValue(failure)
    const store = memoryStore()
    const sleep = vi.fn(async () => undefined)
    const runner = new UploadRunner({
      api,
      transport: { uploadPart: vi.fn() },
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: keys(),
      sleep,
      random: () => 0,
    })

    await expect(runner.run(selected)).rejects.toBe(failure)
    expect(api.initializeUpload).toHaveBeenCalledTimes(6)
    expect(sleep).toHaveBeenCalledTimes(5)
    expect(store.store.clear).not.toHaveBeenCalled()
    expect(store.current()).toMatchObject({
      phase: 'initializing',
      initializeIdempotencyKey: initializeKey,
      uploadId: null,
      completeIdempotencyKey: null,
    })
  })

  it('retries completion with one key without re-uploading the confirmed part', async () => {
    const selected = file(12)
    const api = apiHarness(selected)
    const failure = Object.assign(new Error('network failed'), { networkError: true })
    api.completeUpload = vi
      .fn<UploadRunnerApi['completeUpload']>()
      .mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(completeData())
    const part = planUploadParts(selected.sizeBytes)[0]!
    const transport: UploadPartTransport = {
      uploadPart: vi.fn(async () => partResult(part, selected.sizeBytes, selected.sizeBytes)),
    }
    const sleep = vi.fn(async () => undefined)
    const runner = new UploadRunner({
      api,
      transport,
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: memoryStore().store,
      createIdempotencyKey: keys(),
      sleep,
      random: () => 0,
    })

    await expect(runner.run(selected)).resolves.toBe('finalizing')
    expect(api.completeUpload).toHaveBeenCalledTimes(3)
    expect(api.completeUpload).toHaveBeenNthCalledWith(1, uploadId, completeKey)
    expect(api.completeUpload).toHaveBeenNthCalledWith(2, uploadId, completeKey)
    expect(api.completeUpload).toHaveBeenNthCalledWith(3, uploadId, completeKey)
    expect(transport.uploadPart).toHaveBeenCalledOnce()
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('bounds completion retries and keeps its key and confirmed progress after exhaustion', async () => {
    const selected = file(12)
    const api = apiHarness(selected)
    const failure = Object.assign(new Error('network failed'), { networkError: true })
    api.completeUpload = vi.fn<UploadRunnerApi['completeUpload']>().mockRejectedValue(failure)
    const part = planUploadParts(selected.sizeBytes)[0]!
    const transport: UploadPartTransport = {
      uploadPart: vi.fn(async () => partResult(part, selected.sizeBytes, selected.sizeBytes)),
    }
    const store = memoryStore()
    const sleep = vi.fn(async () => undefined)
    const runner = new UploadRunner({
      api,
      transport,
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: keys(),
      sleep,
      random: () => 0,
    })

    await expect(runner.run(selected)).rejects.toBe(failure)
    expect(api.completeUpload).toHaveBeenCalledTimes(6)
    expect(sleep).toHaveBeenCalledTimes(5)
    expect(transport.uploadPart).toHaveBeenCalledOnce()
    expect(store.store.clear).not.toHaveBeenCalled()
    expect(store.current()).toMatchObject({
      phase: 'uploading',
      uploadId,
      confirmedBytes: selected.sizeBytes,
      completeIdempotencyKey: completeKey,
    })
  })

  it('does not consume a runner retry when token renewal succeeds inside the transport', async () => {
    const selected = file(12)
    const part = planUploadParts(selected.sizeBytes)[0]!
    const api = apiHarness(selected)
    const chunks = chunkHarness()
    let internalRequests = 0
    const transport: UploadPartTransport = {
      uploadPart: vi.fn(async () => {
        internalRequests += 2
        return partResult(part, selected.sizeBytes, selected.sizeBytes)
      }),
    }
    const sleep = vi.fn(async () => undefined)
    const runner = new UploadRunner({
      api,
      transport,
      chunks,
      source: { isReadable: vi.fn(async () => true) },
      store: memoryStore().store,
      createIdempotencyKey: keys(),
      sleep,
    })

    await expect(runner.run(selected)).resolves.toBe('finalizing')
    expect(internalRequests).toBe(2)
    expect(transport.uploadPart).toHaveBeenCalledOnce()
    expect(sleep).not.toHaveBeenCalled()
  })

  it('keeps exact progress monotonic when concurrent responses arrive out of order', async () => {
    const selected = file(PART_SIZE_BYTES * 2 + 12)
    const parts = planUploadParts(selected.sizeBytes)
    const api = apiHarness(selected)
    const chunks = chunkHarness()
    const pending = new Map<number, ReturnType<typeof deferred<UploadPartResponse['data']>>>()
    const callbacks = new Map<number, (event: { totalBytesSent: number }) => void>()
    const progress: number[] = []
    const transport: UploadPartTransport = {
      uploadPart: vi.fn(async (request) => {
        if (request.partNumber === 1) {
          request.onProgress?.({
            progress: 100,
            totalBytesSent: parts[0]!.sizeBytes,
            totalBytesExpectedToSend: parts[0]!.sizeBytes,
          })
          return partResult(parts[0]!, selected.sizeBytes, parts[0]!.sizeBytes)
        }
        callbacks.set(request.partNumber, (event) =>
          request.onProgress?.({
            progress: 0,
            totalBytesSent: event.totalBytesSent,
            totalBytesExpectedToSend: request.chunkSizeBytes,
          }),
        )
        const wait = deferred<UploadPartResponse['data']>()
        pending.set(request.partNumber, wait)
        return wait.promise
      }),
    }
    const runner = new UploadRunner({
      api,
      transport,
      chunks,
      source: { isReadable: vi.fn(async () => true) },
      store: memoryStore().store,
      createIdempotencyKey: keys(),
      onProgress: (event) => progress.push(event.bytes),
    })

    const running = runner.run(selected)
    await vi.waitFor(() => {
      expect(callbacks.size).toBe(2)
    })
    callbacks.get(2)?.({ totalBytesSent: 17 })
    callbacks.get(3)?.({ totalBytesSent: 7 })
    pending.get(2)?.resolve(partResult(parts[1]!, selected.sizeBytes, selected.sizeBytes))
    await flush()
    pending
      .get(3)
      ?.resolve(
        partResult(parts[2]!, selected.sizeBytes, parts[0]!.sizeBytes + parts[2]!.sizeBytes),
      )

    await expect(running).resolves.toBe('finalizing')
    expect(progress.at(-1)).toBe(selected.sizeBytes)
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1]!)).toBe(
      true,
    )
    expect(progress.every((value) => value >= 0 && value <= selected.sizeBytes)).toBe(true)
  })
})

describe('UploadRunner pause and resume', () => {
  it('parks a part retry in the background and refreshes server truth before retrying', async () => {
    const selected = file(12)
    const part = planUploadParts(selected.sizeBytes)[0]!
    const api = apiHarness(selected)
    const refreshing = deferred<UploadDetailResponse['data']>()
    api.getUpload = vi.fn(() => refreshing.promise)
    const networkFailure = Object.assign(new Error('network failed'), { networkError: true })
    const retryBackoff = deferred<undefined>()
    const retriedUpload = deferred<UploadPartResponse['data']>()
    const chunks = chunkHarness()
    const uploadPart = vi
      .fn<UploadPartTransport['uploadPart']>()
      .mockRejectedValueOnce(networkFailure)
      .mockImplementationOnce(() => retriedUpload.promise)
    const runner = new UploadRunner({
      api,
      transport: { uploadPart },
      chunks,
      source: { isReadable: vi.fn(async () => true) },
      store: memoryStore().store,
      createIdempotencyKey: keys(),
      sleep: vi.fn(() => retryBackoff.promise),
      random: () => 0,
    })

    const running = runner.run(selected)
    await vi.waitFor(() => {
      expect(uploadPart).toHaveBeenCalledOnce()
    })
    await runner.pause()
    retryBackoff.resolve(undefined)
    await flush()

    expect(uploadPart).toHaveBeenCalledOnce()
    expect(api.getUpload).not.toHaveBeenCalled()

    const foregrounding = runner.foreground()
    await vi.waitFor(() => {
      expect(api.getUpload).toHaveBeenCalledWith(uploadId)
    })
    expect(uploadPart).toHaveBeenCalledOnce()

    refreshing.resolve(detailData(selected, { 1: 'pending' }, 0))
    await foregrounding
    await vi.waitFor(() => {
      expect(uploadPart).toHaveBeenCalledTimes(2)
    })
    retriedUpload.resolve(partResult(part, selected.sizeBytes, selected.sizeBytes))

    await expect(running).resolves.toBe('finalizing')
    expect(chunks.create).toHaveBeenCalledOnce()
    expect(chunks.delete).toHaveBeenCalledOnce()
  })

  it('does not let a stale foreground refresh override a newer pause', async () => {
    const selected = file(12)
    const part = planUploadParts(selected.sizeBytes)[0]!
    const api = apiHarness(selected)
    const firstRefresh = deferred<UploadDetailResponse['data']>()
    api.getUpload = vi
      .fn<UploadRunnerApi['getUpload']>()
      .mockImplementationOnce(() => firstRefresh.promise)
      .mockResolvedValueOnce(detailData(selected, { 1: 'pending' }, 0))
    const networkFailure = Object.assign(new Error('network failed'), { networkError: true })
    const retryBackoff = deferred<undefined>()
    const retriedUpload = deferred<UploadPartResponse['data']>()
    const uploadPart = vi
      .fn<UploadPartTransport['uploadPart']>()
      .mockRejectedValueOnce(networkFailure)
      .mockImplementationOnce(() => retriedUpload.promise)
    const store = memoryStore()
    const runner = new UploadRunner({
      api,
      transport: { uploadPart },
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: keys(),
      sleep: vi.fn(() => retryBackoff.promise),
      random: () => 0,
    })

    const running = runner.run(selected)
    await vi.waitFor(() => {
      expect(uploadPart).toHaveBeenCalledOnce()
    })
    await runner.pause()
    retryBackoff.resolve(undefined)
    await flush()

    const staleForeground = runner.foreground()
    await vi.waitFor(() => {
      expect(api.getUpload).toHaveBeenCalledOnce()
    })
    await runner.pause()
    firstRefresh.resolve(detailData(selected, { 1: 'pending' }, 0))
    await staleForeground
    await flush()

    expect(uploadPart).toHaveBeenCalledOnce()
    expect(store.current()).toMatchObject({ paused: true })

    await runner.foreground()
    await vi.waitFor(() => {
      expect(api.getUpload).toHaveBeenCalledTimes(2)
      expect(uploadPart).toHaveBeenCalledTimes(2)
    })
    retriedUpload.resolve(partResult(part, selected.sizeBytes, selected.sizeBytes))

    await expect(running).resolves.toBe('finalizing')
  })

  it('does not send a completion retry in the background', async () => {
    const selected = file(12)
    const part = planUploadParts(selected.sizeBytes)[0]!
    const api = apiHarness(selected)
    const networkFailure = Object.assign(new Error('network failed'), { networkError: true })
    const retryBackoff = deferred<undefined>()
    const retriedCompletion = deferred<Awaited<ReturnType<UploadRunnerApi['completeUpload']>>>()
    api.completeUpload = vi
      .fn<UploadRunnerApi['completeUpload']>()
      .mockRejectedValueOnce(networkFailure)
      .mockImplementationOnce(() => retriedCompletion.promise)
    api.getUpload = vi.fn(async () => detailData(selected, { 1: 'uploaded' }, selected.sizeBytes))
    const runner = new UploadRunner({
      api,
      transport: {
        uploadPart: vi.fn(async () => partResult(part, selected.sizeBytes, selected.sizeBytes)),
      },
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: memoryStore().store,
      createIdempotencyKey: keys(),
      sleep: vi.fn(() => retryBackoff.promise),
      random: () => 0,
    })

    const running = runner.run(selected)
    await vi.waitFor(() => {
      expect(api.completeUpload).toHaveBeenCalledOnce()
    })
    await runner.pause()
    retryBackoff.resolve(undefined)
    await flush()

    expect(api.completeUpload).toHaveBeenCalledOnce()

    await runner.foreground()
    await vi.waitFor(() => {
      expect(api.getUpload).toHaveBeenCalledWith(uploadId)
      expect(api.completeUpload).toHaveBeenCalledTimes(2)
    })
    retriedCompletion.resolve(completeData())

    await expect(running).resolves.toBe('finalizing')
  })

  it('latches a fresh-run pause while the initialization key is pending', async () => {
    const selected = file(12)
    const part = planUploadParts(selected.sizeBytes)[0]!
    const api = apiHarness(selected)
    const initializing = deferred<InitializeUploadResponse['data']>()
    api.initializeUpload = vi.fn(() => initializing.promise)
    const initializationKey = deferred<string>()
    const createIdempotencyKey = vi
      .fn<() => string | Promise<string>>()
      .mockImplementationOnce(() => initializationKey.promise)
      .mockReturnValueOnce(completeKey)
    const uploading = deferred<UploadPartResponse['data']>()
    const uploadPart = vi.fn<UploadPartTransport['uploadPart']>(() => uploading.promise)
    const store = memoryStore()
    const runner = new UploadRunner({
      api,
      transport: { uploadPart },
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey,
    })

    const running = runner.run(selected)
    await vi.waitFor(() => {
      expect(createIdempotencyKey).toHaveBeenCalledOnce()
    })
    await runner.pause()
    initializationKey.resolve(initializeKey)
    await vi.waitFor(() => {
      expect(store.current()).toMatchObject({ paused: true })
    })

    expect(api.initializeUpload).not.toHaveBeenCalled()
    expect(store.current()).toMatchObject({
      phase: 'initializing',
      initializeIdempotencyKey: initializeKey,
      paused: true,
    })

    await runner.foreground()
    await vi.waitFor(() => {
      expect(api.initializeUpload).toHaveBeenCalledOnce()
    })
    initializing.resolve(initializeData(selected))
    await vi.waitFor(() => {
      expect(uploadPart).toHaveBeenCalledOnce()
    })
    uploading.resolve(partResult(part, selected.sizeBytes, selected.sizeBytes))

    await expect(running).resolves.toBe('finalizing')
  })

  it('pauses only new scheduling, lets requests finish, then refreshes server truth before resuming', async () => {
    const selected = file()
    const parts = planUploadParts(selected.sizeBytes)
    const api = apiHarness(selected)
    const chunks = chunkHarness()
    const store = memoryStore()
    const pending = new Map<number, ReturnType<typeof deferred<UploadPartResponse['data']>>>()
    const starts: number[] = []
    const transport: UploadPartTransport = {
      uploadPart: vi.fn(async (request) => {
        starts.push(request.partNumber)
        if (request.partNumber === 1 || request.partNumber === 4) {
          const confirmed = request.partNumber === 1 ? parts[0]!.sizeBytes : selected.sizeBytes
          return partResult(parts[request.partNumber - 1]!, selected.sizeBytes, confirmed)
        }
        const wait = deferred<UploadPartResponse['data']>()
        pending.set(request.partNumber, wait)
        return wait.promise
      }),
    }
    api.getUpload = vi.fn(async () =>
      detailData(
        selected,
        { 1: 'uploaded', 2: 'uploaded', 3: 'verified', 4: 'pending' },
        parts[0]!.sizeBytes + parts[1]!.sizeBytes + parts[2]!.sizeBytes,
      ),
    )
    const statuses: string[] = []
    const runner = new UploadRunner({
      api,
      transport,
      chunks,
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: keys(),
      onStatus: (event) => statuses.push(event.status),
    })

    const running = runner.run(selected)
    await vi.waitFor(() => {
      expect(starts).toEqual([1, 2, 3])
    })
    await runner.pause()
    pending
      .get(2)
      ?.resolve(
        partResult(parts[1]!, selected.sizeBytes, parts[0]!.sizeBytes + parts[1]!.sizeBytes),
      )
    pending
      .get(3)
      ?.resolve(partResult(parts[2]!, selected.sizeBytes, selected.sizeBytes - parts[3]!.sizeBytes))
    await flush()
    expect(starts).toEqual([1, 2, 3])

    await expect(runner.resume()).resolves.toEqual({ action: 'continued' })
    await expect(running).resolves.toBe('finalizing')
    expect(starts).toEqual([1, 2, 3, 4])
    expect(api.getUpload).toHaveBeenCalledWith(uploadId)
    expect(statuses).toContain('paused')
    expect(statuses).toContain('resuming')
  })

  it('rejects a second run while one file is active', async () => {
    const selected = file(12)
    const api = apiHarness(selected)
    const chunks = chunkHarness()
    const wait = deferred<UploadPartResponse['data']>()
    const transport: UploadPartTransport = { uploadPart: vi.fn(() => wait.promise) }
    const runner = new UploadRunner({
      api,
      transport,
      chunks,
      source: { isReadable: vi.fn(async () => true) },
      store: memoryStore().store,
      createIdempotencyKey: keys(),
    })

    const running = runner.run(selected)
    await vi.waitFor(() => {
      expect(transport.uploadPart).toHaveBeenCalledOnce()
    })
    await expect(runner.run(selected)).rejects.toBeInstanceOf(UploadRunnerBusyError)
    wait.resolve(partResult(planUploadParts(12)[0]!, 12, 12))
    await running
  })
})

describe('UploadRunner durable cold resume', () => {
  function persisted(input: UploadRunnerFile): UploadRunnerResumeMetadata {
    return {
      version: 1,
      phase: 'uploading',
      file: { ...input },
      initializeIdempotencyKey: initializeKey,
      uploadId,
      parts: planUploadParts(input.sizeBytes),
      confirmedBytes: PART_SIZE_BYTES,
      confirmedPartHashes: { 1: hashFor(1) },
      completeIdempotencyKey: null,
      abortIdempotencyKey: null,
      paused: true,
    }
  }

  it('latches pause while the cold store load awaits before a record exists', async () => {
    const selected = file(12)
    const part = planUploadParts(selected.sizeBytes)[0]!
    const record = {
      version: 1,
      phase: 'uploading',
      file: { ...selected },
      initializeIdempotencyKey: initializeKey,
      uploadId,
      parts: [part],
      confirmedBytes: 0,
      confirmedPartHashes: {},
      completeIdempotencyKey: null,
      abortIdempotencyKey: null,
      paused: false,
    } satisfies UploadRunnerResumeMetadata
    const store = memoryStore(record)
    const loading = deferred<unknown>()
    vi.mocked(store.store.load).mockImplementationOnce(() => loading.promise)
    const api = apiHarness(selected)
    api.getUpload = vi.fn(async () => detailData(selected, { 1: 'pending' }, 0))
    const uploading = deferred<UploadPartResponse['data']>()
    const uploadPart = vi.fn<UploadPartTransport['uploadPart']>(() => uploading.promise)
    const statuses: string[] = []
    const runner = new UploadRunner({
      api,
      transport: { uploadPart },
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: vi.fn(() => completeKey),
      onStatus: (event) => statuses.push(event.status),
    })

    const restoring = runner.resume()
    await vi.waitFor(() => {
      expect(store.store.load).toHaveBeenCalledOnce()
    })
    await runner.pause()
    loading.resolve(record)
    await vi.waitFor(() => {
      expect(statuses).toHaveLength(2)
    })

    expect(uploadPart).not.toHaveBeenCalled()
    expect(store.current()).toMatchObject({ paused: true })
    expect(statuses.at(-1)).toBe('paused')

    await runner.foreground()
    await vi.waitFor(() => {
      expect(uploadPart).toHaveBeenCalledOnce()
    })
    uploading.resolve(partResult(part, selected.sizeBytes, selected.sizeBytes))
    await expect(restoring).resolves.toEqual({ action: 'completed', result: 'finalizing' })
  })

  it('latches pause while cold initialization awaits and schedules nothing in background', async () => {
    const selected = file(12)
    const part = planUploadParts(selected.sizeBytes)[0]!
    const store = memoryStore({
      version: 1,
      phase: 'initializing',
      file: { ...selected },
      initializeIdempotencyKey: initializeKey,
      uploadId: null,
      parts: [],
      confirmedBytes: 0,
      confirmedPartHashes: {},
      completeIdempotencyKey: null,
      abortIdempotencyKey: null,
      paused: false,
    } satisfies UploadRunnerResumeMetadata)
    const api = apiHarness(selected)
    const initializing = deferred<InitializeUploadResponse['data']>()
    api.initializeUpload = vi.fn(() => initializing.promise)
    api.getUpload = vi.fn(async () => detailData(selected, { 1: 'pending' }, 0))
    const uploading = deferred<UploadPartResponse['data']>()
    const uploadPart = vi.fn<UploadPartTransport['uploadPart']>(() => uploading.promise)
    const statuses: string[] = []
    const runner = new UploadRunner({
      api,
      transport: { uploadPart },
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: vi.fn(() => completeKey),
      onStatus: (event) => statuses.push(event.status),
    })

    const restoring = runner.resume()
    await vi.waitFor(() => {
      expect(api.initializeUpload).toHaveBeenCalledOnce()
    })
    await runner.pause()
    initializing.resolve(initializeData(selected))
    await vi.waitFor(() => {
      expect(statuses).toHaveLength(3)
    })

    expect(uploadPart).not.toHaveBeenCalled()
    expect(store.current()).toMatchObject({ paused: true })
    expect(statuses.at(-1)).toBe('paused')

    await runner.foreground()
    await vi.waitFor(() => {
      expect(uploadPart).toHaveBeenCalledOnce()
    })
    uploading.resolve(partResult(part, selected.sizeBytes, selected.sizeBytes))
    await expect(restoring).resolves.toEqual({ action: 'completed', result: 'finalizing' })
  })

  it('latches pause while cold detail refresh awaits and schedules nothing in background', async () => {
    const selected = file(12)
    const part = planUploadParts(selected.sizeBytes)[0]!
    const store = memoryStore({
      version: 1,
      phase: 'uploading',
      file: { ...selected },
      initializeIdempotencyKey: initializeKey,
      uploadId,
      parts: [part],
      confirmedBytes: 0,
      confirmedPartHashes: {},
      completeIdempotencyKey: null,
      abortIdempotencyKey: null,
      paused: false,
    } satisfies UploadRunnerResumeMetadata)
    const api = apiHarness(selected)
    const refreshing = deferred<UploadDetailResponse['data']>()
    api.getUpload = vi
      .fn<UploadRunnerApi['getUpload']>()
      .mockImplementationOnce(() => refreshing.promise)
      .mockResolvedValueOnce(detailData(selected, { 1: 'pending' }, 0))
    const uploading = deferred<UploadPartResponse['data']>()
    const uploadPart = vi.fn<UploadPartTransport['uploadPart']>(() => uploading.promise)
    const source = { isReadable: vi.fn(async () => true) }
    const statuses: string[] = []
    const runner = new UploadRunner({
      api,
      transport: { uploadPart },
      chunks: chunkHarness(),
      source,
      store: store.store,
      createIdempotencyKey: vi.fn(() => completeKey),
      onStatus: (event) => statuses.push(event.status),
    })

    const restoring = runner.resume()
    await vi.waitFor(() => {
      expect(api.getUpload).toHaveBeenCalledOnce()
    })
    await runner.pause()
    refreshing.resolve(detailData(selected, { 1: 'pending' }, 0))
    await vi.waitFor(() => {
      expect(source.isReadable).toHaveBeenCalledOnce()
    })
    await vi.waitFor(() => {
      expect(statuses).toHaveLength(3)
    })

    expect(uploadPart).not.toHaveBeenCalled()
    expect(store.current()).toMatchObject({ paused: true })
    expect(statuses.at(-1)).toBe('paused')

    await runner.foreground()
    await vi.waitFor(() => {
      expect(uploadPart).toHaveBeenCalledOnce()
    })
    uploading.resolve(partResult(part, selected.sizeBytes, selected.sizeBytes))
    await expect(restoring).resolves.toEqual({ action: 'completed', result: 'finalizing' })
  })

  it('rehashes every remotely confirmed part, cleans hash chunks, and uploads only pending parts', async () => {
    const selected = file(PART_SIZE_BYTES + 12)
    const parts = planUploadParts(selected.sizeBytes)
    const store = memoryStore(persisted(selected))
    const api = apiHarness(selected)
    api.getUpload = vi.fn(async () =>
      detailData(selected, { 1: 'verified', 2: 'pending' }, PART_SIZE_BYTES),
    )
    const chunks = chunkHarness()
    const transport: UploadPartTransport = {
      uploadPart: vi.fn(async (request) =>
        partResult(parts[request.partNumber - 1]!, selected.sizeBytes, selected.sizeBytes),
      ),
    }
    const runner = new UploadRunner({
      api,
      transport,
      chunks,
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: vi.fn(() => completeKey),
    })

    await expect(runner.resume()).resolves.toEqual({ action: 'completed', result: 'finalizing' })
    expect(chunks.create.mock.calls.map((call) => call[1].partNumber)).toEqual([1, 2])
    expect(chunks.delete).toHaveBeenCalledTimes(2)
    expect(transport.uploadPart).toHaveBeenCalledOnce()
    expect(transport.uploadPart).toHaveBeenCalledWith(expect.objectContaining({ partNumber: 2 }))
  })

  it('aborts with one persisted replacement key when a retained local hash differs', async () => {
    const selected = file(PART_SIZE_BYTES + 12)
    const record = persisted(selected)
    const store = memoryStore(record)
    const api = apiHarness(selected)
    api.getUpload = vi.fn(async () =>
      detailData(selected, { 1: 'uploaded', 2: 'pending' }, PART_SIZE_BYTES),
    )
    const chunks = chunkHarness()
    chunks.create.mockResolvedValueOnce({
      partNumber: 1,
      sizeBytes: PART_SIZE_BYTES,
      sha256: 'f'.repeat(64),
      tempPath: 'wxfile://usr/private-mismatch.part',
    })
    const runner = new UploadRunner({
      api,
      transport: { uploadPart: vi.fn() },
      chunks,
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: vi.fn(() => abortKey),
    })

    await expect(runner.resume()).resolves.toEqual({ action: 'replace' })
    expect(chunks.delete).toHaveBeenCalledOnce()
    expect(api.abortUpload).toHaveBeenCalledWith(uploadId, 'replaced', abortKey)
    expect(store.saves.some((saved) => saved.abortIdempotencyKey === abortKey)).toBe(true)
    expect(store.store.clear).toHaveBeenCalledOnce()
  })

  it('requires replacement without hashing when the retained source path is unreadable', async () => {
    const selected = file(PART_SIZE_BYTES + 12)
    const api = apiHarness(selected)
    api.getUpload = vi.fn(async () =>
      detailData(selected, { 1: 'uploaded', 2: 'pending' }, PART_SIZE_BYTES),
    )
    const chunks = chunkHarness()
    const runner = new UploadRunner({
      api,
      transport: { uploadPart: vi.fn() },
      chunks,
      source: { isReadable: vi.fn(async () => false) },
      store: memoryStore(persisted(selected)).store,
      createIdempotencyKey: vi.fn(() => abortKey),
    })

    await expect(runner.resume()).resolves.toEqual({ action: 'replace' })
    expect(chunks.create).not.toHaveBeenCalled()
    expect(api.abortUpload).toHaveBeenCalledWith(uploadId, 'replaced', abortKey)
  })

  it('persists the initialization key before the request and reuses it after a cold restart', async () => {
    const selected = file(12)
    const store = memoryStore()
    const firstApi = apiHarness(selected)
    const networkFailure = Object.assign(new Error('network failed'), { networkError: true })
    firstApi.initializeUpload = vi.fn(async () => Promise.reject(networkFailure))
    const sleep = vi.fn(async () => undefined)
    const first = new UploadRunner({
      api: firstApi,
      transport: { uploadPart: vi.fn() },
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: vi.fn(() => initializeKey),
      sleep,
      random: () => 0,
    })

    await expect(first.run(selected)).rejects.toBe(networkFailure)
    expect(firstApi.initializeUpload).toHaveBeenCalledTimes(6)
    expect(firstApi.initializeUpload).toHaveBeenCalledWith(
      expect.objectContaining({ sizeBytes: 12 }),
      initializeKey,
    )
    expect(sleep).toHaveBeenCalledTimes(5)
    expect(store.saves[0]).toMatchObject({
      phase: 'initializing',
      initializeIdempotencyKey: initializeKey,
      uploadId: null,
    })

    const secondApi = apiHarness(selected)
    const part = planUploadParts(12)[0]!
    const second = new UploadRunner({
      api: secondApi,
      transport: { uploadPart: vi.fn(async () => partResult(part, 12, 12)) },
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: vi.fn(() => completeKey),
    })

    await expect(second.resume()).resolves.toEqual({ action: 'completed', result: 'finalizing' })
    expect(secondApi.initializeUpload).toHaveBeenCalledWith(
      expect.objectContaining({ sizeBytes: 12 }),
      initializeKey,
    )
  })

  it('retains finalizing metadata without requiring the temporary source to remain readable', async () => {
    const selected = file(PART_SIZE_BYTES + 12)
    const record: UploadRunnerResumeMetadata = {
      ...persisted(selected),
      phase: 'finalizing',
      confirmedBytes: selected.sizeBytes,
      confirmedPartHashes: { 1: hashFor(1), 2: hashFor(2) },
      completeIdempotencyKey: completeKey,
      paused: false,
    }
    const store = memoryStore(record)
    const api = apiHarness(selected)
    api.getUpload = vi.fn(async () => detailData(selected, {}, selected.sizeBytes, 'finalizing'))
    const source = { isReadable: vi.fn(async () => false) }
    const runner = new UploadRunner({
      api,
      transport: { uploadPart: vi.fn() },
      chunks: chunkHarness(),
      source,
      store: store.store,
      createIdempotencyKey: vi.fn(async () => abortKey),
    })

    await expect(runner.resume()).resolves.toEqual({
      action: 'completed',
      result: 'finalizing',
    })
    expect(source.isReadable).not.toHaveBeenCalled()
    expect(runner.pollAfterSeconds).toBe(2)
    expect(api.abortUpload).not.toHaveBeenCalled()
    expect(store.store.clear).not.toHaveBeenCalled()
    expect(store.current()).toMatchObject({
      phase: 'finalizing',
      completeIdempotencyKey: completeKey,
    })
  })

  it('uses a new complete key after a finalizer rolls a missing part back to pending', async () => {
    const selected = file(PART_SIZE_BYTES + 12)
    const parts = planUploadParts(selected.sizeBytes)
    const record: UploadRunnerResumeMetadata = {
      ...persisted(selected),
      phase: 'finalizing',
      confirmedBytes: selected.sizeBytes,
      confirmedPartHashes: { 1: hashFor(1), 2: hashFor(2) },
      completeIdempotencyKey: completeKey,
      paused: false,
    }
    const store = memoryStore(record)
    const api = apiHarness(selected)
    api.getUpload = vi.fn(async () =>
      detailData(selected, { 1: 'verified', 2: 'pending' }, PART_SIZE_BYTES),
    )
    const transport: UploadPartTransport = {
      uploadPart: vi.fn(async () => partResult(parts[1]!, selected.sizeBytes, selected.sizeBytes)),
    }
    const runner = new UploadRunner({
      api,
      transport,
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: vi.fn(async () => abortKey),
    })

    await expect(runner.resume()).resolves.toEqual({
      action: 'completed',
      result: 'finalizing',
    })
    expect(transport.uploadPart).toHaveBeenCalledWith(expect.objectContaining({ partNumber: 2 }))
    expect(api.completeUpload).toHaveBeenCalledWith(uploadId, abortKey)
    expect(store.current()).toMatchObject({
      phase: 'finalizing',
      completeIdempotencyKey: abortKey,
    })
  })

  it('foregrounds a paused cold-resume upload without waiting on its outer resume promise', async () => {
    const selected = file(PART_SIZE_BYTES + 12)
    const parts = planUploadParts(selected.sizeBytes)
    const store = memoryStore(persisted(selected))
    const api = apiHarness(selected)
    api.getUpload = vi
      .fn<UploadRunnerApi['getUpload']>()
      .mockResolvedValueOnce(detailData(selected, { 1: 'verified', 2: 'pending' }, PART_SIZE_BYTES))
      .mockResolvedValueOnce(
        detailData(selected, { 1: 'verified', 2: 'uploaded' }, selected.sizeBytes),
      )
    const upload = deferred<UploadPartResponse['data']>()
    const transport: UploadPartTransport = { uploadPart: vi.fn(() => upload.promise) }
    const runner = new UploadRunner({
      api,
      transport,
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(() => Promise.resolve(true)) },
      store: store.store,
      createIdempotencyKey: vi.fn(() => Promise.resolve(completeKey)),
    })

    const restoring = runner.resume()
    await vi.waitFor(() => {
      expect(transport.uploadPart).toHaveBeenCalledOnce()
    })
    await runner.pause()
    const foregrounding = runner.foreground()
    let restoreSettled = false
    void restoring.finally(() => {
      restoreSettled = true
    })
    expect(restoreSettled).toBe(false)

    upload.resolve(partResult(parts[1]!, selected.sizeBytes, selected.sizeBytes))
    await expect(foregrounding).resolves.toBeUndefined()
    await expect(restoring).resolves.toEqual({ action: 'completed', result: 'finalizing' })
    expect(api.getUpload).toHaveBeenCalledTimes(2)
  })

  it('clears retained finalizing metadata only after the server reports uploaded', async () => {
    const selected = file(12)
    const record: UploadRunnerResumeMetadata = {
      ...persisted(selected),
      phase: 'finalizing',
      confirmedBytes: 12,
      confirmedPartHashes: { 1: hashFor(1) },
      completeIdempotencyKey: completeKey,
      paused: false,
    }
    const store = memoryStore(record)
    const api = apiHarness(selected)
    api.getUpload = vi.fn(async () => detailData(selected, {}, 12, 'uploaded'))
    const runner = new UploadRunner({
      api,
      transport: { uploadPart: vi.fn() },
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => false) },
      store: store.store,
      createIdempotencyKey: keys(),
    })

    await expect(runner.resume()).resolves.toEqual({ action: 'completed', result: 'uploaded' })
    expect(runner.pollAfterSeconds).toBeNull()
    expect(store.store.clear).toHaveBeenCalledOnce()
  })

  it('clears malformed persistence without querying or uploading', async () => {
    const selected = file(12)
    const store = memoryStore({ version: 1, sourcePath: '../../foreign' })
    const api = apiHarness(selected)
    const transport: UploadPartTransport = { uploadPart: vi.fn() }
    const runner = new UploadRunner({
      api,
      transport,
      chunks: chunkHarness(),
      source: { isReadable: vi.fn(async () => true) },
      store: store.store,
      createIdempotencyKey: keys(),
    })

    await expect(runner.resume()).resolves.toEqual({ action: 'none' })
    expect(store.store.clear).toHaveBeenCalledOnce()
    expect(api.getUpload).not.toHaveBeenCalled()
    expect(transport.uploadPart).not.toHaveBeenCalled()
  })
})
