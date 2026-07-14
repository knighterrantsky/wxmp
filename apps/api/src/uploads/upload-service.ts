import { createHash } from 'node:crypto'
import { finished } from 'node:stream/promises'

import {
  type AbortUploadResponse,
  type CompleteUploadResponse,
  PART_SIZE_BYTES,
  planUploadParts,
  type InitializeUploadRequest,
  type InitializeUploadResponse,
  type UploadDetailResponse,
  type UploadPartResponse,
} from '@wx-upload/contracts'

import { ApiError } from '../http/errors.js'
import type { Clock } from '../lib/clock.js'
import type { IdGenerator } from '../lib/id.js'
import { FILE_SIGNATURE_PREFIX_BYTES, validateFileSignature } from './file-signature.js'
import { validateMediaPolicy } from './media-policy.js'
import { ObjectStorageError, type ObjectStorage } from './object-storage.js'
import { buildObjectKey } from './object-key.js'
import { inspectChunk } from './chunk-stream.js'
import type { InitializeUploadDraft, UploadRepository } from './upload-repository.js'
import type {
  AbortUploadRouteInput,
  CompleteUploadRouteInput,
  GetUploadDetailInput,
  InitializeUploadInput,
  UploadPartInput,
  UploadRouteService,
} from './upload-routes.js'

const UPLOAD_SESSION_MS = 24 * 60 * 60 * 1_000
const INITIALIZATION_LEASE_MS = 60 * 1_000
const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const CREATE_MULTIPART_TIMEOUT_MS = 8_000
const UPLOAD_PART_TIMEOUT_MS = 150_000
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/u

function publicError(
  code:
    | 'IDEMPOTENCY_KEY_REUSED'
    | 'IDEMPOTENCY_IN_PROGRESS'
    | 'STORAGE_UNAVAILABLE'
    | 'VALIDATION_ERROR',
  statusCode: number,
  retryable = false,
  idempotencyReplayed = false,
): ApiError {
  return new ApiError({
    code,
    message: code,
    statusCode,
    retryable,
    idempotencyReplayed,
  })
}

function requestHash(request: InitializeUploadRequest): Buffer {
  return createHash('sha256')
    .update(
      JSON.stringify({
        fileName: request.fileName,
        kind: request.kind,
        mimeType: request.mimeType,
        sizeBytes: request.sizeBytes,
      }),
      'utf8',
    )
    .digest()
}

export interface UploadPartLease {
  release(): Promise<void>
}

export interface PartUploadConcurrency {
  acquirePart(input: {
    uploadId: string
    partNumber: number
    userId: string
  }): Promise<UploadPartLease>
}

export interface ExclusiveUploadConcurrency {
  acquireExclusiveUpload(input: { uploadId: string; waitMs?: number }): Promise<UploadPartLease>
}

async function drain(stream: UploadPartInput['chunk']): Promise<void> {
  if (stream.destroyed || stream.readableEnded) return
  stream.resume()
  await finished(stream).catch(() => undefined)
}

function partStorageError(error: unknown): ApiError | undefined {
  if (!(error instanceof ObjectStorageError)) return undefined
  if (error.code === 'TIMEOUT') {
    return new ApiError({
      code: 'UPSTREAM_TIMEOUT',
      message: 'UPSTREAM_TIMEOUT',
      retryable: true,
      statusCode: 504,
    })
  }
  return new ApiError({
    code: 'STORAGE_UNAVAILABLE',
    message: 'STORAGE_UNAVAILABLE',
    retryable: true,
    statusCode: 503,
  })
}

function partLengthError(): ApiError {
  return new ApiError({
    code: 'PART_LENGTH_MISMATCH',
    message: 'PART_LENGTH_MISMATCH',
    statusCode: 422,
  })
}

function settled<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then(
    (value): PromiseSettledResult<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): PromiseSettledResult<T> => ({ status: 'rejected', reason }),
  )
}

function uploadData(input: {
  uploadId: string
  mediaId: string
  request: InitializeUploadRequest
  parts: ReturnType<typeof planUploadParts>
  createdAt: Date
  expiresAt: Date
}): InitializeUploadResponse['data'] {
  const common = {
    id: input.uploadId,
    mediaId: input.mediaId,
    status: 'uploading' as const,
    fileName: input.request.fileName,
    sizeBytes: input.request.sizeBytes,
    partSizeBytes: PART_SIZE_BYTES,
    partCount: input.parts.length,
    expiresAt: input.expiresAt.toISOString(),
    createdAt: input.createdAt.toISOString(),
  } as const
  const upload =
    input.request.kind === 'image'
      ? {
          ...common,
          kind: input.request.kind,
          mimeType: input.request.mimeType,
        }
      : {
          ...common,
          kind: input.request.kind,
          mimeType: input.request.mimeType,
        }
  return {
    upload,
    parts: input.parts.map((part) => ({ ...part, status: 'pending' as const })),
  }
}

