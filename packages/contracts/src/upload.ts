import { Type, type Static, type TProperties } from '@sinclair/typebox'

import { ErrorCodeSchema } from './errors.js'
import {
  DateTimeSchema,
  PublicIdSchema,
  listSuccessEnvelopeSchema,
  strictObject,
  successEnvelopeSchema,
} from './envelope.js'

export const MIN_FILE_SIZE_BYTES = 12
export const MAX_FILE_SIZE_BYTES = 209_715_200
export const PART_SIZE_BYTES = 8_388_608
export const MAX_SELECTION_COUNT = 9
export const MAX_PART_COUNT = 25

export const PUBLIC_UPLOAD_STATUSES = [
  'uploading',
  'finalizing',
  'cancelling',
  'uploaded',
  'upload_failed',
  'aborted',
  'expired',
] as const

export type PublicUploadStatus = (typeof PUBLIC_UPLOAD_STATUSES)[number]
export type MediaKind = 'image' | 'video'

export const IMAGE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
] as const
export const VIDEO_MIME_TYPES = ['video/mp4', 'video/quicktime'] as const
export const ALLOWED_MIME_TYPES = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES] as const

export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]

export const PublicUploadStatusSchema = Type.Union(
  PUBLIC_UPLOAD_STATUSES.map((status) => Type.Literal(status)),
)
export const MediaKindSchema = Type.Union([Type.Literal('image'), Type.Literal('video')])
export const ImageMimeTypeSchema = Type.Union(IMAGE_MIME_TYPES.map((mime) => Type.Literal(mime)))
export const VideoMimeTypeSchema = Type.Union(VIDEO_MIME_TYPES.map((mime) => Type.Literal(mime)))
export const AllowedMimeTypeSchema = Type.Union(
  ALLOWED_MIME_TYPES.map((mime) => Type.Literal(mime)),
)

export interface UploadPartPlan {
  partNumber: number
  offsetBytes: number
  sizeBytes: number
}

export function planUploadParts(sizeBytes: number): UploadPartPlan[] {
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < MIN_FILE_SIZE_BYTES ||
    sizeBytes > MAX_FILE_SIZE_BYTES
  ) {
    throw new RangeError('file size is outside the supported range')
  }

  const count = Math.ceil(sizeBytes / PART_SIZE_BYTES)
  return Array.from({ length: count }, (_, index) => ({
    partNumber: index + 1,
    offsetBytes: index * PART_SIZE_BYTES,
    sizeBytes: Math.min(PART_SIZE_BYTES, sizeBytes - index * PART_SIZE_BYTES),
  }))
}

const FileNameSchema = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: '^(?!\\.{1,2}$)[^/\\\\\\u0000-\\u001f\\u007f-\\u009f]+$',
})
const FileSizeSchema = Type.Integer({
  minimum: MIN_FILE_SIZE_BYTES,
  maximum: MAX_FILE_SIZE_BYTES,
})
const ByteCountSchema = Type.Integer({ minimum: 0, maximum: MAX_FILE_SIZE_BYTES })
const PercentSchema = Type.Number({ minimum: 0, maximum: 100 })
const Sha256Schema = Type.String({ pattern: '^[0-9a-f]{64}$' })

function mediaObjectSchema<T extends TProperties>(properties: T) {
  return Type.Union([
    strictObject({
      ...properties,
      kind: Type.Literal('image'),
      mimeType: ImageMimeTypeSchema,
    }),
    strictObject({
      ...properties,
      kind: Type.Literal('video'),
      mimeType: VideoMimeTypeSchema,
    }),
  ])
}

export const InitializeUploadRequestSchema = Type.Union([
  strictObject({
    fileName: FileNameSchema,
    kind: Type.Literal('image'),
    mimeType: ImageMimeTypeSchema,
    sizeBytes: FileSizeSchema,
  }),
  strictObject({
    fileName: FileNameSchema,
    kind: Type.Literal('video'),
    mimeType: VideoMimeTypeSchema,
    sizeBytes: FileSizeSchema,
  }),
])

export const UploadPartPlanSchema = strictObject({
  partNumber: Type.Integer({ minimum: 1, maximum: MAX_PART_COUNT }),
  offsetBytes: ByteCountSchema,
  sizeBytes: Type.Integer({ minimum: 1, maximum: PART_SIZE_BYTES }),
  status: Type.Literal('pending'),
})

export const InitializeUploadSummarySchema = mediaObjectSchema({
  id: PublicIdSchema,
  mediaId: PublicIdSchema,
  status: Type.Literal('uploading'),
  fileName: FileNameSchema,
  sizeBytes: FileSizeSchema,
  partSizeBytes: Type.Literal(PART_SIZE_BYTES),
  partCount: Type.Integer({ minimum: 1, maximum: MAX_PART_COUNT }),
  expiresAt: DateTimeSchema,
  createdAt: DateTimeSchema,
})

export const InitializeUploadResponseDataSchema = strictObject({
  upload: InitializeUploadSummarySchema,
  parts: Type.Array(UploadPartPlanSchema, { minItems: 1, maxItems: MAX_PART_COUNT }),
})

export const InitializeUploadResponseSchema = successEnvelopeSchema(
  InitializeUploadResponseDataSchema,
)

export const UploadPartParamsSchema = strictObject({
  uploadId: PublicIdSchema,
  partNumber: Type.Integer({ minimum: 1, maximum: MAX_PART_COUNT }),
})

