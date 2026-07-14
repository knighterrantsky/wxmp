import { Readable } from 'node:stream'

import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import type { ListPartsCommand } from '@aws-sdk/client-s3'
import { describe, expect, it } from 'vitest'

import {
  createR2S3Client,
  ObjectStorageError,
  R2ObjectStorage,
  type R2ObjectStorageConfig,
  type S3CommandSender,
} from '../../src/uploads/r2-object-storage.js'

const config: R2ObjectStorageConfig = {
  endpoint: 'https://account-id.r2.cloudflarestorage.com',
  bucket: 'private-media',
  accessKeyId: 'access-key-sentinel',
  secretAccessKey: 'secret-key-sentinel',
  forcePathStyle: false,
}

type Step = unknown

function isStepFactory(value: unknown): value is () => unknown {
  return typeof value === 'function'
}

function fakeSender(...steps: Step[]): {
  sender: S3CommandSender
  calls: { command: unknown; options: { abortSignal?: AbortSignal } | undefined }[]
} {
  const calls: {
    command: unknown
    options: { abortSignal?: AbortSignal } | undefined
  }[] = []
  const sender: S3CommandSender = {
    send(command, options) {
      calls.push({ command, options })
      const step = steps.shift()
      if (step instanceof Error) return Promise.reject(step)
      if (isStepFactory(step)) return Promise.resolve(step())
      return Promise.resolve(step)
    },
  }
  return { sender, calls }
}

function sdkError(name: string, statusCode: number | undefined, privateMessage: string): Error {
  const error = new Error(privateMessage)
  error.name = name
  return Object.assign(
    error,
    statusCode === undefined ? {} : { $metadata: { httpStatusCode: statusCode } },
  )
}

function storage(sender: S3CommandSender): R2ObjectStorage {
  return new R2ObjectStorage(config, { client: sender })
}

const identity = {
  bucket: 'private-media',
  key: 'users/user-id/video/2026/07/media-id.mp4',
  uploadId: 'upload-id-value',
} as const

describe('R2ObjectStorage client configuration', () => {
  it('uses region auto, the configured endpoint, static backend credentials, and virtual-host style', async () => {
    const client = createR2S3Client(config)
    try {
      expect(await client.config.region()).toBe('auto')
      expect(client.config.forcePathStyle).toBe(false)
      expect(await client.config.maxAttempts()).toBe(1)
      expect(await client.config.credentials()).toMatchObject({
        accessKeyId: 'access-key-sentinel',
        secretAccessKey: 'secret-key-sentinel',
      })
      const endpoint = await client.config.endpoint?.()
      expect(endpoint).toBeDefined()
      expect(JSON.stringify(endpoint)).toContain('account-id.r2.cloudflarestorage.com')
    } finally {
      client.destroy()
    }
  })
})

