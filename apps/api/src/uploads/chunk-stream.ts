import { createHash, timingSafeEqual } from 'node:crypto'
import { pipeline, Transform, type Readable, type TransformCallback } from 'node:stream'

import { ApiError } from '../http/errors.js'

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MAX_CAPTURE_PREFIX_BYTES = 4_096

export interface ChunkInspectionOptions {
  expectedBytes: number
  expectedSha256: string
  capturePrefixBytes: number
}

export interface ChunkInspectionResult {
  actualBytes: number
  sha256: string
  prefix: Buffer
}

export interface InspectedChunk {
  stream: Readable
  completed: Promise<ChunkInspectionResult>
}

function apiError(
  code: 'PART_CHECKSUM_MISMATCH' | 'PART_LENGTH_MISMATCH' | 'VALIDATION_ERROR',
): ApiError {
  return new ApiError({
    code,
    message: code,
    retryable: code === 'PART_CHECKSUM_MISMATCH',
    statusCode: 422,
  })
}

function validateOptions(options: ChunkInspectionOptions): void {
  if (
    !Number.isSafeInteger(options.expectedBytes) ||
    options.expectedBytes < 0 ||
    !Number.isSafeInteger(options.capturePrefixBytes) ||
    options.capturePrefixBytes < 0 ||
    options.capturePrefixBytes > MAX_CAPTURE_PREFIX_BYTES ||
    !SHA256_PATTERN.test(options.expectedSha256)
  ) {
    throw apiError('VALIDATION_ERROR')
  }
}

function asBuffer(chunk: unknown, encoding: BufferEncoding): Buffer {
  if (Buffer.isBuffer(chunk)) return chunk
  if (typeof chunk === 'string') return Buffer.from(chunk, encoding)
  if (chunk instanceof Uint8Array)
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
  throw new TypeError('Chunk stream emitted a non-binary value')
}

export function inspectChunk(source: Readable, options: ChunkInspectionOptions): InspectedChunk {
  validateOptions(options)

  const hash = createHash('sha256')
  const prefixChunks: Buffer[] = []
  let prefixBytes = 0
  let actualBytes = 0
  let lengthMismatch = false
  let result: ChunkInspectionResult | undefined

  const inspector = new Transform({
    transform(chunk: unknown, encoding: BufferEncoding, callback: TransformCallback) {
      let bytes: Buffer
      try {
        bytes = asBuffer(chunk, encoding)
      } catch (error) {
        callback(error as Error)
        return
      }

      const remainingPrefixBytes = options.capturePrefixBytes - prefixBytes
      if (remainingPrefixBytes > 0) {
        const prefix = bytes.subarray(0, remainingPrefixBytes)
        prefixChunks.push(Buffer.from(prefix))
        prefixBytes += prefix.length
      }

      const remainingExpectedBytes = Math.max(0, options.expectedBytes - actualBytes)
      const forwarded = bytes.subarray(0, remainingExpectedBytes)
      actualBytes += bytes.length
      if (forwarded.length !== bytes.length) lengthMismatch = true
      if (forwarded.length > 0) hash.update(forwarded)
      callback(null, forwarded.length === 0 ? undefined : forwarded)
    },
    flush(callback) {
      if (lengthMismatch || actualBytes !== options.expectedBytes) {
        callback(apiError('PART_LENGTH_MISMATCH'))
        return
      }

      const digest = hash.digest()
      if (!timingSafeEqual(digest, Buffer.from(options.expectedSha256, 'hex'))) {
        callback(apiError('PART_CHECKSUM_MISMATCH'))
        return
      }

      result = {
        actualBytes,
        sha256: digest.toString('hex'),
        prefix: Buffer.concat(prefixChunks, prefixBytes),
      }
      callback()
    },
  })

  let resolveCompleted!: (value: ChunkInspectionResult) => void
  let rejectCompleted!: (error: unknown) => void
  const completed = new Promise<ChunkInspectionResult>((resolve, reject) => {
    resolveCompleted = resolve
    rejectCompleted = reject
  })

  const rejectAlreadyClosedSource = () => {
    if (!source.readableEnded && !inspector.destroyed) {
      inspector.destroy(apiError('VALIDATION_ERROR'))
    }
  }

  pipeline(source, inspector, (error) => {
    if (error) {
      rejectCompleted(error)
      return
    }
    if (result === undefined) {
      rejectCompleted(new Error('Chunk inspection ended without a result'))
      return
    }
    resolveCompleted(result)
  })
  if (source.destroyed && !source.readableEnded) queueMicrotask(rejectAlreadyClosedSource)

  // The output stream remains the primary error channel. Mark the completion
  // promise handled immediately as callers may await the stream operation first.
  void completed.catch(() => undefined)

  return { stream: inspector, completed }
}
