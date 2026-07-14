import type { Readable } from 'node:stream'

export type ObjectStorageErrorCertainty = 'definite' | 'ambiguous'

export type ObjectStorageErrorCode =
  | 'ACCESS_DENIED'
  | 'NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'THROTTLED'
  | 'TIMEOUT'
  | 'NETWORK'
  | 'SERVER_ERROR'
  | 'PROTOCOL_ERROR'
  | 'UNKNOWN'

export type ObjectStorageOperation =
  | 'ready'
  | 'createMultipart'
  | 'listMultipartUploads'
  | 'uploadPart'
  | 'listParts'
  | 'completeMultipart'
  | 'abortMultipart'
  | 'headObject'

export class ObjectStorageError extends Error {
  readonly certainty: ObjectStorageErrorCertainty
  readonly code: ObjectStorageErrorCode
  readonly operation: ObjectStorageOperation | undefined
  readonly retryable: boolean

  constructor(input: {
    certainty: ObjectStorageErrorCertainty
    code: ObjectStorageErrorCode
    operation?: ObjectStorageOperation
    retryable?: boolean
  }) {
    super('Object storage operation failed')
    this.name = 'ObjectStorageError'
    this.certainty = input.certainty
    this.code = input.code
    this.operation = input.operation
    this.retryable = input.retryable ?? input.certainty === 'ambiguous'
  }
}

export interface MultipartIdentity {
  bucket: string
  key: string
  uploadId: string
}

export interface ObjectStorage {
  ready(signal?: AbortSignal): Promise<boolean>
  createMultipart(input: {
    bucket: string
    key: string
    contentType: string
    metadata: Record<string, string>
    signal?: AbortSignal
  }): Promise<{ uploadId: string }>
  listMultipartUploads(input: { bucket: string; prefix: string }): Promise<
    {
      key: string
      uploadId: string
      initiatedAt?: Date
    }[]
  >
  uploadPart(input: {
    bucket: string
    key: string
    uploadId: string
    partNumber: number
    contentLength: number
    body: Readable
  }): Promise<{ etag: string }>
  listParts(input: MultipartIdentity): Promise<
    {
      partNumber: number
      etag: string
      sizeBytes: number
    }[]
  >
  completeMultipart(
    input: MultipartIdentity & {
      parts: { partNumber: number; etag: string }[]
    },
  ): Promise<{ etag: string }>
  abortMultipart(input: MultipartIdentity): Promise<void>
  headObject(input: {
    bucket: string
    key: string
  }): Promise<{ sizeBytes: number; contentType?: string; etag?: string } | null>
}
