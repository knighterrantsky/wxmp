import {
  IMAGE_MIME_TYPES,
  PART_SIZE_BYTES,
  PUBLIC_UPLOAD_STATUSES,
  UUID_V7_PATTERN,
  VIDEO_MIME_TYPES,
  planUploadParts,
  type AbortUploadResponse,
  type AllowedMimeType,
  type CompleteUploadResponse,
  type InitializeUploadRequest,
  type InitializeUploadResponse,
  type MediaKind,
  type PublicUploadStatus,
  type UploadDetailResponse,
  type UploadPartPlan,
  type UploadPartResponse,
} from '@wx-upload/contracts'

import { UploadProgressTracker, type UploadProgress } from '../core/progress.js'
import {
  MAX_UPLOAD_RETRIES,
  fullJitterDelayMs,
  retryWithFullJitter,
  shouldRetryUploadFailure,
} from '../core/retry.js'
import type { ChunkFile } from './chunk-files.js'

export const UPLOAD_RUNNER_RESUME_STORAGE_KEY = 'privateMediaUploadResumeV1'

const UUID_V7 = new RegExp(UUID_V7_PATTERN, 'u')
const SHA256 = /^[0-9a-f]{64}$/u
const IMAGE_MIMES = new Set<string>(IMAGE_MIME_TYPES)
const VIDEO_MIMES = new Set<string>(VIDEO_MIME_TYPES)
const PUBLIC_STATUSES = new Set<string>(PUBLIC_UPLOAD_STATUSES)
const MAX_PATH_LENGTH = 4096

type MaybePromise<T> = T | Promise<T>

export type UploadRunnerResult = 'finalizing' | 'uploaded'
export type UploadRunnerPhase = 'initializing' | 'uploading' | 'finalizing'
export type UploadRunnerStatus =
  | 'initializing'
  | 'uploading'
  | 'paused'
  | 'resuming'
  | 'finalizing'
  | 'uploaded'
  | 'replace-required'
  | 'failed'

export interface UploadRunnerFile {
  readonly sourcePath: string
  readonly fileName: string
  readonly sizeBytes: number
  readonly kind: MediaKind
  readonly mimeType: AllowedMimeType
}

export interface UploadRunnerStatusEvent {
  readonly status: UploadRunnerStatus
  readonly uploadId: string | null
  readonly sourcePath: string
  readonly fileName: string
}

export interface UploadRunnerProgressEvent extends UploadProgress {
  readonly uploadId: string
  readonly sourcePath: string
  readonly fileName: string
}

export interface UploadRunnerApi {
  initializeUpload(
    request: InitializeUploadRequest,
    idempotencyKey: string,
  ): Promise<InitializeUploadResponse['data']>
  getUpload(uploadId: string): Promise<UploadDetailResponse['data']>
  completeUpload(
    uploadId: string,
    idempotencyKey: string,
  ): Promise<CompleteUploadResponse['data'] | UploadedCompletion>
  abortUpload(
    uploadId: string,
    reason: 'replaced',
    idempotencyKey: string,
  ): Promise<AbortUploadResponse['data']>
}

export interface UploadPartProgressEvent {
  readonly progress: number
  readonly totalBytesSent: number
  readonly totalBytesExpectedToSend: number
}

export interface UploadPartTransportRequest {
  readonly uploadId: string
  readonly partNumber: number
  readonly sha256: string
  readonly chunkSizeBytes: number
  readonly tempPath: string
  readonly onProgress?: ((event: UploadPartProgressEvent) => void) | undefined
}

export interface UploadPartTransport {
  uploadPart(request: UploadPartTransportRequest): Promise<UploadPartResponse['data']>
}

export interface UploadRunnerChunkFiles {
  create(sourcePath: string, part: UploadPartPlan): Promise<ChunkFile>
  delete(chunk: ChunkFile): Promise<void>
}

export interface UploadSourceProbe {
  isReadable(sourcePath: string): MaybePromise<boolean>
}

export interface UploadResumeStore {
  load(): MaybePromise<unknown>
  save(metadata: UploadRunnerResumeMetadata): MaybePromise<void>
  clear(): MaybePromise<void>
}

export interface UploadRunnerStorage {
  getStorage(key: string): unknown
  setStorage(key: string, value: unknown): void
  removeStorage(key: string): void
}

export interface UploadRunnerResumeMetadata {
  readonly version: 1
  readonly phase: UploadRunnerPhase
  readonly file: UploadRunnerFile
  readonly initializeIdempotencyKey: string
  readonly uploadId: string | null
  readonly parts: readonly UploadPartPlan[]
  readonly confirmedBytes: number
  readonly confirmedPartHashes: Readonly<Record<number, string>>
  readonly completeIdempotencyKey: string | null
  readonly abortIdempotencyKey: string | null
  readonly paused: boolean
}

export type UploadRunnerResumeResult =
  | { readonly action: 'none' }
  | { readonly action: 'continued' }
  | { readonly action: 'replace' }
  | { readonly action: 'completed'; readonly result: UploadRunnerResult }

export interface UploadRunnerOptions {
  readonly api: UploadRunnerApi
  readonly transport: UploadPartTransport
  readonly chunks: UploadRunnerChunkFiles
  readonly source: UploadSourceProbe
  readonly store: UploadResumeStore
  readonly createIdempotencyKey: () => MaybePromise<string>
  readonly sleep?: ((delayMs: number) => Promise<void>) | undefined
  readonly random?: (() => number) | undefined
  readonly onStatus?: ((event: UploadRunnerStatusEvent) => void) | undefined
  readonly onProgress?: ((event: UploadRunnerProgressEvent) => void) | undefined
}

interface UploadedCompletion {
  readonly upload: {
    readonly id: string
    readonly status: 'uploaded'
  }
}

