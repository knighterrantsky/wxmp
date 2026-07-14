import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import type { Readable } from 'node:stream'

import {
  ObjectStorageError,
  type ObjectStorage,
  type ObjectStorageErrorCode,
  type ObjectStorageOperation,
} from './object-storage.js'

export { ObjectStorageError } from './object-storage.js'
export type {
  ObjectStorageErrorCertainty,
  ObjectStorageErrorCode,
  ObjectStorageOperation,
} from './object-storage.js'

export interface R2ObjectStorageConfig {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
  forcePathStyle: boolean
}

type SupportedS3Command =
  | AbortMultipartUploadCommand
  | CompleteMultipartUploadCommand
  | CreateMultipartUploadCommand
  | HeadBucketCommand
  | HeadObjectCommand
  | ListMultipartUploadsCommand
  | ListPartsCommand
  | UploadPartCommand

export interface S3CommandSender {
  send(command: SupportedS3Command, options?: { abortSignal?: AbortSignal }): Promise<unknown>
}

export interface R2ObjectStorageOptions {
  client?: S3CommandSender
}

const TIMEOUT_NAMES = new Set([
  'AbortError',
  'RequestTimeout',
  'RequestTimeoutException',
  'TimeoutError',
])
const THROTTLE_NAMES = new Set([
  'SlowDown',
  'Throttling',
  'ThrottlingException',
  'TooManyRequestsException',
])
const ACCESS_DENIED_NAMES = new Set([
  'AccessDenied',
  'AccessDeniedException',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
])
const NOT_FOUND_NAMES = new Set(['NoSuchBucket', 'NoSuchKey', 'NoSuchUpload', 'NotFound'])
const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
])
const MAX_PAGINATION_PAGES = 32
const MAX_LIST_RESULTS = 10_000

export function createR2S3Client(config: R2ObjectStorageConfig): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
    maxAttempts: 1,
  })
}

function reflected(error: unknown, key: string): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  try {
    return Reflect.get(error, key)
  } catch {
    return undefined
  }
}

function errorName(error: unknown): string | undefined {
  const name = reflected(error, 'name')
  return typeof name === 'string' ? name : undefined
}

function errorCode(error: unknown): string | undefined {
  const code = reflected(error, 'code')
  return typeof code === 'string' ? code : undefined
}

function httpStatus(error: unknown): number | undefined {
  const metadata = reflected(error, '$metadata')
  const status = reflected(metadata, 'httpStatusCode')
  return Number.isInteger(status) ? Number(status) : undefined
}

function classifiedCode(error: unknown): {
  code: ObjectStorageErrorCode
  certainty: 'definite' | 'ambiguous'
  retryable: boolean
} {
  const name = errorName(error)
  const code = errorCode(error)
  const labels = [name, code].filter((value): value is string => value !== undefined)
  const status = httpStatus(error)

  if (status === 408 || labels.some((value) => TIMEOUT_NAMES.has(value))) {
    return { code: 'TIMEOUT', certainty: 'ambiguous', retryable: true }
  }
  if (status === 429 || labels.some((value) => THROTTLE_NAMES.has(value))) {
    return { code: 'THROTTLED', certainty: 'ambiguous', retryable: true }
  }
  if (
    labels.some(
      (value) =>
        NETWORK_CODES.has(value) || /(?:Network|Networking|Socket|Connection)/iu.test(value),
    )
  ) {
    return { code: 'NETWORK', certainty: 'ambiguous', retryable: true }
  }
  if (
    (status === undefined || (status >= 400 && status <= 499)) &&
    labels.some((value) => ACCESS_DENIED_NAMES.has(value))
  ) {
    return { code: 'ACCESS_DENIED', certainty: 'definite', retryable: false }
  }
  if (
    (status === undefined || (status >= 400 && status <= 499)) &&
    labels.some((value) => NOT_FOUND_NAMES.has(value))
  ) {
    return { code: 'NOT_FOUND', certainty: 'definite', retryable: false }
  }
  if (status !== undefined && status >= 500 && status <= 599) {
    return { code: 'SERVER_ERROR', certainty: 'ambiguous', retryable: true }
  }
  if (status !== undefined && status >= 400 && status <= 499) {
    if (
      status === 401 ||
      status === 403 ||
      labels.some((value) => ACCESS_DENIED_NAMES.has(value))
    ) {
      return { code: 'ACCESS_DENIED', certainty: 'definite', retryable: false }
    }
    if (status === 404 || labels.some((value) => NOT_FOUND_NAMES.has(value))) {
      return { code: 'NOT_FOUND', certainty: 'definite', retryable: false }
    }
    return { code: 'INVALID_REQUEST', certainty: 'definite', retryable: false }
  }
  return { code: 'UNKNOWN', certainty: 'ambiguous', retryable: true }
}

