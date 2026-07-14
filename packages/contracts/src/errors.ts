import { Type, type Static } from '@sinclair/typebox'

import { ResponseMetaSchema, strictObject } from './envelope.js'

export const ERROR_CODES = [
  'INVALID_JSON',
  'PAYLOAD_TOO_LARGE',
  'ROUTE_NOT_FOUND',
  'INVALID_CURSOR',
  'IDEMPOTENCY_KEY_REQUIRED',
  'UNAUTHORIZED',
  'TOKEN_EXPIRED',
  'REFRESH_TOKEN_INVALID',
  'REFRESH_TOKEN_REUSED',
  'WECHAT_CODE_INVALID',
  'USER_DISABLED',
  'UPLOAD_NOT_FOUND',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_IN_PROGRESS',
  'FIRST_PART_REQUIRED',
  'PART_UPLOAD_IN_PROGRESS',
  'PARTS_INCOMPLETE',
  'UPLOAD_NOT_WRITABLE',
  'UPLOAD_NOT_ABORTABLE',
  'UPLOAD_BUSY',
  'UPLOAD_EXPIRED',
  'FILE_TOO_LARGE',
  'PART_TOO_LARGE',
  'FILE_TYPE_NOT_ALLOWED',
  'MIME_MISMATCH',
  'VALIDATION_ERROR',
  'FILE_TOO_SMALL',
  'NICKNAME_INVALID',
  'PART_NUMBER_INVALID',
  'PART_LENGTH_MISMATCH',
  'PART_CHECKSUM_MISMATCH',
  'NICKNAME_REQUIRED',
  'UPLOAD_SESSION_LIMIT',
  'UPLOAD_CONCURRENCY_LIMIT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'WECHAT_SERVICE_UNAVAILABLE',
  'STORAGE_UNAVAILABLE',
  'STORAGE_OBJECT_SIZE_MISMATCH',
  'UPSTREAM_TIMEOUT',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export const ErrorCodeSchema = Type.Union(ERROR_CODES.map((code) => Type.Literal(code)))

export const FileSizeErrorDetailsSchema = strictObject({
  maxSizeBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  actualSizeBytes: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
})

export const MissingPartsErrorDetailsSchema = strictObject({
  missingPartNumbers: Type.Array(Type.Integer({ minimum: 1, maximum: 25 }), {
    minItems: 1,
    maxItems: 25,
  }),
})

export const ErrorDetailsSchema = Type.Union([
  FileSizeErrorDetailsSchema,
  MissingPartsErrorDetailsSchema,
])

export const ApiErrorSchema = strictObject({
  code: ErrorCodeSchema,
  message: Type.String({ minLength: 1, maxLength: 512 }),
  retryable: Type.Boolean(),
  details: Type.Optional(ErrorDetailsSchema),
})

export const ErrorEnvelopeSchema = strictObject({
  error: ApiErrorSchema,
  meta: ResponseMetaSchema,
})

export type ApiError = Static<typeof ApiErrorSchema>
export type ErrorEnvelope = Static<typeof ErrorEnvelopeSchema>