interface MutableResumeRecord {
  version: 1
  phase: UploadRunnerPhase
  file: UploadRunnerFile
  initializeIdempotencyKey: string
  uploadId: string | null
  parts: UploadPartPlan[]
  confirmedBytes: number
  confirmedPartHashes: Record<number, string>
  completeIdempotencyKey: string | null
  abortIdempotencyKey: string | null
  paused: boolean
}

type PartOutcome =
  | { readonly partNumber: number; readonly state: 'uploaded' }
  | { readonly partNumber: number; readonly state: 'paused' }
  | { readonly partNumber: number; readonly state: 'failed'; readonly error: Error }

interface ActiveUpload {
  readonly record: MutableResumeRecord
  readonly tracker: UploadProgressTracker
  pending: UploadPartPlan[]
  readonly inFlight: Map<number, Promise<PartOutcome>>
  readonly retryAttempts: Map<number, number>
  readonly parkedChunks: Map<number, ChunkFile>
  readonly waiters: Set<() => void>
  paused: boolean
  serverResult: UploadRunnerResult | undefined
  terminalError: Error | undefined
}

interface DetailSnapshot {
  readonly status: PublicUploadStatus
  readonly confirmedBytes: number
  readonly pending: UploadPartPlan[]
  readonly confirmedHashes: Record<number, string>
  readonly pollAfterSeconds: number | null
}

export class UploadRunnerBusyError extends Error {
  override readonly name = 'UploadRunnerBusyError'

  constructor() {
    super('UPLOAD_RUNNER_BUSY')
  }
}

export class UploadRunnerProtocolError extends Error {
  override readonly name = 'UploadRunnerProtocolError'
  readonly statusCode = 502
  readonly retryable = true

  constructor() {
    super('上传服务响应无效')
  }
}

export class UploadRunnerResumeError extends Error {
  override readonly name = 'UploadRunnerResumeError'
  readonly retryable = false

  constructor() {
    super('上传记录无法继续')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

class UploadRunnerUnknownFailure extends Error {
  override readonly name = 'UploadRunnerUnknownFailure'
  readonly networkError: boolean | undefined
  readonly statusCode: number | undefined
  readonly retryable: boolean | undefined

  constructor(value: unknown) {
    super('上传失败')
    const failure = isRecord(value) ? value : {}
    this.networkError =
      typeof failure['networkError'] === 'boolean' ? failure['networkError'] : undefined
    this.statusCode = typeof failure['statusCode'] === 'number' ? failure['statusCode'] : undefined
    this.retryable = typeof failure['retryable'] === 'boolean' ? failure['retryable'] : undefined
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new UploadRunnerUnknownFailure(value)
}

function isPartChecksumMismatch(value: unknown): boolean {
  return isRecord(value) && value['code'] === 'PART_CHECKSUM_MISMATCH'
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

function validUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7.test(value)
}

function validPublicStatus(value: unknown): value is PublicUploadStatus {
  return typeof value === 'string' && PUBLIC_STATUSES.has(value)
}

function validPollAfterSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 2 && value <= 30
}

function hasUnsafeFileName(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code === 0x2f || code === 0x5c || code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true
    }
  }
  return false
}

function snapshotFile(value: UploadRunnerFile): UploadRunnerFile {
  const candidate: unknown = value
  if (
    !isRecord(candidate) ||
    typeof candidate['sourcePath'] !== 'string' ||
    candidate['sourcePath'].length < 1 ||
    candidate['sourcePath'].length > MAX_PATH_LENGTH ||
    candidate['sourcePath'].includes('\u0000') ||
    typeof candidate['fileName'] !== 'string' ||
    candidate['fileName'].length < 1 ||
    candidate['fileName'].length > 255 ||
    hasUnsafeFileName(candidate['fileName']) ||
    (candidate['kind'] !== 'image' && candidate['kind'] !== 'video') ||
    typeof candidate['mimeType'] !== 'string' ||
    (candidate['kind'] === 'image'
      ? !IMAGE_MIMES.has(candidate['mimeType'])
      : !VIDEO_MIMES.has(candidate['mimeType'])) ||
    typeof candidate['sizeBytes'] !== 'number'
  ) {
    throw new TypeError('Upload file is invalid')
  }
  planUploadParts(candidate['sizeBytes'])
  return Object.freeze({
    sourcePath: candidate['sourcePath'],
    fileName: candidate['fileName'],
    sizeBytes: candidate['sizeBytes'],
    kind: candidate['kind'],
    mimeType: candidate['mimeType'] as AllowedMimeType,
  })
}

function snapshotPlans(value: readonly unknown[], fileSize: number): UploadPartPlan[] {
  const expected = planUploadParts(fileSize)
  if (value.length !== expected.length) throw new UploadRunnerProtocolError()
  return expected.map((part, index) => {
    const actual = value[index]
    if (
      !isRecord(actual) ||
      actual['partNumber'] !== part.partNumber ||
      actual['offsetBytes'] !== part.offsetBytes ||
      actual['sizeBytes'] !== part.sizeBytes
    ) {
      throw new UploadRunnerProtocolError()
    }
    return { ...part }
  })
}

function snapshotInitialization(
  value: InitializeUploadResponse['data'],
  file: UploadRunnerFile,
): { uploadId: string; parts: UploadPartPlan[] } {
  const candidate: unknown = value
  if (
    !isRecord(candidate) ||
    !isRecord(candidate['upload']) ||
    !validUuid(candidate['upload']['id']) ||
    candidate['upload']['status'] !== 'uploading' ||
    candidate['upload']['fileName'] !== file.fileName ||
    candidate['upload']['kind'] !== file.kind ||
    candidate['upload']['mimeType'] !== file.mimeType ||
    candidate['upload']['sizeBytes'] !== file.sizeBytes ||
    candidate['upload']['partSizeBytes'] !== PART_SIZE_BYTES ||
    !Array.isArray(candidate['parts'])
  ) {
    throw new UploadRunnerProtocolError()
  }
  const parts = snapshotPlans(candidate['parts'], file.sizeBytes)
  if (
    candidate['upload']['partCount'] !== parts.length ||
    candidate['parts'].some((part) => !isRecord(part) || part['status'] !== 'pending')
  ) {
    throw new UploadRunnerProtocolError()
  }
  return { uploadId: candidate['upload']['id'], parts }
}