export const UploadPartResultSchema = strictObject({
  partNumber: Type.Integer({ minimum: 1, maximum: MAX_PART_COUNT }),
  sizeBytes: Type.Integer({ minimum: 1, maximum: PART_SIZE_BYTES }),
  sha256: Sha256Schema,
  status: Type.Literal('uploaded'),
  uploadedAt: DateTimeSchema,
})

export const DetailedProgressSchema = strictObject({
  confirmedBytes: ByteCountSchema,
  totalBytes: FileSizeSchema,
  uploadedParts: Type.Integer({ minimum: 0, maximum: MAX_PART_COUNT }),
  totalParts: Type.Integer({ minimum: 1, maximum: MAX_PART_COUNT }),
  percent: PercentSchema,
})

export const SummaryProgressSchema = strictObject({
  confirmedBytes: ByteCountSchema,
  totalBytes: FileSizeSchema,
  percent: PercentSchema,
})

export const UploadPartResponseDataSchema = strictObject({
  part: UploadPartResultSchema,
  progress: DetailedProgressSchema,
  replayed: Type.Boolean(),
})

export const UploadPartResponseSchema = successEnvelopeSchema(UploadPartResponseDataSchema)

export const UploadPathParamsSchema = strictObject({
  uploadId: PublicIdSchema,
})

export const UploadFailureSchema = strictObject({
  stage: Type.Union([Type.Literal('validation'), Type.Literal('upload'), Type.Literal('storage')]),
  code: ErrorCodeSchema,
  message: Type.String({ minLength: 1, maxLength: 512 }),
  failedAt: DateTimeSchema,
})

export const UploadDetailSummarySchema = mediaObjectSchema({
  id: PublicIdSchema,
  mediaId: PublicIdSchema,
  status: PublicUploadStatusSchema,
  fileName: FileNameSchema,
  sizeBytes: FileSizeSchema,
  progress: DetailedProgressSchema,
  expiresAt: DateTimeSchema,
  failure: Type.Union([UploadFailureSchema, Type.Null()]),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
})

export const UploadPartDetailSchema = strictObject({
  partNumber: Type.Integer({ minimum: 1, maximum: MAX_PART_COUNT }),
  offsetBytes: ByteCountSchema,
  sizeBytes: Type.Integer({ minimum: 1, maximum: PART_SIZE_BYTES }),
  status: Type.Union([Type.Literal('pending'), Type.Literal('uploaded'), Type.Literal('verified')]),
  sha256: Type.Union([Sha256Schema, Type.Null()]),
})

export const UploadDetailResponseDataSchema = strictObject({
  upload: UploadDetailSummarySchema,
  partDetailsRetained: Type.Boolean(),
  partsAvailableUntil: Type.Union([DateTimeSchema, Type.Null()]),
  parts: Type.Array(UploadPartDetailSchema, { maxItems: MAX_PART_COUNT }),
  pollAfterSeconds: Type.Union([Type.Integer({ minimum: 2, maximum: 30 }), Type.Null()]),
})

export const UploadDetailResponseSchema = successEnvelopeSchema(UploadDetailResponseDataSchema)

export const CompleteUploadRequestSchema = strictObject({})

export const CompleteUploadResponseDataSchema = strictObject({
  upload: strictObject({
    id: PublicIdSchema,
    status: Type.Literal('finalizing'),
    progress: SummaryProgressSchema,
  }),
  pollAfterSeconds: Type.Integer({ minimum: 2, maximum: 30 }),
})

export const CompleteUploadResponseSchema = successEnvelopeSchema(CompleteUploadResponseDataSchema)

export const AbortUploadRequestSchema = strictObject({
  reason: Type.Union([Type.Literal('userCancelled'), Type.Literal('replaced')]),
})

export const AbortUploadResponseDataSchema = strictObject({
  upload: strictObject({
    id: PublicIdSchema,
    status: Type.Literal('cancelling'),
  }),
  pollAfterSeconds: Type.Integer({ minimum: 2, maximum: 30 }),
})

export const AbortUploadResponseSchema = successEnvelopeSchema(AbortUploadResponseDataSchema)

export const UploadHistoryQuerySchema = strictObject({
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 20 })),
  status: Type.Optional(PublicUploadStatusSchema),
  cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
})

export const UploadHistoryItemSchema = mediaObjectSchema({
  id: PublicIdSchema,
  mediaId: PublicIdSchema,
  status: PublicUploadStatusSchema,
  fileName: FileNameSchema,
  sizeBytes: FileSizeSchema,
  progress: SummaryProgressSchema,
  failure: Type.Union([UploadFailureSchema, Type.Null()]),
  createdAt: DateTimeSchema,
  updatedAt: DateTimeSchema,
})

export const UploadHistoryResponseDataSchema = strictObject({
  items: Type.Array(UploadHistoryItemSchema),
})

export const UploadHistoryResponseSchema = listSuccessEnvelopeSchema(
  UploadHistoryResponseDataSchema,
)

export type InitializeUploadRequest = Static<typeof InitializeUploadRequestSchema>
export type InitializeUploadResponse = Static<typeof InitializeUploadResponseSchema>
export type UploadPartResponse = Static<typeof UploadPartResponseSchema>
export type UploadDetailResponse = Static<typeof UploadDetailResponseSchema>
export type CompleteUploadRequest = Static<typeof CompleteUploadRequestSchema>
export type CompleteUploadResponse = Static<typeof CompleteUploadResponseSchema>
export type AbortUploadRequest = Static<typeof AbortUploadRequestSchema>
export type AbortUploadResponse = Static<typeof AbortUploadResponseSchema>
export type UploadHistoryQuery = Static<typeof UploadHistoryQuerySchema>
export type UploadHistoryResponse = Static<typeof UploadHistoryResponseSchema>
