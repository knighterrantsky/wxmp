import { MAX_UNFINISHED_UPLOADS } from '../core/upload-queue.js'
import type {
  UploadResumeStore,
  UploadRunnerResumeMetadata,
  UploadRunnerStorage,
} from './upload-runner.js'

const DEFAULT_STORAGE_KEY = 'privateMediaUploadResumeV1'
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

interface RegistryEnvelope {
  readonly version: 2
  readonly records: Readonly<Record<string, UploadRunnerResumeMetadata>>
}

export interface UploadResumeRegistry {
  createStore(initializeIdempotencyKey?: string): UploadResumeStore
  record(initializeIdempotencyKey: string): UploadRunnerResumeMetadata | undefined
  keys(): readonly string[]
  count(): number
}

export class UploadResumeRegistryCapacityError extends Error {
  override readonly name = 'UploadResumeRegistryCapacityError'

  constructor() {
    super('UPLOAD_RESUME_REGISTRY_CAPACITY')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function looksLikeResumeMetadata(value: unknown): value is UploadRunnerResumeMetadata {
  if (!isRecord(value) || value['version'] !== 1) return false
  if (!UUID_V7.test(String(value['initializeIdempotencyKey']))) return false
  if (!isRecord(value['file']) || !Array.isArray(value['parts'])) return false
  return (
    typeof value['file']['sourcePath'] === 'string' &&
    typeof value['file']['fileName'] === 'string' &&
    typeof value['file']['sizeBytes'] === 'number' &&
    typeof value['file']['kind'] === 'string' &&
    typeof value['file']['mimeType'] === 'string' &&
    typeof value['confirmedBytes'] === 'number' &&
    isRecord(value['confirmedPartHashes']) &&
    typeof value['paused'] === 'boolean'
  )
}

function copyMetadata(metadata: UploadRunnerResumeMetadata): UploadRunnerResumeMetadata {
  return {
    ...metadata,
    file: { ...metadata.file },
    parts: metadata.parts.map((part) => ({ ...part })),
    confirmedPartHashes: { ...metadata.confirmedPartHashes },
  }
}

function decodedRecords(value: unknown): Map<string, UploadRunnerResumeMetadata> {
  const records = new Map<string, UploadRunnerResumeMetadata>()
  if (looksLikeResumeMetadata(value)) {
    records.set(value.initializeIdempotencyKey, copyMetadata(value))
    return records
  }
  if (!isRecord(value) || value['version'] !== 2 || !isRecord(value['records'])) return records

  for (const [key, candidate] of Object.entries(value['records'])) {
    if (records.size >= MAX_UNFINISHED_UPLOADS) break
    if (
      UUID_V7.test(key) &&
      looksLikeResumeMetadata(candidate) &&
      candidate.initializeIdempotencyKey === key
    ) {
      records.set(key, copyMetadata(candidate))
    }
  }
  return records
}

function envelope(records: ReadonlyMap<string, UploadRunnerResumeMetadata>): RegistryEnvelope {
  return {
    version: 2,
    records: Object.fromEntries(
      [...records.entries()].map(([key, metadata]) => [key, copyMetadata(metadata)]),
    ),
  }
}

export function createUploadResumeRegistry(
  storage: UploadRunnerStorage,
  storageKey = DEFAULT_STORAGE_KEY,
): UploadResumeRegistry {
  if (storageKey.length < 1 || storageKey.length > 128 || storageKey.includes('\u0000')) {
    throw new TypeError('Upload resume registry storage key is invalid')
  }

  const read = (): Map<string, UploadRunnerResumeMetadata> =>
    decodedRecords(storage.getStorage(storageKey))

  const write = (records: ReadonlyMap<string, UploadRunnerResumeMetadata>): void => {
    if (records.size === 0) {
      storage.removeStorage(storageKey)
      return
    }
    storage.setStorage(storageKey, envelope(records))
  }

  return {
    createStore(initialKey) {
      if (initialKey !== undefined && !UUID_V7.test(initialKey)) {
        throw new TypeError('Upload resume record key is invalid')
      }
      let boundKey = initialKey
      return {
        load: () => {
          if (boundKey === undefined) return undefined
          const metadata = read().get(boundKey)
          return metadata === undefined ? undefined : copyMetadata(metadata)
        },
        save: (metadata) => {
          if (!looksLikeResumeMetadata(metadata)) {
            throw new TypeError('Upload resume metadata is invalid')
          }
          const nextKey = metadata.initializeIdempotencyKey
          const records = read()
          const replacingExisting = records.has(nextKey) || records.has(boundKey ?? '')
          if (!replacingExisting && records.size >= MAX_UNFINISHED_UPLOADS) {
            throw new UploadResumeRegistryCapacityError()
          }
          if (boundKey !== undefined && boundKey !== nextKey) records.delete(boundKey)
          boundKey = nextKey
          records.set(nextKey, copyMetadata(metadata))
          write(records)
        },
        clear: () => {
          if (boundKey === undefined) return
          const records = read()
          records.delete(boundKey)
          write(records)
        },
      }
    },
    record: (initializeIdempotencyKey) => {
      if (!UUID_V7.test(initializeIdempotencyKey)) return undefined
      const metadata = read().get(initializeIdempotencyKey)
      return metadata === undefined ? undefined : copyMetadata(metadata)
    },
    keys: () => Object.freeze([...read().keys()]),
    count: () => read().size,
  }
}