export class UploadService implements UploadRouteService {
  readonly #bucket: string
  readonly #clock: Clock
  readonly #ids: IdGenerator
  readonly #repository: UploadRepository
  readonly #storage: ObjectStorage
  readonly #concurrency: PartUploadConcurrency
  readonly #exclusiveConcurrency: ExclusiveUploadConcurrency | undefined
  readonly #createMultipartTimeoutMs: number
  readonly #uploadPartTimeoutMs: number

  constructor(deps: {
    bucket: string
    clock: Clock
    ids: IdGenerator
    repository: UploadRepository
    storage: ObjectStorage
    concurrency: PartUploadConcurrency
    exclusiveConcurrency?: ExclusiveUploadConcurrency
    createMultipartTimeoutMs?: number
    uploadPartTimeoutMs?: number
  }) {
    this.#bucket = deps.bucket
    this.#clock = deps.clock
    this.#ids = deps.ids
    this.#repository = deps.repository
    this.#storage = deps.storage
    this.#concurrency = deps.concurrency
    this.#exclusiveConcurrency = deps.exclusiveConcurrency
    this.#createMultipartTimeoutMs = deps.createMultipartTimeoutMs ?? CREATE_MULTIPART_TIMEOUT_MS
    this.#uploadPartTimeoutMs = deps.uploadPartTimeoutMs ?? UPLOAD_PART_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.#createMultipartTimeoutMs) ||
      this.#createMultipartTimeoutMs < 1 ||
      this.#createMultipartTimeoutMs >= INITIALIZATION_LEASE_MS
    ) {
      throw new RangeError('create multipart timeout must be shorter than the initialization lease')
    }
    if (!Number.isSafeInteger(this.#uploadPartTimeoutMs) || this.#uploadPartTimeoutMs < 1) {
      throw new RangeError('upload part timeout must be a positive integer')
    }
  }