describe('R2ObjectStorage command mapping', () => {
  it('probes only the configured private bucket and forwards the readiness abort signal', async () => {
    const { sender, calls } = fakeSender({ $metadata: { httpStatusCode: 200 } })
    const abort = new AbortController()

    await expect(storage(sender).ready(abort.signal)).resolves.toBe(true)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.command).toBeInstanceOf(HeadBucketCommand)
    expect((calls[0]?.command as HeadBucketCommand).input).toEqual({ Bucket: 'private-media' })
    expect(calls[0]?.options).toEqual({ abortSignal: abort.signal })
  })

  it('returns false rather than leaking a readiness error', async () => {
    const { sender } = fakeSender(
      sdkError('AccessDenied', 403, 'private endpoint and credential details'),
    )

    await expect(storage(sender).ready()).resolves.toBe(false)
  })

  it('creates a private multipart upload without an ACL and requires an upload ID', async () => {
    const { sender, calls } = fakeSender({
      $metadata: { httpStatusCode: 200 },
      Bucket: 'private-media',
      Key: identity.key,
      UploadId: identity.uploadId,
    })

    await expect(
      storage(sender).createMultipart({
        bucket: identity.bucket,
        key: identity.key,
        contentType: 'video/mp4',
        metadata: { mediaid: 'media-id', userid: 'user-id' },
      }),
    ).resolves.toEqual({ uploadId: identity.uploadId })

    const command = calls[0]?.command
    expect(command).toBeInstanceOf(CreateMultipartUploadCommand)
    expect((command as CreateMultipartUploadCommand).input).toEqual({
      Bucket: identity.bucket,
      Key: identity.key,
      ContentType: 'video/mp4',
      Metadata: { mediaid: 'media-id', userid: 'user-id' },
    })
    expect((command as CreateMultipartUploadCommand).input).not.toHaveProperty('ACL')
  })

  it('forwards the create-multipart deadline signal to the SDK sender', async () => {
    const { sender, calls } = fakeSender({ UploadId: identity.uploadId })
    const abort = new AbortController()

    await storage(sender).createMultipart({
      bucket: identity.bucket,
      key: identity.key,
      contentType: 'video/mp4',
      metadata: {},
      signal: abort.signal,
    })

    expect(calls[0]?.options).toEqual({ abortSignal: abort.signal })
  })

  it('streams one part with its exact content length and preserves the validated ETag', async () => {
    const body = Readable.from(Buffer.from('part-body', 'utf8'))
    const { sender, calls } = fakeSender({
      $metadata: { httpStatusCode: 200 },
      ETag: '"part-etag"',
    })

    await expect(
      storage(sender).uploadPart({
        ...identity,
        partNumber: 2,
        contentLength: 9,
        body,
      }),
    ).resolves.toEqual({ etag: '"part-etag"' })

    const command = calls[0]?.command
    expect(command).toBeInstanceOf(UploadPartCommand)
    expect((command as UploadPartCommand).input).toEqual({
      Bucket: identity.bucket,
      Key: identity.key,
      UploadId: identity.uploadId,
      PartNumber: 2,
      ContentLength: 9,
      Body: body,
    })
  })

  it('maps the caller-supplied ordered part manifest when completing', async () => {
    const { sender, calls } = fakeSender({
      $metadata: { httpStatusCode: 200 },
      Bucket: identity.bucket,
      Key: identity.key,
      ETag: '"completed-etag-2"',
    })
    const parts = [
      { partNumber: 1, etag: '"part-1"' },
      { partNumber: 2, etag: '"part-2"' },
    ]

    await expect(storage(sender).completeMultipart({ ...identity, parts })).resolves.toEqual({
      etag: '"completed-etag-2"',
    })

    const command = calls[0]?.command
    expect(command).toBeInstanceOf(CompleteMultipartUploadCommand)
    expect((command as CompleteMultipartUploadCommand).input).toEqual({
      Bucket: identity.bucket,
      Key: identity.key,
      UploadId: identity.uploadId,
      MultipartUpload: {
        Parts: [
          { PartNumber: 1, ETag: '"part-1"' },
          { PartNumber: 2, ETag: '"part-2"' },
        ],
      },
    })
  })

  it('rejects an unsafe completion ETag before sending a command', async () => {
    const { sender, calls } = fakeSender()

    await expect(
      storage(sender).completeMultipart({
        ...identity,
        parts: [{ partNumber: 1, etag: 'unsafe\netag' }],
      }),
    ).rejects.toMatchObject({
      operation: 'completeMultipart',
      certainty: 'definite',
      code: 'PROTOCOL_ERROR',
      retryable: false,
    })
    expect(calls).toHaveLength(0)
  })

  it('aborts a multipart upload and treats an already-missing upload as success', async () => {
    const first = fakeSender({ $metadata: { httpStatusCode: 204 } })
    await expect(storage(first.sender).abortMultipart(identity)).resolves.toBeUndefined()
    expect(first.calls[0]?.command).toBeInstanceOf(AbortMultipartUploadCommand)
    expect((first.calls[0]?.command as AbortMultipartUploadCommand).input).toEqual({
      Bucket: identity.bucket,
      Key: identity.key,
      UploadId: identity.uploadId,
    })

    const missing = fakeSender(sdkError('NoSuchUpload', 404, 'private missing upload details'))
    await expect(storage(missing.sender).abortMultipart(identity)).resolves.toBeUndefined()
  })
})