function validByteCount(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum
}

function snapshotPartResponse(
  value: UploadPartResponse['data'],
  part: UploadPartPlan,
  chunk: ChunkFile,
  totalBytes: number,
): UploadPartResponse['data'] {
  const candidate: unknown = value
  if (
    !isRecord(candidate) ||
    !isRecord(candidate['part']) ||
    !isRecord(candidate['progress']) ||
    candidate['part']['partNumber'] !== part.partNumber ||
    candidate['part']['sizeBytes'] !== part.sizeBytes ||
    candidate['part']['sha256'] !== chunk.sha256 ||
    candidate['part']['status'] !== 'uploaded' ||
    candidate['progress']['totalBytes'] !== totalBytes ||
    !validByteCount(candidate['progress']['confirmedBytes'], totalBytes)
  ) {
    throw new UploadRunnerProtocolError()
  }
  return value
}

function metadataSnapshot(record: MutableResumeRecord): UploadRunnerResumeMetadata {
  return Object.freeze({
    version: 1,
    phase: record.phase,
    file: Object.freeze({ ...record.file }),
    initializeIdempotencyKey: record.initializeIdempotencyKey,
    uploadId: record.uploadId,
    parts: Object.freeze(record.parts.map((part) => Object.freeze({ ...part }))),
    confirmedBytes: record.confirmedBytes,
    confirmedPartHashes: Object.freeze({ ...record.confirmedPartHashes }),
    completeIdempotencyKey: record.completeIdempotencyKey,
    abortIdempotencyKey: record.abortIdempotencyKey,
    paused: record.paused,
  })
}

function decodeStoredMetadata(value: unknown): MutableResumeRecord | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'version',
      'phase',
      'file',
      'initializeIdempotencyKey',
      'uploadId',
      'parts',
      'confirmedBytes',
      'confirmedPartHashes',
      'completeIdempotencyKey',
      'abortIdempotencyKey',
      'paused',
    ]) ||
    value['version'] !== 1 ||
    (value['phase'] !== 'initializing' &&
      value['phase'] !== 'uploading' &&
      value['phase'] !== 'finalizing') ||
    !isRecord(value['file']) ||
    !validUuid(value['initializeIdempotencyKey']) ||
    !Array.isArray(value['parts']) ||
    !validByteCount(value['confirmedBytes'], Number.MAX_SAFE_INTEGER) ||
    !isRecord(value['confirmedPartHashes']) ||
    (value['completeIdempotencyKey'] !== null && !validUuid(value['completeIdempotencyKey'])) ||
    (value['abortIdempotencyKey'] !== null && !validUuid(value['abortIdempotencyKey'])) ||
    typeof value['paused'] !== 'boolean'
  ) {
    return undefined
  }

  let file: UploadRunnerFile
  try {
    file = snapshotFile(value['file'] as unknown as UploadRunnerFile)
  } catch {
    return undefined
  }

  const expectedParts = planUploadParts(file.sizeBytes)
  let parts: UploadPartPlan[]
  if (value['phase'] === 'initializing') {
    if (
      value['uploadId'] !== null ||
      value['parts'].length !== 0 ||
      value['confirmedBytes'] !== 0
    ) {
      return undefined
    }
    parts = []
  } else {
    if (!validUuid(value['uploadId'])) return undefined
    try {
      parts = snapshotPlans(value['parts'], file.sizeBytes)
    } catch {
      return undefined
    }
  }

  const hashes: Record<number, string> = {}
  for (const [partNumberText, hash] of Object.entries(value['confirmedPartHashes'])) {
    const partNumber = Number(partNumberText)
    if (
      !Number.isSafeInteger(partNumber) ||
      partNumber < 1 ||
      partNumber > expectedParts.length ||
      typeof hash !== 'string' ||
      !SHA256.test(hash)
    ) {
      return undefined
    }
    hashes[partNumber] = hash
  }
  if (value['phase'] === 'initializing' && Object.keys(hashes).length !== 0) return undefined
  if (value['confirmedBytes'] > file.sizeBytes) return undefined
  if (value['phase'] === 'finalizing' && value['completeIdempotencyKey'] === null) return undefined

  return {
    version: 1,
    phase: value['phase'],
    file,
    initializeIdempotencyKey: value['initializeIdempotencyKey'],
    uploadId: typeof value['uploadId'] === 'string' ? value['uploadId'] : null,
    parts,
    confirmedBytes: value['confirmedBytes'],
    confirmedPartHashes: hashes,
    completeIdempotencyKey:
      typeof value['completeIdempotencyKey'] === 'string' ? value['completeIdempotencyKey'] : null,
    abortIdempotencyKey:
      typeof value['abortIdempotencyKey'] === 'string' ? value['abortIdempotencyKey'] : null,
    paused: value['paused'],
  }
}

function toInitializeRequest(file: UploadRunnerFile): InitializeUploadRequest {
  return {
    fileName: file.fileName,
    kind: file.kind,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
  } as InitializeUploadRequest
}

function copiedOutcome<T extends UploadRunnerResumeResult>(outcome: T): T {
  return Object.freeze({ ...outcome })
}