  async initialize(input: InitializeUploadInput): Promise<{
    data: InitializeUploadResponse['data']
    replayed: boolean
  }> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
      throw publicError('VALIDATION_ERROR', 422)
    }

    const policy = validateMediaPolicy(input.request)
    const normalizedRequest = policy.request
    const createdAt = this.#clock.now()
    const expiresAt = new Date(createdAt.getTime() + UPLOAD_SESSION_MS)
    const mediaId = this.#ids.next()
    const uploadId = this.#ids.next()
    const parts = planUploadParts(normalizedRequest.sizeBytes)
    const data = uploadData({
      uploadId,
      mediaId,
      request: normalizedRequest,
      parts,
      createdAt,
      expiresAt,
    })
    const draft: InitializeUploadDraft = {
      userId: input.userId,
      sessionId: input.sessionId,
      idempotencyKey: input.idempotencyKey,
      requestHash: requestHash(normalizedRequest),
      mediaId,
      uploadId,
      bucket: this.#bucket,
      objectKey: buildObjectKey({
        userId: input.userId,
        mediaId,
        kind: normalizedRequest.kind,
        extension: policy.canonicalExtension,
        now: createdAt,
      }),
      fileName: normalizedRequest.fileName,
      kind: normalizedRequest.kind,
      mimeType: normalizedRequest.mimeType,
      sizeBytes: normalizedRequest.sizeBytes,
      canonicalExtension: policy.canonicalExtension,
      parts,
      createdAt,
      expiresAt,
      lockedUntil: new Date(createdAt.getTime() + INITIALIZATION_LEASE_MS),
      idempotencyExpiresAt: new Date(createdAt.getTime() + IDEMPOTENCY_RETENTION_MS),
      context: input.context,
      data,
    }

    const beginning = await this.#repository.beginInitialization(draft)
    if (beginning.kind === 'replay_success') {
      return { data: beginning.data, replayed: true }
    }
    if (beginning.kind === 'replay_failure') {
      throw publicError(beginning.code, beginning.statusCode, beginning.retryable, true)
    }
    if (beginning.kind === 'key_reused') {
      throw publicError('IDEMPOTENCY_KEY_REUSED', 409)
    }
    if (beginning.kind === 'in_progress') {
      throw publicError('IDEMPOTENCY_IN_PROGRESS', 409, true)
    }

    if (this.#exclusiveConcurrency === undefined) {
      throw new ApiError({
        code: 'INTERNAL_ERROR',
        message: 'INTERNAL_ERROR',
        retryable: true,
        statusCode: 500,
      })
    }
    let initializationLease: UploadPartLease
    try {
      initializationLease = await this.#exclusiveConcurrency.acquireExclusiveUpload({
        uploadId: draft.uploadId,
        waitMs: 8_000,
      })
    } catch {
      throw publicError('STORAGE_UNAVAILABLE', 503, true)
    }

    try {
      let r2UploadId: string
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        controller.abort()
      }, this.#createMultipartTimeoutMs)
      timeout.unref()
      try {
        const created = await this.#storage.createMultipart({
          bucket: draft.bucket,
          key: draft.objectKey,
          contentType: draft.mimeType,
          metadata: { mediaid: draft.mediaId, userid: draft.userId },
          signal: controller.signal,
        })
        r2UploadId = created.uploadId
      } catch (error) {
        if (error instanceof ObjectStorageError && error.certainty === 'definite') {
          try {
            await this.#repository.failInitialization({
              draft,
              fence: beginning.fence,
              code: 'STORAGE_UNAVAILABLE',
            })
          } catch {
            // The first transaction remains the source of truth. Reconciliation will
            // settle this linked initiating session if the failure transaction did not commit.
          }
        }
        throw publicError('STORAGE_UNAVAILABLE', 503, true)
      } finally {
        clearTimeout(timeout)
      }

      try {
        await this.#repository.completeInitialization({
          draft,
          r2UploadId,
          fence: beginning.fence,
        })
      } catch (error) {
        if (
          error instanceof ApiError &&
          (error.code === 'USER_DISABLED' || error.code === 'UNAUTHORIZED')
        ) {
          throw error
        }
        throw publicError('STORAGE_UNAVAILABLE', 503, true)
      }
      return { data, replayed: false }
    } finally {
      await initializationLease.release()
    }
  }

  async complete(input: CompleteUploadRouteInput): Promise<{
    data: CompleteUploadResponse['data']
    replayed: boolean
  }> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
      throw publicError('VALIDATION_ERROR', 422)
    }
    if (this.#exclusiveConcurrency === undefined) {
      throw new ApiError({
        code: 'INTERNAL_ERROR',
        message: 'INTERNAL_ERROR',
        retryable: true,
        statusCode: 500,
      })
    }
    const lease = await this.#exclusiveConcurrency.acquireExclusiveUpload({
      uploadId: input.uploadId,
      waitMs: 8_000,
    })
    try {
      const result = await this.#repository.completeUpload({
        ...input,
        requestHash: createHash('sha256')
          .update(JSON.stringify({ uploadId: input.uploadId }), 'utf8')
          .digest(),
      })
      if (result.kind === 'expired') {
        throw new ApiError({
          code: 'UPLOAD_EXPIRED',
          message: 'UPLOAD_EXPIRED',
          idempotencyReplayed: result.replayed,
          statusCode: 410,
        })
      }
      return { data: result.data, replayed: result.replayed }
    } finally {
      await lease.release()
    }
  }

  async abort(input: AbortUploadRouteInput): Promise<{
    data: AbortUploadResponse['data']
    replayed: boolean
  }> {
    if (!IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)) {
      throw publicError('VALIDATION_ERROR', 422)
    }
    if (this.#exclusiveConcurrency === undefined) {
      throw new ApiError({
        code: 'INTERNAL_ERROR',
        message: 'INTERNAL_ERROR',
        retryable: true,
        statusCode: 500,
      })
    }
    const lease = await this.#exclusiveConcurrency.acquireExclusiveUpload({
      uploadId: input.uploadId,
      waitMs: 8_000,
    })
    try {
      return await this.#repository.abortUpload({
        ...input,
        requestHash: createHash('sha256')
          .update(JSON.stringify({ uploadId: input.uploadId, reason: input.reason }), 'utf8')
          .digest(),
      })
    } finally {
      await lease.release()
    }
  }

  async uploadPart(input: UploadPartInput): Promise<UploadPartResponse['data']> {
    let lease: UploadPartLease
    try {
      await this.#repository.assertPartOwnership({
        userId: input.userId,
        uploadId: input.uploadId,
      })
      lease = await this.#concurrency.acquirePart({
        uploadId: input.uploadId,
        partNumber: input.partNumber,
        userId: input.userId,
      })
    } catch (error) {
      await drain(input.chunk)
      throw error
    }
    let ownsStream = false
    try {
      const prepared = await this.#repository.preparePart({
        userId: input.userId,
        uploadId: input.uploadId,
        partNumber: input.partNumber,
        expectedSha256: Buffer.from(input.expectedSha256, 'hex'),
        context: {
          ...input.context,
          sessionId: input.sessionId,
        },
      })
      if (prepared.kind === 'replay') {
        const inspected = inspectChunk(input.chunk, {
          expectedBytes: prepared.data.part.sizeBytes,
          expectedSha256: input.expectedSha256,
          capturePrefixBytes: 0,
        })
        const multipart = input.multipart.then((value) => {
          if (value.chunkSizeBytes !== prepared.data.part.sizeBytes) throw partLengthError()
          return value
        })
        ownsStream = true
        const [, inspectionOutcome, multipartOutcome] = await Promise.all([
          settled(drain(inspected.stream)),
          settled(inspected.completed),
          settled(multipart),
        ])
        if (multipartOutcome.status === 'rejected') throw multipartOutcome.reason
        if (inspectionOutcome.status === 'rejected') throw inspectionOutcome.reason
        return prepared.data
      }

      const inspected = inspectChunk(input.chunk, {
        expectedBytes: prepared.part.expectedSizeBytes,
        expectedSha256: input.expectedSha256,
        capturePrefixBytes: FILE_SIGNATURE_PREFIX_BYTES,
      })
      ownsStream = true
      const controller = new AbortController()
      const timeout = setTimeout(() => {
        controller.abort()
      }, this.#uploadPartTimeoutMs)
      timeout.unref()
      const inspection = inspected.completed.then(async (value) => {
        if (prepared.part.partNumber === 1) {
          const signature = validateFileSignature(
            value.prefix,
            {
              mimeType: prepared.part.mimeType,
              canonicalExtension: prepared.part.canonicalExtension,
            },
            prepared.part.expectedTotalBytes,
          )
          if (!signature.ok) {
            controller.abort()
            const failureCode =
              signature.reason === 'TRUNCATED' ? 'FILE_TOO_SMALL' : 'MIME_MISMATCH'
            try {
              await this.#repository.scheduleValidationAbort({
                prepared: prepared.part,
                failureCode,
                context: {
                  ...input.context,
                  sessionId: input.sessionId,
                },
              })
            } catch {
              throw new ApiError({
                code: 'INTERNAL_ERROR',
                message: 'INTERNAL_ERROR',
                retryable: true,
                statusCode: 500,
              })
            }
            throw new ApiError({
              code: failureCode,
              message: failureCode,
              statusCode: failureCode === 'FILE_TOO_SMALL' ? 422 : 415,
            })
          }
        }
        return value
      })
      const multipart = input.multipart.then((value) => {
        if (value.chunkSizeBytes !== prepared.part.expectedSizeBytes) throw partLengthError()
        return value
      })
      void inspection.catch(() => {
        controller.abort()
      })
      void multipart.catch(() => {
        controller.abort()
      })
      const storagePromise = Promise.resolve().then(() =>
        this.#storage.uploadPart({
          bucket: prepared.part.bucket,
          key: prepared.part.objectKey,
          uploadId: prepared.part.r2UploadId,
          partNumber: prepared.part.partNumber,
          contentLength: prepared.part.expectedSizeBytes,
          body: inspected.stream,
          signal: controller.signal,
        }),
      )
      void storagePromise.catch(() => {
        // An upstream may reject before consuming the request body. Keep draining
        // through the inspector so Busboy can reach trailing form fields and the
        // route can return a structured retryable error without buffering the part.
        if (!inspected.stream.destroyed) inspected.stream.resume()
      })
      let outcomes: [
        PromiseSettledResult<Awaited<typeof storagePromise>>,
        PromiseSettledResult<Awaited<typeof inspection>>,
        PromiseSettledResult<Awaited<typeof multipart>>,
      ]
      try {
        outcomes = await Promise.all([
          settled(storagePromise),
          settled(inspection),
          settled(multipart),
        ])
      } finally {
        clearTimeout(timeout)
      }
      const [uploadedOutcome, inspectionOutcome, multipartOutcome] = outcomes
      if (multipartOutcome.status === 'rejected' && multipartOutcome.reason instanceof ApiError) {
        throw multipartOutcome.reason
      }
      if (inspectionOutcome.status === 'rejected' && inspectionOutcome.reason instanceof ApiError) {
        throw inspectionOutcome.reason
      }
      if (uploadedOutcome.status === 'rejected') {
        throw partStorageError(uploadedOutcome.reason) ?? uploadedOutcome.reason
      }
      if (multipartOutcome.status === 'rejected') throw multipartOutcome.reason
      if (inspectionOutcome.status === 'rejected') throw inspectionOutcome.reason
      const uploaded = uploadedOutcome.value
      const inspectedChunk = inspectionOutcome.value

      return await this.#repository.confirmPart({
        prepared: prepared.part,
        actualSizeBytes: inspectedChunk.actualBytes,
        checksumSha256: Buffer.from(inspectedChunk.sha256, 'hex'),
        etag: uploaded.etag,
        context: {
          ...input.context,
          sessionId: input.sessionId,
        },
      })
    } finally {
      if (!ownsStream) await drain(input.chunk)
      await lease.release()
    }
  }

  getDetail(input: GetUploadDetailInput): Promise<UploadDetailResponse['data']> {
    return this.#repository.getDetail({ userId: input.userId, uploadId: input.uploadId })
  }
}
