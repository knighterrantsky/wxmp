import { createHash } from 'node:crypto'

import {
  PART_SIZE_BYTES,
  planUploadParts,
  type InitializeUploadRequest,
  type InitializeUploadResponse,
} from '@wx-upload/contracts'

import { ApiError } from '../http/errors.js'
import type { Clock } from '../lib/clock.js'
import type { IdGenerator } from '../lib/id.js'
import { validateMediaPolicy } from './media-policy.js'
import { ObjectStorageError, type ObjectStorage } from './object-storage.js'
import { buildObjectKey } from './object-key.js'
import type { InitializeUploadDraft, UploadRepository } from './upload-repository.js'
import type { InitializeUploadInput, UploadRouteService } from './upload-routes.js'

const UPLOAD_SESSION_MS = 24 * 60 * 60 * 1_000
const INITIALIZATION_LEASE_MS = 60 * 1_000
const IDEMPOTENCY_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
const CREATE_MULTIPART_TIMEOUT_MS = 8_000
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
  readonly #createMultipartTimeoutMs: number

  constructor(deps: {
    bucket: string
    clock: Clock
    ids: IdGenerator
    repository: UploadRepository
    storage: ObjectStorage
    createMultipartTimeoutMs?: number
  }) {
    this.#bucket = deps.bucket
    this.#clock = deps.clock
    this.#ids = deps.ids
    this.#repository = deps.repository
    this.#storage = deps.storage
    this.#createMultipartTimeoutMs = deps.createMultipartTimeoutMs ?? CREATE_MULTIPART_TIMEOUT_MS
    if (
      !Number.isSafeInteger(this.#createMultipartTimeoutMs) ||
      this.#createMultipartTimeoutMs < 1 ||
      this.#createMultipartTimeoutMs >= INITIALIZATION_LEASE_MS
    ) {
      throw new RangeError('create multipart timeout must be shorter than the initialization lease')
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
          await this.#repository.failInitialization({ draft, code: 'STORAGE_UNAVAILABLE' })
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
      await this.#repository.completeInitialization({ draft, r2UploadId })
    } catch {
      throw publicError('STORAGE_UNAVAILABLE', 503, true)
    }
    return { data, replayed: false }
  }
}
