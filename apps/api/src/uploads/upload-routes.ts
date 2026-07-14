import type { Readable } from 'node:stream'

import multipart from '@fastify/multipart'
import {
  InitializeUploadResponseSchema,
  PART_SIZE_BYTES,
  UploadDetailResponseSchema,
  UploadPartParamsSchema,
  UploadPartResponseSchema,
  UploadPathParamsSchema,
  type InitializeUploadResponse,
  type UploadDetailResponse,
  type UploadPartResponse,
} from '@wx-upload/contracts'
import type { FastifyInstance } from 'fastify'

import {
  authenticatedRequestIdentity,
  createAccessTokenPreHandler,
  requestAuthContext,
  type AccessTokenVerifier,
} from '../auth/auth-routes.js'
import { sendData } from '../http/envelope.js'
import { ApiError } from '../http/errors.js'
import { rateLimitPolicy } from '../http/security.js'
import type { InitializeUploadCandidate } from './media-policy.js'

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{16,128}$/u
const InitializeUploadCandidateSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['fileName', 'kind', 'mimeType', 'sizeBytes'],
  properties: {
    fileName: { type: 'string', maxLength: 1_024 },
    kind: { enum: ['image', 'video'] },
    mimeType: { type: 'string', minLength: 1, maxLength: 127 },
    sizeBytes: {
      type: 'integer',
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
    },
  },
} as const

export interface InitializeUploadInput {
  userId: string
  sessionId: string
  request: InitializeUploadCandidate
  idempotencyKey: string
  context: {
    requestId: string
    sourceIp: string
    userAgent?: string
  }
}

export interface UploadPartInput {
  userId: string
  sessionId: string
  uploadId: string
  partNumber: number
  expectedSha256: string
  chunk: Readable
  multipart: Promise<{ chunkSizeBytes: number }>
  context: {
    requestId: string
    sourceIp: string
    userAgent?: string
  }
}

export interface GetUploadDetailInput {
  userId: string
  uploadId: string
}

export interface UploadRouteService {
  initialize(input: InitializeUploadInput): Promise<{
    data: InitializeUploadResponse['data']
    replayed: boolean
  }>
  uploadPart(input: UploadPartInput): Promise<UploadPartResponse['data']>
  getDetail(input: GetUploadDetailInput): Promise<UploadDetailResponse['data']>
}

interface UploadPartParams {
  uploadId: string
  partNumber: number
}

interface UploadPathParams {
  uploadId: string
}