function classifiedError(operation: ObjectStorageOperation, error: unknown): ObjectStorageError {
  const classification = classifiedCode(error)
  return new ObjectStorageError({ operation, ...classification })
}

function protocolError(
  operation: ObjectStorageOperation,
  certainty: 'definite' | 'ambiguous' = 'ambiguous',
): ObjectStorageError {
  return new ObjectStorageError({
    operation,
    certainty,
    code: 'PROTOCOL_ERROR',
    retryable: certainty === 'ambiguous',
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown, operation: ObjectStorageOperation): Record<string, unknown> {
  if (!isRecord(value)) throw protocolError(operation)
  return value
}

function storageString(value: unknown, maximumLength = 4_096): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= maximumLength &&
    value.trim() === value &&
    !hasControlCharacter(value)
  )
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || (codePoint >= 127 && codePoint <= 159))) {
      return true
    }
  }
  return false
}

function requiredStorageString(
  value: unknown,
  operation: ObjectStorageOperation,
  maximumLength?: number,
): string {
  if (!storageString(value, maximumLength)) throw protocolError(operation)
  return value
}

function requiredEtag(
  value: unknown,
  operation: ObjectStorageOperation,
  certainty: 'definite' | 'ambiguous' = 'ambiguous',
): string {
  if (!storageString(value, 1_024)) throw protocolError(operation, certainty)
  return value
}

function optionalStorageString(
  value: unknown,
  operation: ObjectStorageOperation,
  maximumLength: number,
): string | undefined {
  if (value === undefined) return undefined
  return requiredStorageString(value, operation, maximumLength)
}

function truncated(value: unknown, operation: ObjectStorageOperation): boolean {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw protocolError(operation)
  return value
}

function isMissing(error: unknown, acceptedNames: ReadonlySet<string>): boolean {
  const name = errorName(error)
  return name !== undefined && acceptedNames.has(name)
}

export class R2ObjectStorage implements ObjectStorage {
  readonly #config: R2ObjectStorageConfig
  readonly #client: S3CommandSender

  constructor(config: R2ObjectStorageConfig, options: R2ObjectStorageOptions = {}) {
    this.#config = { ...config }
    this.#client = options.client ?? createR2S3Client(config)
  }

