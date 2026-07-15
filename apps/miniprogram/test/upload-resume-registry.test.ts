import { describe, expect, it } from 'vitest'

import { MAX_UNFINISHED_UPLOADS } from '../miniprogram/core/upload-queue.js'
import {
  UploadResumeRegistryCapacityError,
  createUploadResumeRegistry,
} from '../miniprogram/services/upload-resume-registry.js'
import type {
  UploadRunnerResumeMetadata,
  UploadRunnerStorage,
} from '../miniprogram/services/upload-runner.js'

const storageKey = 'privateMediaUploadResumeV1'

function metadata(index: number): UploadRunnerResumeMetadata {
  const suffix = String(index).padStart(12, '0')
  return {
    version: 1,
    phase: 'uploading',
    file: {
      sourcePath: `wxfile://tmp/${String(index)}.jpg`,
      fileName: `${String(index)}.jpg`,
      sizeBytes: 12,
      kind: 'image',
      mimeType: 'image/jpeg',
    },
    initializeIdempotencyKey: `01981d0c-ec80-7000-8000-${suffix}`,
    uploadId: `01981d0c-ec80-7000-9000-${suffix}`,
    parts: [{ partNumber: 1, offsetBytes: 0, sizeBytes: 12 }],
    confirmedBytes: 0,
    confirmedPartHashes: {},
    completeIdempotencyKey: null,
    abortIdempotencyKey: null,
    paused: false,
  }
}

function memoryStorage(initial?: unknown) {
  const values = new Map<string, unknown>()
  if (initial !== undefined) values.set(storageKey, initial)
  const storage: UploadRunnerStorage = {
    getStorage: (key) => values.get(key),
    setStorage: (key, value) => {
      values.set(key, value)
    },
    removeStorage: (key) => {
      values.delete(key)
    },
  }
  return { values, storage }
}

describe('upload resume registry', () => {
  it('keeps independent records for consecutive file runners', async () => {
    const memory = memoryStorage()
    const registry = createUploadResumeRegistry(memory.storage)
    const first = registry.createStore()
    const second = registry.createStore()

    await first.save(metadata(1))
    await second.save(metadata(2))

    expect(registry.count()).toBe(2)
    expect(registry.keys()).toEqual([
      metadata(1).initializeIdempotencyKey,
      metadata(2).initializeIdempotencyKey,
    ])
    expect(registry.record(metadata(1).initializeIdempotencyKey)).toEqual(metadata(1))
    await expect(Promise.resolve(first.load())).resolves.toEqual(metadata(1))
    await expect(Promise.resolve(second.load())).resolves.toEqual(metadata(2))

    await second.clear()
    expect(registry.count()).toBe(1)
    await expect(Promise.resolve(first.load())).resolves.toEqual(metadata(1))
    await expect(Promise.resolve(second.load())).resolves.toBeUndefined()
  })

  it('binds a cold-restore store to exactly one existing record', async () => {
    const memory = memoryStorage()
    const registry = createUploadResumeRegistry(memory.storage)
    const firstMetadata = metadata(1)
    const secondMetadata = metadata(2)
    await registry.createStore().save(firstMetadata)
    await registry.createStore().save(secondMetadata)

    const restored = registry.createStore(firstMetadata.initializeIdempotencyKey)
    await expect(Promise.resolve(restored.load())).resolves.toEqual(firstMetadata)
    await restored.clear()

    expect(registry.keys()).toEqual([secondMetadata.initializeIdempotencyKey])
  })

  it('migrates the v1 single-record shape without losing resumability', async () => {
    const legacy = metadata(3)
    const memory = memoryStorage(legacy)
    const registry = createUploadResumeRegistry(memory.storage)

    expect(registry.keys()).toEqual([legacy.initializeIdempotencyKey])
    await expect(
      Promise.resolve(registry.createStore(legacy.initializeIdempotencyKey).load()),
    ).resolves.toEqual(legacy)

    await registry.createStore().save(metadata(4))
    expect(registry.count()).toBe(2)
    expect(memory.values.get(storageKey)).toMatchObject({ version: 2 })
  })

  it('refuses a sixth retained record before it can overwrite another session', async () => {
    const memory = memoryStorage()
    const registry = createUploadResumeRegistry(memory.storage)
    for (let index = 1; index <= MAX_UNFINISHED_UPLOADS; index += 1) {
      await registry.createStore().save(metadata(index))
    }

    expect(() => registry.createStore().save(metadata(6))).toThrow(
      UploadResumeRegistryCapacityError,
    )
    expect(registry.count()).toBe(MAX_UNFINISHED_UPLOADS)
    expect(registry.keys()).not.toContain(metadata(6).initializeIdempotencyKey)
  })

  it('ignores malformed storage instead of exposing arbitrary values as records', () => {
    const memory = memoryStorage({ version: 2, records: { bad: { secret: 'value' } } })
    const registry = createUploadResumeRegistry(memory.storage)

    expect(registry.keys()).toEqual([])
    expect(registry.count()).toBe(0)
    expect(registry.record('not-a-uuid')).toBeUndefined()
  })
})