describe('R2ObjectStorage pagination and response validation', () => {
  it('paginates multipart uploads with both continuation markers', async () => {
    const initiated = new Date('2026-07-15T01:00:00.000Z')
    const { sender, calls } = fakeSender(
      {
        $metadata: { httpStatusCode: 200 },
        IsTruncated: true,
        NextKeyMarker: 'key-marker-1',
        NextUploadIdMarker: 'upload-marker-1',
        Uploads: [{ Key: 'prefix/a', UploadId: 'upload-a', Initiated: initiated }],
      },
      {
        $metadata: { httpStatusCode: 200 },
        IsTruncated: false,
        Uploads: [{ Key: 'prefix/b', UploadId: 'upload-b' }],
      },
    )

    await expect(
      storage(sender).listMultipartUploads({ bucket: identity.bucket, prefix: 'prefix/' }),
    ).resolves.toEqual([
      { key: 'prefix/a', uploadId: 'upload-a', initiatedAt: initiated },
      { key: 'prefix/b', uploadId: 'upload-b' },
    ])

    expect(calls).toHaveLength(2)
    expect(calls[0]?.command).toBeInstanceOf(ListMultipartUploadsCommand)
    expect((calls[0]?.command as ListMultipartUploadsCommand).input).toEqual({
      Bucket: identity.bucket,
      Prefix: 'prefix/',
    })
    expect((calls[1]?.command as ListMultipartUploadsCommand).input).toEqual({
      Bucket: identity.bucket,
      Prefix: 'prefix/',
      KeyMarker: 'key-marker-1',
      UploadIdMarker: 'upload-marker-1',
    })
  })

  it('paginates and canonicalizes listed parts', async () => {
    const { sender, calls } = fakeSender(
      {
        $metadata: { httpStatusCode: 200 },
        IsTruncated: true,
        NextPartNumberMarker: '1',
        Parts: [{ PartNumber: 1, ETag: '"etag-1"', Size: 8_388_608 }],
      },
      {
        $metadata: { httpStatusCode: 200 },
        IsTruncated: false,
        Parts: [{ PartNumber: 2, ETag: '"etag-2"', Size: 12 }],
      },
    )

    await expect(storage(sender).listParts(identity)).resolves.toEqual([
      { partNumber: 1, etag: '"etag-1"', sizeBytes: 8_388_608 },
      { partNumber: 2, etag: '"etag-2"', sizeBytes: 12 },
    ])
    expect(calls).toHaveLength(2)
    expect((calls[1]?.command as ListPartsCommand).input).toEqual({
      Bucket: identity.bucket,
      Key: identity.key,
      UploadId: identity.uploadId,
      PartNumberMarker: '1',
    })
  })

  it('returns safe head metadata and maps a missing object to null', async () => {
    const found = fakeSender({
      $metadata: { httpStatusCode: 200 },
      ContentLength: 42,
      ContentType: 'video/mp4',
      ETag: '"head-etag"',
      Metadata: { private: 'must-not-be-returned' },
    })

    await expect(
      storage(found.sender).headObject({ bucket: identity.bucket, key: identity.key }),
    ).resolves.toEqual({ sizeBytes: 42, contentType: 'video/mp4', etag: '"head-etag"' })
    expect(found.calls[0]?.command).toBeInstanceOf(HeadObjectCommand)

    const missing = fakeSender(sdkError('NotFound', 404, 'private object-key details'))
    await expect(
      storage(missing.sender).headObject({ bucket: identity.bucket, key: identity.key }),
    ).resolves.toBeNull()
  })

  it('never mistakes a missing bucket for a missing upload or object', async () => {
    const abort = fakeSender(sdkError('NoSuchBucket', 404, 'private bucket details'))
    await expect(storage(abort.sender).abortMultipart(identity)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      certainty: 'definite',
    })

    const head = fakeSender(sdkError('NoSuchBucket', 404, 'private bucket details'))
    await expect(
      storage(head.sender).headObject({ bucket: identity.bucket, key: identity.key }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', certainty: 'definite' })
  })

  it.each(['listMultipartUploads', 'listParts'] as const)(
    'caps unique-cursor pagination for %s',
    async (method) => {
      let page = 0
      const sender: S3CommandSender = {
        send() {
          page += 1
          return Promise.resolve(
            method === 'listMultipartUploads'
              ? {
                  IsTruncated: true,
                  NextKeyMarker: `key-${String(page)}`,
                  NextUploadIdMarker: `upload-${String(page)}`,
                  Uploads: [],
                }
              : {
                  IsTruncated: true,
                  NextPartNumberMarker: String(page),
                  Parts: [],
                },
          )
        },
      }
      const operation =
        method === 'listMultipartUploads'
          ? storage(sender).listMultipartUploads({ bucket: identity.bucket, prefix: identity.key })
          : storage(sender).listParts(identity)

      await expect(operation).rejects.toMatchObject({
        operation: method,
        code: 'PROTOCOL_ERROR',
        certainty: 'ambiguous',
      })
      expect(page).toBe(32)
    },
  )

  it.each([
    ['create output without UploadId', 'createMultipart', fakeSender({ $metadata: {} })],
    [
      'create output with an oversized UploadId',
      'createMultipart',
      fakeSender({ UploadId: 'u'.repeat(1_025) }),
    ],
    ['upload output with a control ETag', 'uploadPart', fakeSender({ ETag: 'bad\netag' })],
    [
      'truncated upload page without markers',
      'listMultipartUploads',
      fakeSender({ IsTruncated: true, Uploads: [] }),
    ],
    [
      'part output without a size',
      'listParts',
      fakeSender({ IsTruncated: false, Parts: [{ PartNumber: 1, ETag: '"etag"' }] }),
    ],
    ['head output without a length', 'headObject', fakeSender({ ETag: '"etag"' })],
  ] as const)(
    'treats malformed %s as an ambiguous protocol failure',
    async (_name, method, fake) => {
      const adapter = storage(fake.sender)
      let operation: Promise<unknown>
      if (method === 'createMultipart') {
        operation = adapter.createMultipart({
          bucket: identity.bucket,
          key: identity.key,
          contentType: 'video/mp4',
          metadata: {},
        })
      } else if (method === 'uploadPart') {
        operation = adapter.uploadPart({
          ...identity,
          partNumber: 1,
          contentLength: 1,
          body: Readable.from(Buffer.from('x')),
        })
      } else if (method === 'listMultipartUploads') {
        operation = adapter.listMultipartUploads({ bucket: identity.bucket, prefix: identity.key })
      } else if (method === 'listParts') {
        operation = adapter.listParts(identity)
      } else {
        operation = adapter.headObject({ bucket: identity.bucket, key: identity.key })
      }

      await expect(operation).rejects.toMatchObject({
        operation: method,
        certainty: 'ambiguous',
        code: 'PROTOCOL_ERROR',
        retryable: true,
      })
    },
  )
})

describe('R2ObjectStorage safe error classification', () => {
  it.each([
    ['AccessDenied', 403, 'ACCESS_DENIED'],
    ['AccessDenied', undefined, 'ACCESS_DENIED'],
    ['InvalidRequest', 400, 'INVALID_REQUEST'],
    ['NoSuchBucket', 404, 'NOT_FOUND'],
    ['NoSuchBucket', undefined, 'NOT_FOUND'],
  ] as const)('classifies explicit %s create rejection as definite', async (name, status, code) => {
    const privateMessage = `private ${name} endpoint/key/credential details`
    const { sender } = fakeSender(sdkError(name, status, privateMessage))

    const error: unknown = await storage(sender)
      .createMultipart({
        bucket: identity.bucket,
        key: identity.key,
        contentType: 'video/mp4',
        metadata: {},
      })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ObjectStorageError)
    expect(error).toMatchObject({
      operation: 'createMultipart',
      certainty: 'definite',
      code,
      retryable: false,
    })
    expect(error).not.toHaveProperty('cause')
    expect(String(error)).not.toContain(privateMessage)
    expect(JSON.stringify(error)).not.toContain(privateMessage)
  })

  it.each([
    [sdkError('TimeoutError', undefined, 'private timeout target'), 'TIMEOUT'],
    [sdkError('NetworkingError', undefined, 'private network target'), 'NETWORK'],
    [sdkError('SlowDown', 429, 'private throttle body'), 'THROTTLED'],
    [sdkError('InternalError', 503, 'private upstream body'), 'SERVER_ERROR'],
    [sdkError('UnknownSdkError', undefined, 'private unknown body'), 'UNKNOWN'],
  ] as const)('classifies an uncertain create failure as ambiguous', async (sdkFailure, code) => {
    const { sender } = fakeSender(sdkFailure)

    await expect(
      storage(sender).createMultipart({
        bucket: identity.bucket,
        key: identity.key,
        contentType: 'video/mp4',
        metadata: {},
      }),
    ).rejects.toMatchObject({
      operation: 'createMultipart',
      certainty: 'ambiguous',
      code,
      retryable: true,
    })
  })
})