  async ready(signal?: AbortSignal): Promise<boolean> {
    try {
      const command = new HeadBucketCommand({ Bucket: this.#config.bucket })
      if (signal === undefined) {
        await this.#client.send(command)
      } else {
        await this.#client.send(command, { abortSignal: signal })
      }
      return true
    } catch {
      return false
    }
  }

  async createMultipart(input: {
    bucket: string
    key: string
    contentType: string
    metadata: Record<string, string>
    signal?: AbortSignal
  }): Promise<{ uploadId: string }> {
    const operation = 'createMultipart'
    const output = record(
      await this.#send(
        operation,
        new CreateMultipartUploadCommand({
          Bucket: input.bucket,
          Key: input.key,
          ContentType: input.contentType,
          Metadata: input.metadata,
        }),
        input.signal,
      ),
      operation,
    )
    return { uploadId: requiredStorageString(output['UploadId'], operation, 1_024) }
  }

  async listMultipartUploads(input: {
    bucket: string
    prefix: string
  }): Promise<{ key: string; uploadId: string; initiatedAt?: Date }[]> {
    const operation = 'listMultipartUploads'
    const results: { key: string; uploadId: string; initiatedAt?: Date }[] = []
    const seenCursors = new Set<string>()
    let keyMarker: string | undefined
    let uploadIdMarker: string | undefined
    let pageCount = 0

    for (;;) {
      pageCount += 1
      if (pageCount > MAX_PAGINATION_PAGES) throw protocolError(operation)
      const output = record(
        await this.#send(
          operation,
          new ListMultipartUploadsCommand({
            Bucket: input.bucket,
            Prefix: input.prefix,
            ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
            ...(uploadIdMarker === undefined ? {} : { UploadIdMarker: uploadIdMarker }),
          }),
        ),
        operation,
      )
      const uploads = output['Uploads']
      if (uploads !== undefined && !Array.isArray(uploads)) throw protocolError(operation)
      for (const value of uploads ?? []) {
        const upload = record(value, operation)
        const key = requiredStorageString(upload['Key'], operation, 1_024)
        const uploadId = requiredStorageString(upload['UploadId'], operation, 1_024)
        const initiated = upload['Initiated']
        if (initiated !== undefined) {
          if (!(initiated instanceof Date) || !Number.isFinite(initiated.getTime())) {
            throw protocolError(operation)
          }
          results.push({ key, uploadId, initiatedAt: new Date(initiated) })
        } else {
          results.push({ key, uploadId })
        }
        if (results.length > MAX_LIST_RESULTS) throw protocolError(operation)
      }

      if (!truncated(output['IsTruncated'], operation)) return results
      const nextKeyMarker = requiredStorageString(output['NextKeyMarker'], operation)
      const nextUploadIdMarker = requiredStorageString(output['NextUploadIdMarker'], operation)
      const cursor = `${nextKeyMarker}\u0000${nextUploadIdMarker}`
      if (seenCursors.has(cursor)) throw protocolError(operation)
      seenCursors.add(cursor)
      keyMarker = nextKeyMarker
      uploadIdMarker = nextUploadIdMarker
    }
  }

