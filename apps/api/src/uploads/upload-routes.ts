import { InitializeUploadResponseSchema, type InitializeUploadResponse } from '@wx-upload/contracts'
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

export interface UploadRouteService {
  initialize(input: InitializeUploadInput): Promise<{
    data: InitializeUploadResponse['data']
    replayed: boolean
  }>
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
}