export function createUploadResumeStore(
  storage: UploadRunnerStorage,
  key = UPLOAD_RUNNER_RESUME_STORAGE_KEY,
): UploadResumeStore {
  if (key.length < 1 || key.length > 128 || key.includes('\u0000')) {
    throw new TypeError('Upload resume storage key is invalid')
  }
  return {
    load: () => storage.getStorage(key),
    save: (metadata) => {
      storage.setStorage(key, metadata)
    },
    clear: () => {
      storage.removeStorage(key)
    },
  }
}

export class UploadRunner {
  readonly #api: UploadRunnerApi
  readonly #transport: UploadPartTransport
  readonly #chunks: UploadRunnerChunkFiles
  readonly #source: UploadSourceProbe
  readonly #store: UploadResumeStore
  readonly #createIdempotencyKey: () => MaybePromise<string>
  readonly #sleep: ((delayMs: number) => Promise<void>) | undefined
  readonly #random: (() => number) | undefined
  readonly #onStatus: ((event: UploadRunnerStatusEvent) => void) | undefined
  readonly #onProgress: ((event: UploadRunnerProgressEvent) => void) | undefined
  #busy = false
  #pauseRequested = false
  #pauseGeneration = 0
  #currentRecord: MutableResumeRecord | undefined
  #active: ActiveUpload | undefined
  #resumePromise: Promise<UploadRunnerResumeResult> | undefined
  #foregroundPromise: Promise<void> | undefined
  readonly #foregroundWaiters = new Set<() => void>()
  #storageTail: Promise<void> = Promise.resolve()
  #pollAfterSeconds: number | null = null

  constructor(options: UploadRunnerOptions) {
    this.#api = options.api
    this.#transport = options.transport
    this.#chunks = options.chunks
    this.#source = options.source
    this.#store = options.store
    this.#createIdempotencyKey = options.createIdempotencyKey
    this.#sleep = options.sleep
    this.#random = options.random
    this.#onStatus = options.onStatus
    this.#onProgress = options.onProgress
  }

  get currentUploadId(): string | null {
    return this.#currentRecord?.uploadId ?? null
  }

  get pollAfterSeconds(): number | null {
    return this.#pollAfterSeconds
  }

  async run(input: UploadRunnerFile): Promise<UploadRunnerResult> {
    if (this.#busy) throw new UploadRunnerBusyError()
    const file = snapshotFile(input)
    this.#busy = true
    this.#pauseRequested = false
    this.#pollAfterSeconds = null
    try {
      return await this.#runFresh(file)
    } finally {
      this.#finishOperation()
    }
  }

  async pause(): Promise<void> {
    this.#pauseGeneration += 1
    this.#pauseRequested = true
    const record = this.#currentRecord
    if (record === undefined) return
    record.paused = true
    const active = this.#active
    if (active !== undefined) active.paused = true
    await this.#persist(record)
    this.#emitStatus('paused', record)
  }

  resume(): Promise<UploadRunnerResumeResult> {
    if (this.#resumePromise !== undefined) return this.#resumePromise
    const operation = this.#busy ? this.#resumeCurrent() : this.#resumeCold()
    this.#resumePromise = operation
    void operation
      .finally(() => {
        if (this.#resumePromise === operation) this.#resumePromise = undefined
      })
      .catch(() => undefined)
    return operation
  }

  foreground(): Promise<void> {
    if (this.#foregroundPromise !== undefined) return this.#foregroundPromise
    const operation = this.#foregroundCurrent()
    this.#foregroundPromise = operation
    void operation
      .finally(() => {
        if (this.#foregroundPromise === operation) this.#foregroundPromise = undefined
      })
      .catch(() => undefined)
    return operation
  }

  async #foregroundCurrent(): Promise<void> {
    const record = this.#currentRecord
    if (record === undefined) {
      this.#pauseRequested = false
      this.#signalForeground()
      return
    }
    if (this.#active === undefined) {
      this.#pauseRequested = false
      record.paused = false
      await this.#persist(record)
      this.#signalForeground()
      return
    }
    await this.#resumeCurrent()
  }

  async #runFresh(file: UploadRunnerFile): Promise<UploadRunnerResult> {
    const record: MutableResumeRecord = {
      version: 1,
      phase: 'initializing',
      file,
      initializeIdempotencyKey: await this.#newIdempotencyKey(),
      uploadId: null,
      parts: [],
      confirmedBytes: 0,
      confirmedPartHashes: {},
      completeIdempotencyKey: null,
      abortIdempotencyKey: null,
      paused: this.#pauseRequested,
    }
    this.#currentRecord = record
    await this.#persist(record)
    this.#emitStatus('initializing', record)
    try {
      await this.#initialize(record)
    } catch (error) {
      const failure = asError(error)
      if (!shouldRetryUploadFailure(failure)) await this.#clearStore()
      this.#emitStatus('failed', record)
      throw failure
    }
    return this.#execute(record, record.parts)
  }

  async #initialize(record: MutableResumeRecord): Promise<void> {
    const request = toInitializeRequest(record.file)
    const initialized = snapshotInitialization(
      await retryWithFullJitter(
        async () => {
          await this.#waitUntilForeground()
          return this.#api.initializeUpload(request, record.initializeIdempotencyKey)
        },
        {
          ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
          ...(this.#random === undefined ? {} : { random: this.#random }),
        },
      ),
      record.file,
    )
    record.phase = 'uploading'
    record.uploadId = initialized.uploadId
    record.parts = initialized.parts
    record.paused = this.#pauseRequested
    await this.#persist(record)
  }

  async #execute(
    record: MutableResumeRecord,
    pendingParts: readonly UploadPartPlan[],
  ): Promise<UploadRunnerResult> {
    if (record.uploadId === null) throw new UploadRunnerResumeError()
    record.paused = this.#pauseRequested
    const active: ActiveUpload = {
      record,
      tracker: new UploadProgressTracker(record.file.sizeBytes, record.confirmedBytes),
      pending: pendingParts
        .map((part) => ({ ...part }))
        .sort((a, b) => a.partNumber - b.partNumber),
      inFlight: new Map(),
      retryAttempts: new Map(),
      parkedChunks: new Map(),
      waiters: new Set(),
      paused: record.paused,
      serverResult: undefined,
      terminalError: undefined,
    }
    this.#pollAfterSeconds = null
    this.#active = active
    this.#emitStatus(active.paused ? 'paused' : 'uploading', record)
    this.#emitProgress(active.tracker.snapshot(), record)
    try {
      for (;;) {
        const firstPartIndex = active.pending.findIndex((part) => part.partNumber === 1)
        if (firstPartIndex >= 0) {
          const [firstPart] = active.pending.splice(firstPartIndex, 1)
          if (firstPart === undefined) throw new UploadRunnerProtocolError()
          await this.#waitUntilSchedulable(active)
          const outcome = await this.#startPart(active, firstPart)
          active.inFlight.delete(firstPart.partNumber)
          this.#signal(active)
          if (outcome.state === 'failed') throw outcome.error
          if (outcome.state === 'paused') {
            await this.#waitUntilSchedulable(active)
            continue
          }
        }

        await this.#drainLaterParts(active)
        await this.#waitUntilSchedulable(active)
        if (active.serverResult !== undefined) {
          return await this.#settleResult(active.serverResult, record)
        }
        if (active.terminalError !== undefined) throw active.terminalError
        if (active.pending.length > 0) continue
        return await this.#complete(record)
      }
    } catch (error) {
      this.#emitStatus('failed', record)
      throw asError(error)
    } finally {
      await this.#discardParkedChunks(active)
      if (this.#active === active) this.#active = undefined
      this.#signal(active)
    }
  }

  async #drainLaterParts(active: ActiveUpload): Promise<void> {
    for (;;) {
      if (active.terminalError !== undefined) throw active.terminalError
      if (active.serverResult !== undefined) return
      if (active.pending.some((part) => part.partNumber === 1)) return

      while (!active.paused && active.inFlight.size < 2 && active.pending.length > 0) {
        const part = active.pending.shift()
        if (part !== undefined) void this.#startPart(active, part)
      }

      if (active.inFlight.size === 0) {
        if (active.pending.length === 0) return
        await this.#waitUntilSchedulable(active)
        continue
      }

      const outcome = await Promise.race(active.inFlight.values())
      active.inFlight.delete(outcome.partNumber)
      this.#signal(active)
      if (outcome.state !== 'failed') continue

      const firstError = outcome.error
      while (active.inFlight.size > 0) {
        const remaining = await Promise.race(active.inFlight.values())
        active.inFlight.delete(remaining.partNumber)
        this.#signal(active)
      }
      throw firstError
    }
  }

  #startPart(active: ActiveUpload, part: UploadPartPlan): Promise<PartOutcome> {
    const operation = this.#uploadPart(active, part).then(
      (state): PartOutcome => ({ partNumber: part.partNumber, state }),
      (error: unknown): PartOutcome => ({
        partNumber: part.partNumber,
        state: 'failed',
        error: asError(error),
      }),
    )
    active.inFlight.set(part.partNumber, operation)
    return operation
  }