  async uploadPart(input: {
    bucket: string
    key: string
    uploadId: string
    partNumber: number
    contentLength: number
    body: Readable
  }): Promise<{ etag: string }> {
    const operation = 'uploadPart'
    const output = record(
      await this.#send(
        operation,
        new UploadPartCommand({
          Bucket: input.bucket,
          Key: input.key,
          UploadId: input.uploadId,
          PartNumber: input.partNumber,
          ContentLength: input.contentLength,
          Body: input.body,
        }),
      ),
      operation,
    )
    return { etag: requiredEtag(output['ETag'], operation) }
  }

  async listParts(input: {
    bucket: string
    key: string
    uploadId: string
  }): Promise<{ partNumber: number; etag: string; sizeBytes: number }[]> {
    const operation = 'listParts'
    const results: { partNumber: number; etag: string; sizeBytes: number }[] = []
    const seenCursors = new Set<string>()
    let partNumberMarker: string | undefined
    let pageCount = 0

    for (;;) {
      pageCount += 1
      if (pageCount > MAX_PAGINATION_PAGES) throw protocolError(operation)
      const output = record(
        await this.#send(
          operation,
          new ListPartsCommand({
            Bucket: input.bucket,
            Key: input.key,
            UploadId: input.uploadId,
            ...(partNumberMarker === undefined ? {} : { PartNumberMarker: partNumberMarker }),
          }),
        ),
        operation,
      )
      const parts = output['Parts']
      if (parts !== undefined && !Array.isArray(parts)) throw protocolError(operation)
      for (const value of parts ?? []) {
        const part = record(value, operation)
        const partNumber = part['PartNumber']
        const sizeBytes = part['Size']
        if (
          !Number.isInteger(partNumber) ||
          Number(partNumber) < 1 ||
          Number(partNumber) > 10_000
        ) {
          throw protocolError(operation)
        }
        if (!Number.isSafeInteger(sizeBytes) || Number(sizeBytes) < 0) {
          throw protocolError(operation)
        }
        results.push({
          partNumber: Number(partNumber),
          etag: requiredEtag(part['ETag'], operation),
          sizeBytes: Number(sizeBytes),
        })
        if (results.length > MAX_LIST_RESULTS) throw protocolError(operation)
      }

      if (!truncated(output['IsTruncated'], operation)) break
      const nextMarker = requiredStorageString(output['NextPartNumberMarker'], operation)
      if (seenCursors.has(nextMarker)) throw protocolError(operation)
      seenCursors.add(nextMarker)
      partNumberMarker = nextMarker
    }

    results.sort((left, right) => left.partNumber - right.partNumber)
    for (let index = 1; index < results.length; index += 1) {
      if (results[index - 1]?.partNumber === results[index]?.partNumber) {
        throw protocolError(operation)
      }
    }
    return results
  }

  async completeMultipart(input: {
    bucket: string
    key: string
    uploadId: string
    parts: { partNumber: number; etag: string }[]
  }): Promise<{ etag: string }> {
    const operation = 'completeMultipart'
    const parts = input.parts.map((part) => ({
      PartNumber: part.partNumber,
      ETag: requiredEtag(part.etag, operation, 'definite'),
    }))
    const output = record(
      await this.#send(
        operation,
        new CompleteMultipartUploadCommand({
          Bucket: input.bucket,
          Key: input.key,
          UploadId: input.uploadId,
          MultipartUpload: { Parts: parts },
        }),
      ),
      operation,
    )
    return { etag: requiredEtag(output['ETag'], operation) }
  }

  async abortMultipart(input: { bucket: string; key: string; uploadId: string }): Promise<void> {
    const operation = 'abortMultipart'
    try {
      await this.#client.send(
        new AbortMultipartUploadCommand({
          Bucket: input.bucket,
          Key: input.key,
          UploadId: input.uploadId,
        }),
      )
    } catch (error) {
      if (isMissing(error, new Set(['NoSuchUpload', 'NotFound']))) return
      throw classifiedError(operation, error)
    }
  }

  async headObject(input: {
    bucket: string
    key: string
  }): Promise<{ sizeBytes: number; contentType?: string; etag?: string } | null> {
    const operation = 'headObject'
    let raw: unknown
    try {
      raw = await this.#client.send(new HeadObjectCommand({ Bucket: input.bucket, Key: input.key }))
    } catch (error) {
      if (isMissing(error, new Set(['NoSuchKey', 'NotFound']))) return null
      throw classifiedError(operation, error)
    }

    const output = record(raw, operation)
    const size = output['ContentLength']
    if (!Number.isSafeInteger(size) || Number(size) < 0) throw protocolError(operation)
    const contentType = optionalStorageString(output['ContentType'], operation, 256)
    const etag = output['ETag'] === undefined ? undefined : requiredEtag(output['ETag'], operation)
    return {
      sizeBytes: Number(size),
      ...(contentType === undefined ? {} : { contentType }),
      ...(etag === undefined ? {} : { etag }),
    }
  }

  async #send(
    operation: ObjectStorageOperation,
    command: SupportedS3Command,
    signal?: AbortSignal,
  ): Promise<unknown> {
    try {
      return await (signal === undefined
        ? this.#client.send(command)
        : this.#client.send(command, { abortSignal: signal }))
    } catch (error) {
      if (error instanceof ObjectStorageError) throw error
      throw classifiedError(operation, error)
    }
  }
}