interface DeferredMultipart {
  promise: Promise<{ chunkSizeBytes: number }>
  resolve(value: { chunkSizeBytes: number }): void
  reject(error: unknown): void
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const DECIMAL_SIZE_PATTERN = /^(?:0|[1-9][0-9]{0,7})$/u
const PART_ROUTE_BODY_LIMIT = PART_SIZE_BYTES + 128 * 1_024
const MULTIPART_FIELD_NAME_BYTES = 64
const MULTIPART_FILENAME_BYTES = 255
// @fastify/multipart forwards Busboy's headerSize at runtime, although its
// public Limits type currently omits that supported option.
const PART_MULTIPART_LIMITS = {
  fileSize: PART_SIZE_BYTES,
  files: 1,
  fields: 1,
  parts: 2,
  fieldNameSize: MULTIPART_FIELD_NAME_BYTES,
  fieldSize: 64,
  headerPairs: 16,
  headerSize: 4_096,
} as const

function validationError(): ApiError {
  return new ApiError({
    code: 'VALIDATION_ERROR',
    message: '请求参数无效',
    statusCode: 422,
  })
}

function deferredMultipart(): DeferredMultipart {
  let resolve!: DeferredMultipart['resolve']
  let reject!: DeferredMultipart['reject']
  const promise = new Promise<{ chunkSizeBytes: number }>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}

function chunkSha256(header: string | string[] | undefined): string {
  if (typeof header !== 'string' || !SHA256_PATTERN.test(header)) throw validationError()
  return header
}

function chunkSize(value: unknown): number {
  if (typeof value !== 'string' || !DECIMAL_SIZE_PATTERN.test(value)) throw validationError()
  const size = Number(value)
  if (!Number.isSafeInteger(size) || size < 1 || size > PART_SIZE_BYTES) {
    throw validationError()
  }
  return size
}

function validMultipartFieldName(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') <= MULTIPART_FIELD_NAME_BYTES
}

function validMultipartFilename(value: string): boolean {
  return Buffer.byteLength(value, 'utf8') <= MULTIPART_FILENAME_BYTES
}

function multipartError(app: FastifyInstance, error: unknown): Error {
  if (error instanceof app.multipartErrors.RequestFileTooLargeError) {
    return new ApiError({
      code: 'PART_TOO_LARGE',
      message: '上传分片超过允许大小',
      statusCode: 413,
    })
  }
  if (
    error instanceof app.multipartErrors.PartsLimitError ||
    error instanceof app.multipartErrors.FilesLimitError ||
    error instanceof app.multipartErrors.FieldsLimitError ||
    error instanceof app.multipartErrors.PrototypeViolationError ||
    error instanceof app.multipartErrors.InvalidMultipartContentTypeError
  ) {
    return validationError()
  }
  return error instanceof Error ? error : validationError()
}

function publicInitializeData(
  data: InitializeUploadResponse['data'],
): InitializeUploadResponse['data'] {
  const upload = data.upload
  const common = {
    id: upload.id,
    mediaId: upload.mediaId,
    status: upload.status,
    fileName: upload.fileName,
    sizeBytes: upload.sizeBytes,
    partSizeBytes: upload.partSizeBytes,
    partCount: upload.partCount,
    expiresAt: upload.expiresAt,
    createdAt: upload.createdAt,
  }
  const publicUpload =
    upload.kind === 'image'
      ? { ...common, kind: upload.kind, mimeType: upload.mimeType }
      : { ...common, kind: upload.kind, mimeType: upload.mimeType }
  return {
    upload: publicUpload,
    parts: data.parts.map((part) => ({
      partNumber: part.partNumber,
      offsetBytes: part.offsetBytes,
      sizeBytes: part.sizeBytes,
      status: part.status,
    })),
  }
}

function publicPartData(data: UploadPartResponse['data']): UploadPartResponse['data'] {
  return {
    part: {
      partNumber: data.part.partNumber,
      sizeBytes: data.part.sizeBytes,
      sha256: data.part.sha256,
      status: data.part.status,
      uploadedAt: data.part.uploadedAt,
    },
    progress: {
      confirmedBytes: data.progress.confirmedBytes,
      totalBytes: data.progress.totalBytes,
      uploadedParts: data.progress.uploadedParts,
      totalParts: data.progress.totalParts,
      percent: data.progress.percent,
    },
    replayed: data.replayed,
  }
}

function publicDetailData(data: UploadDetailResponse['data']): UploadDetailResponse['data'] {
  const upload = data.upload
  const common = {
    id: upload.id,
    mediaId: upload.mediaId,
    status: upload.status,
    fileName: upload.fileName,
    sizeBytes: upload.sizeBytes,
    progress: {
      confirmedBytes: upload.progress.confirmedBytes,
      totalBytes: upload.progress.totalBytes,
      uploadedParts: upload.progress.uploadedParts,
      totalParts: upload.progress.totalParts,
      percent: upload.progress.percent,
    },
    expiresAt: upload.expiresAt,
    failure: upload.failure,
    createdAt: upload.createdAt,
    updatedAt: upload.updatedAt,
  }
  return {
    upload:
      upload.kind === 'image'
        ? { ...common, kind: upload.kind, mimeType: upload.mimeType }
        : { ...common, kind: upload.kind, mimeType: upload.mimeType },
    partDetailsRetained: data.partDetailsRetained,
    partsAvailableUntil: data.partsAvailableUntil,
    parts: data.parts.map((part) => ({
      partNumber: part.partNumber,
      offsetBytes: part.offsetBytes,
      sizeBytes: part.sizeBytes,
      status: part.status,
      sha256: part.sha256,
    })),
    pollAfterSeconds: data.pollAfterSeconds,
  }
}

function idempotencyKey(header: string | string[] | undefined): string {
  if (header === undefined) {
    throw new ApiError({
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      message: '缺少幂等 Key',
      statusCode: 400,
    })
  }
  if (typeof header !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(header)) {
    throw new ApiError({
      code: 'VALIDATION_ERROR',
      message: '幂等 Key 格式无效',
      statusCode: 422,
    })
  }
  return header
}

export function registerUploadRoutes(
  app: FastifyInstance,
  deps: { uploads: UploadRouteService; tokens: AccessTokenVerifier },
): void {
  const authenticate = createAccessTokenPreHandler(deps.tokens)

  app.post<{ Body: InitializeUploadCandidate }>(
    '/v1/uploads',
    {
      config: { rateLimit: rateLimitPolicy('initialize') },
      preHandler: authenticate,
      schema: {
        body: InitializeUploadCandidateSchema,
        response: { 201: InitializeUploadResponseSchema },
      },
    },
    async (request, reply) => {
      const identity = authenticatedRequestIdentity(request)
      try {
        const result = await deps.uploads.initialize({
          ...identity,
          request: request.body,
          idempotencyKey: idempotencyKey(request.headers['idempotency-key']),
          context: requestAuthContext(request),
        })
        if (result.replayed) reply.header('Idempotency-Replayed', 'true')
        return await sendData(reply, publicInitializeData(result.data), 201)
      } catch (error) {
        if (error instanceof ApiError && error.idempotencyReplayed) {
          reply.header('Idempotency-Replayed', 'true')
        }
        if (error instanceof ApiError && error.code === 'IDEMPOTENCY_IN_PROGRESS') {
          reply.header('Retry-After', '1')
        }
        throw error
      }
    },
  )

  app.get<{ Params: UploadPathParams }>(
    '/v1/uploads/:uploadId',
    {
      config: { rateLimit: rateLimitPolicy('ordinary') },
      preHandler: authenticate,
      schema: {
        params: UploadPathParamsSchema,
        response: { 200: UploadDetailResponseSchema },
      },
    },
    async (request, reply) => {
      const identity = authenticatedRequestIdentity(request)
      const data = await deps.uploads.getDetail({
        userId: identity.userId,
        uploadId: request.params.uploadId,
      })
      return sendData(reply, publicDetailData(data))
    },
  )

  app.register(async (partApp) => {
    await partApp.register(multipart, {
      throwFileSizeLimit: true,
      limits: PART_MULTIPART_LIMITS,
    })
    partApp.addHook('onError', async (request, reply) => {
      if (!reply.raw.headersSent) reply.header('Connection', 'close')
      if (!request.raw.destroyed && !request.raw.readableEnded) request.raw.resume()
    })

    partApp.post<{ Params: UploadPartParams }>(
      '/v1/uploads/:uploadId/parts/:partNumber',
      {
        bodyLimit: PART_ROUTE_BODY_LIMIT,
        config: { rateLimit: rateLimitPolicy('ordinary') },
        preHandler: authenticate,
        schema: {
          params: UploadPartParamsSchema,
          response: { 200: UploadPartResponseSchema },
        },
      },
      async (request, reply) => {
        if (!request.isMultipart()) throw validationError()
        const identity = authenticatedRequestIdentity(request)
        const validation = deferredMultipart()
        let expectedSha256: string | undefined
        let formError: ApiError | undefined
        try {
          expectedSha256 = chunkSha256(request.headers['x-chunk-sha256'])
        } catch {
          formError = validationError()
        }
        let declaredSize: number | undefined
        let fileStream: Readable | undefined
        let uploadPromise: Promise<UploadPartResponse['data']> | undefined

        try {
          try {
            for await (const part of request.parts()) {
              if (part.type === 'file') {
                if (
                  !validMultipartFieldName(part.fieldname) ||
                  part.fieldname !== 'chunk' ||
                  !validMultipartFilename(part.filename) ||
                  fileStream !== undefined ||
                  expectedSha256 === undefined ||
                  formError !== undefined
                ) {
                  part.file.resume()
                  formError ??= validationError()
                  continue
                }
                fileStream = part.file
                uploadPromise = deps.uploads.uploadPart({
                  ...identity,
                  uploadId: request.params.uploadId,
                  partNumber: request.params.partNumber,
                  expectedSha256,
                  chunk: part.file,
                  multipart: validation.promise,
                  context: requestAuthContext(request),
                })
                void uploadPromise.catch(() => undefined)
                continue
              }

              if (
                !validMultipartFieldName(part.fieldname) ||
                part.fieldname !== 'chunkSizeBytes' ||
                declaredSize !== undefined ||
                part.fieldnameTruncated ||
                part.valueTruncated
              ) {
                formError ??= validationError()
                continue
              }
              try {
                declaredSize = chunkSize(part.value)
              } catch {
                formError ??= validationError()
              }
            }
          } catch (error) {
            const classified = multipartError(partApp, error)
            throw classified instanceof ApiError ? classified : validationError()
          }

          const fileTruncated =
            fileStream !== undefined &&
            'truncated' in fileStream &&
            Reflect.get(fileStream, 'truncated') === true
          if (fileTruncated) {
            formError ??= new ApiError({
              code: 'PART_TOO_LARGE',
              message: '上传分片超过允许大小',
              statusCode: 413,
            })
          }
          if (formError !== undefined) throw formError
          if (
            fileStream === undefined ||
            uploadPromise === undefined ||
            declaredSize === undefined
          ) {
            throw validationError()
          }
          validation.resolve({ chunkSizeBytes: declaredSize })
          const data = await uploadPromise
          return await sendData(reply, publicPartData(data))
        } catch (error) {
          const safeError = multipartError(partApp, error)
          validation.reject(safeError)
          if (uploadPromise !== undefined) await uploadPromise.catch(() => undefined)
          throw safeError
        }
      },
    )
  })
}