  async #uploadPart(active: ActiveUpload, part: UploadPartPlan): Promise<'uploaded' | 'paused'> {
    const uploadId = active.record.uploadId
    if (uploadId === null) throw new UploadRunnerResumeError()
    let chunk = active.parkedChunks.get(part.partNumber)
    active.parkedChunks.delete(part.partNumber)
    let attempt = active.retryAttempts.get(part.partNumber) ?? 0
    try {
      for (;;) {
        if (active.paused) {
          if (chunk !== undefined) {
            active.parkedChunks.set(part.partNumber, chunk)
            chunk = undefined
          }
          return 'paused'
        }
        let uploaded:
          { readonly chunk: ChunkFile; readonly response: UploadPartResponse['data'] } | undefined
        try {
          chunk ??= await this.#chunks.create(active.record.file.sourcePath, part)
          const attemptChunk = chunk
          if (this.#activeIsPaused(active)) {
            active.parkedChunks.set(part.partNumber, attemptChunk)
            chunk = undefined
            return 'paused'
          }
          active.tracker.startPart(part.partNumber, part.sizeBytes)
          this.#emitProgress(active.tracker.snapshot(), active.record)
          let acceptingProgress = true
          try {
            const value = await this.#transport.uploadPart({
              uploadId,
              partNumber: part.partNumber,
              sha256: attemptChunk.sha256,
              chunkSizeBytes: part.sizeBytes,
              tempPath: attemptChunk.tempPath,
              onProgress: (event) => {
                if (!acceptingProgress) return
                try {
                  const progress = active.tracker.updatePart(part.partNumber, event.totalBytesSent)
                  this.#emitProgress(progress, active.record)
                } catch {
                  // Ignore malformed or late runtime callbacks.
                }
              },
            })
            acceptingProgress = false
            uploaded = {
              chunk: attemptChunk,
              response: snapshotPartResponse(
                value,
                part,
                attemptChunk,
                active.record.file.sizeBytes,
              ),
            }
          } catch (error) {
            acceptingProgress = false
            const progress = active.tracker.discardPart(part.partNumber)
            this.#emitProgress(progress, active.record)
            if (isPartChecksumMismatch(error)) {
              await this.#chunks.delete(attemptChunk)
              chunk = undefined
            }
            throw asError(error)
          }
        } catch (error) {
          const failure = asError(error)
          if (attempt >= MAX_UPLOAD_RETRIES || !shouldRetryUploadFailure(failure)) throw failure
          active.retryAttempts.set(part.partNumber, attempt + 1)
          await this.#sleepForRetry(attempt)
          attempt += 1
          continue
        }
        active.record.confirmedBytes = Math.max(
          active.record.confirmedBytes,
          uploaded.response.progress.confirmedBytes,
        )
        active.record.confirmedPartHashes[part.partNumber] = uploaded.chunk.sha256
        await this.#persist(active.record)
        const progress = active.tracker.confirmPart(
          part.partNumber,
          uploaded.response.progress.confirmedBytes,
        )
        this.#emitProgress(progress, active.record)
        active.retryAttempts.delete(part.partNumber)
        return 'uploaded'
      }
    } finally {
      if (chunk !== undefined) await this.#chunks.delete(chunk)
    }
  }

  async #complete(record: MutableResumeRecord): Promise<UploadRunnerResult> {
    const uploadId = record.uploadId
    if (uploadId === null) throw new UploadRunnerResumeError()
    const active = this.#active
    if (active === undefined) throw new UploadRunnerResumeError()
    if (record.completeIdempotencyKey === null) {
      record.completeIdempotencyKey = await this.#newIdempotencyKey()
      await this.#persist(record)
    }
    const idempotencyKey = record.completeIdempotencyKey
    const attempt = await retryWithFullJitter(
      async () => {
        await this.#waitUntilCompletionReady(active)
        if (active.terminalError !== undefined) throw active.terminalError
        if (active.serverResult !== undefined) {
          return { source: 'server' as const, result: active.serverResult }
        }
        return {
          source: 'api' as const,
          response: await this.#api.completeUpload(uploadId, idempotencyKey),
        }
      },
      {
        ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
        ...(this.#random === undefined ? {} : { random: this.#random }),
      },
    )
    if (attempt.source === 'server') return this.#settleResult(attempt.result, record)
    const response = attempt.response
    const candidate: unknown = response
    if (
      !isRecord(candidate) ||
      !isRecord(candidate['upload']) ||
      candidate['upload']['id'] !== uploadId ||
      (candidate['upload']['status'] !== 'finalizing' &&
        candidate['upload']['status'] !== 'uploaded')
    ) {
      throw new UploadRunnerProtocolError()
    }
    if (candidate['upload']['status'] === 'finalizing') {
      if (!validPollAfterSeconds(candidate['pollAfterSeconds'])) {
        throw new UploadRunnerProtocolError()
      }
      this.#pollAfterSeconds = candidate['pollAfterSeconds']
    } else {
      this.#pollAfterSeconds = null
    }
    return this.#settleResult(candidate['upload']['status'], record)
  }

  async #settleResult(
    result: UploadRunnerResult,
    record: MutableResumeRecord,
  ): Promise<UploadRunnerResult> {
    if (result === 'finalizing') {
      record.phase = 'finalizing'
      record.paused = false
      await this.#persist(record)
    } else {
      this.#pollAfterSeconds = null
      await this.#clearStore()
    }
    this.#emitStatus(result, record)
    return result
  }

  async #resumeCurrent(): Promise<UploadRunnerResumeResult> {
    const record = this.#currentRecord
    if (record === undefined) throw new UploadRunnerBusyError()
    const active = this.#active
    if (active === undefined) {
      this.#pauseRequested = false
      record.paused = false
      await this.#persist(record)
      this.#signalForeground()
      return copiedOutcome({ action: 'continued' })
    }

    this.#emitStatus('resuming', record)
    const pauseGeneration = this.#pauseGeneration
    active.paused = true
    record.paused = true
    await this.#waitUntilIdle(active)
    const uploadId = record.uploadId
    if (uploadId === null) throw new UploadRunnerResumeError()
    const detail = this.#snapshotDetail(await this.#api.getUpload(uploadId), record)
    this.#pollAfterSeconds = detail.pollAfterSeconds
    if (detail.status === 'finalizing' || detail.status === 'uploaded') {
      await this.#discardParkedChunks(active)
      if (detail.status === 'finalizing') record.phase = 'finalizing'
      active.serverResult = detail.status
      const pauseIsCurrent = this.#pauseGeneration === pauseGeneration
      active.paused = !pauseIsCurrent
      record.paused = !pauseIsCurrent
      if (pauseIsCurrent) this.#pauseRequested = false
      this.#signalForeground()
      this.#signal(active)
      return copiedOutcome({ action: 'continued' })
    }
    if (detail.status !== 'uploading') {
      await this.#discardParkedChunks(active)
      await this.#clearStore()
      active.terminalError = new UploadRunnerResumeError()
      const pauseIsCurrent = this.#pauseGeneration === pauseGeneration
      active.paused = !pauseIsCurrent
      if (pauseIsCurrent) this.#pauseRequested = false
      this.#signalForeground()
      this.#signal(active)
      return copiedOutcome({ action: 'continued' })
    }

    await this.#discardParkedChunks(active, detail.pending)
    this.#applyDetail(active, detail)
    if (this.#pauseGeneration !== pauseGeneration) {
      active.paused = true
      record.paused = true
      await this.#persist(record)
      return copiedOutcome({ action: 'continued' })
    }
    active.paused = false
    record.paused = false
    this.#pauseRequested = false
    await this.#persist(record)
    if (this.#pauseGeneration !== pauseGeneration) {
      return copiedOutcome({ action: 'continued' })
    }
    this.#emitStatus('uploading', record)
    this.#signalForeground()
    this.#signal(active)
    return copiedOutcome({ action: 'continued' })
  }

  async #resumeCold(): Promise<UploadRunnerResumeResult> {
    if (this.#busy) throw new UploadRunnerBusyError()
    this.#busy = true
    try {
      const stored = decodeStoredMetadata(await this.#loadStore())
      if (stored === undefined) {
        await this.#clearStore()
        return copiedOutcome({ action: 'none' })
      }
      this.#currentRecord = stored
      this.#emitStatus('resuming', stored)

      if (stored.phase === 'initializing') {
        if (!(await this.#pathReadable(stored.file.sourcePath))) {
          await this.#clearStore()
          this.#emitStatus('replace-required', stored)
          return copiedOutcome({ action: 'replace' })
        }
        await this.#initialize(stored)
        stored.paused = this.#pauseRequested
        await this.#persist(stored)
        const result = await this.#execute(stored, stored.parts)
        return copiedOutcome({ action: 'completed', result })
      }

      const uploadId = stored.uploadId
      if (uploadId === null) throw new UploadRunnerResumeError()
      const detail = this.#snapshotDetail(await this.#api.getUpload(uploadId), stored)
      this.#pollAfterSeconds = detail.pollAfterSeconds
      if (detail.status === 'finalizing' || detail.status === 'uploaded') {
        const result = await this.#settleResult(detail.status, stored)
        return copiedOutcome({ action: 'completed', result })
      }
      if (detail.status !== 'uploading') {
        await this.#clearStore()
        return copiedOutcome({ action: 'none' })
      }

      if (!(await this.#pathReadable(stored.file.sourcePath))) {
        return await this.#replace(stored)
      }
      if (!(await this.#confirmedHashesMatch(stored, detail.confirmedHashes))) {
        return await this.#replace(stored)
      }
      const wasFinalizing = stored.phase === 'finalizing'
      stored.phase = 'uploading'
      stored.confirmedBytes = detail.confirmedBytes
      stored.confirmedPartHashes = { ...detail.confirmedHashes }
      stored.paused = this.#pauseRequested
      if (wasFinalizing || detail.pending.length > 0) stored.completeIdempotencyKey = null
      await this.#persist(stored)
      const result = await this.#execute(stored, detail.pending)
      return copiedOutcome({ action: 'completed', result })
    } catch (error) {
      const record = this.#currentRecord
      if (record !== undefined) this.#emitStatus('failed', record)
      throw asError(error)
    } finally {
      this.#finishOperation()
    }
  }

  #snapshotDetail(
    value: UploadDetailResponse['data'],
    record: MutableResumeRecord,
  ): DetailSnapshot {
    const uploadId = record.uploadId
    const candidate: unknown = value
    if (
      uploadId === null ||
      !isRecord(candidate) ||
      !isRecord(candidate['upload']) ||
      candidate['upload']['id'] !== uploadId ||
      candidate['upload']['fileName'] !== record.file.fileName ||
      candidate['upload']['kind'] !== record.file.kind ||
      candidate['upload']['mimeType'] !== record.file.mimeType ||
      candidate['upload']['sizeBytes'] !== record.file.sizeBytes ||
      !validPublicStatus(candidate['upload']['status']) ||
      !isRecord(candidate['upload']['progress']) ||
      candidate['upload']['progress']['totalBytes'] !== record.file.sizeBytes ||
      !validByteCount(candidate['upload']['progress']['confirmedBytes'], record.file.sizeBytes) ||
      !Array.isArray(candidate['parts'])
    ) {
      throw new UploadRunnerProtocolError()
    }

    const status = candidate['upload']['status']
    const confirmedBytes = candidate['upload']['progress']['confirmedBytes']
    if (status !== 'uploading') {
      const pollAfterSeconds =
        status === 'finalizing' && validPollAfterSeconds(candidate['pollAfterSeconds'])
          ? candidate['pollAfterSeconds']
          : null
      if (status === 'finalizing' && pollAfterSeconds === null) {
        throw new UploadRunnerProtocolError()
      }
      return {
        status,
        confirmedBytes,
        pending: [],
        confirmedHashes: {},
        pollAfterSeconds,
      }
    }
    if (candidate['partDetailsRetained'] !== true) throw new UploadRunnerProtocolError()

    const plans = snapshotPlans(candidate['parts'], record.file.sizeBytes)
    const pending: UploadPartPlan[] = []
    const confirmedHashes: Record<number, string> = {}
    for (let index = 0; index < candidate['parts'].length; index += 1) {
      const detail: unknown = candidate['parts'][index]
      const plan = plans[index]
      if (detail === undefined || plan === undefined || !isRecord(detail)) {
        throw new UploadRunnerProtocolError()
      }
      if (detail['status'] === 'pending') {
        if (detail['sha256'] !== null) throw new UploadRunnerProtocolError()
        pending.push(plan)
      } else if (detail['status'] === 'uploaded' || detail['status'] === 'verified') {
        if (typeof detail['sha256'] !== 'string' || !SHA256.test(detail['sha256'])) {
          throw new UploadRunnerProtocolError()
        }
        confirmedHashes[plan.partNumber] = detail['sha256']
      } else {
        throw new UploadRunnerProtocolError()
      }
    }
    return {
      status,
      confirmedBytes,
      pending,
      confirmedHashes,
      pollAfterSeconds: null,
    }
  }

  #applyDetail(active: ActiveUpload, detail: DetailSnapshot): void {
    this.#pollAfterSeconds = null
    active.pending = detail.pending.map((part) => ({ ...part }))
    active.record.phase = 'uploading'
    active.record.confirmedBytes = detail.confirmedBytes
    active.record.confirmedPartHashes = { ...detail.confirmedHashes }
    const pendingNumbers = new Set(detail.pending.map((part) => part.partNumber))
    for (const partNumber of active.retryAttempts.keys()) {
      if (!pendingNumbers.has(partNumber)) active.retryAttempts.delete(partNumber)
    }
    if (detail.pending.length > 0) active.record.completeIdempotencyKey = null
    const progress = active.tracker.resetFromServer(detail.confirmedBytes)
    this.#emitProgress(progress, active.record)
  }

  async #confirmedHashesMatch(
    record: MutableResumeRecord,
    remoteHashes: Readonly<Record<number, string>>,
  ): Promise<boolean> {
    for (const [partNumberText, remoteHash] of Object.entries(remoteHashes)) {
      const partNumber = Number(partNumberText)
      const part = record.parts[partNumber - 1]
      if (part === undefined) return false
      let chunk: ChunkFile
      try {
        chunk = await this.#chunks.create(record.file.sourcePath, part)
      } catch {
        return false
      }
      try {
        if (chunk.sha256 !== remoteHash) return false
      } finally {
        await this.#chunks.delete(chunk)
      }
    }
    return true
  }

  async #replace(record: MutableResumeRecord): Promise<UploadRunnerResumeResult> {
    const uploadId = record.uploadId
    if (uploadId === null) {
      await this.#clearStore()
      this.#emitStatus('replace-required', record)
      return copiedOutcome({ action: 'replace' })
    }
    if (record.abortIdempotencyKey === null) {
      record.abortIdempotencyKey = await this.#newIdempotencyKey()
      await this.#persist(record)
    }
    const response = await this.#api.abortUpload(uploadId, 'replaced', record.abortIdempotencyKey)
    const candidate: unknown = response
    if (
      !isRecord(candidate) ||
      !isRecord(candidate['upload']) ||
      candidate['upload']['id'] !== uploadId ||
      candidate['upload']['status'] !== 'cancelling'
    ) {
      throw new UploadRunnerProtocolError()
    }
    await this.#clearStore()
    this.#emitStatus('replace-required', record)
    return copiedOutcome({ action: 'replace' })
  }

  async #pathReadable(path: string): Promise<boolean> {
    try {
      return await this.#source.isReadable(path)
    } catch {
      return false
    }
  }

  async #waitUntilSchedulable(active: ActiveUpload): Promise<void> {
    while (
      active.paused &&
      active.serverResult === undefined &&
      active.terminalError === undefined
    ) {
      await this.#waitForSignal(active)
    }
    if (active.terminalError !== undefined) throw active.terminalError
  }

  async #waitUntilIdle(active: ActiveUpload): Promise<void> {
    while (active.inFlight.size > 0) await this.#waitForSignal(active)
  }

  #activeIsPaused(active: ActiveUpload): boolean {
    return active.paused
  }

  async #waitUntilForeground(): Promise<void> {
    while (this.#pauseRequested) {
      await new Promise<void>((resolve) => {
        this.#foregroundWaiters.add(resolve)
      })
    }
  }

  async #waitUntilCompletionReady(active: ActiveUpload): Promise<void> {
    while (
      this.#pauseRequested &&
      active.serverResult === undefined &&
      active.terminalError === undefined
    ) {
      await new Promise<void>((resolve) => {
        this.#foregroundWaiters.add(resolve)
      })
    }
  }

  #signalForeground(): void {
    const waiters = [...this.#foregroundWaiters]
    this.#foregroundWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  async #sleepForRetry(retryIndex: number): Promise<void> {
    const delayMs = fullJitterDelayMs(retryIndex, this.#random)
    if (this.#sleep !== undefined) {
      await this.#sleep(delayMs)
      return
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs)
    })
  }

  async #discardParkedChunks(
    active: ActiveUpload,
    retainedParts: readonly UploadPartPlan[] = [],
  ): Promise<void> {
    const retainedNumbers = new Set(retainedParts.map((part) => part.partNumber))
    for (const [partNumber, chunk] of active.parkedChunks) {
      if (retainedNumbers.has(partNumber)) continue
      active.parkedChunks.delete(partNumber)
      await this.#chunks.delete(chunk)
    }
  }

  #waitForSignal(active: ActiveUpload): Promise<void> {
    return new Promise((resolve) => {
      active.waiters.add(resolve)
    })
  }

  #signal(active: ActiveUpload): void {
    const waiters = [...active.waiters]
    active.waiters.clear()
    for (const resolve of waiters) resolve()
  }

  async #newIdempotencyKey(): Promise<string> {
    const key = await this.#createIdempotencyKey()
    if (!UUID_V7.test(key)) throw new TypeError('Idempotency key must be a UUIDv7')
    return key
  }

  #emitStatus(status: UploadRunnerStatus, record: MutableResumeRecord): void {
    try {
      this.#onStatus?.(
        Object.freeze({
          status,
          uploadId: record.uploadId,
          sourcePath: record.file.sourcePath,
          fileName: record.file.fileName,
        }),
      )
    } catch {
      // UI callbacks cannot change upload state.
    }
  }

  #emitProgress(progress: UploadProgress, record: MutableResumeRecord): void {
    if (record.uploadId === null) return
    try {
      this.#onProgress?.(
        Object.freeze({
          ...progress,
          uploadId: record.uploadId,
          sourcePath: record.file.sourcePath,
          fileName: record.file.fileName,
        }),
      )
    } catch {
      // UI callbacks cannot change upload state.
    }
  }

  #persist(record: MutableResumeRecord): Promise<void> {
    const snapshot = metadataSnapshot(record)
    return this.#queueStorage(() => this.#store.save(snapshot))
  }

  #clearStore(): Promise<void> {
    return this.#queueStorage(() => this.#store.clear())
  }

  async #loadStore(): Promise<unknown> {
    await this.#storageTail
    return this.#store.load()
  }

  #queueStorage(operation: () => MaybePromise<void>): Promise<void> {
    const queued = this.#storageTail.catch(() => undefined).then(operation)
    this.#storageTail = queued.catch(() => undefined)
    return queued
  }

  #finishOperation(): void {
    this.#busy = false
    this.#pauseRequested = false
    this.#currentRecord = undefined
    const active = this.#active
    this.#active = undefined
    if (active !== undefined) this.#signal(active)
  }
}
