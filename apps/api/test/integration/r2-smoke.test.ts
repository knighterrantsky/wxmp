import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'

import { DeleteObjectCommand } from '@aws-sdk/client-s3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import type { MultipartIdentity } from '../../src/uploads/object-storage.js'
import {
  createR2S3Client,
  R2ObjectStorage,
  type R2ObjectStorageConfig,
} from '../../src/uploads/r2-object-storage.js'
import { loadR2SmokeConfig } from '../support/r2-smoke-config.js'

const enabled = process.env['RUN_R2_SMOKE'] === 'true'
const activeUploads: MultipartIdentity[] = []
const ownedObjectKeys: string[] = []
let config: R2ObjectStorageConfig
let adapter: R2ObjectStorage
let cleanupClient: ReturnType<typeof createR2S3Client> | undefined

function uniqueKey(label: string): string {
  return `codex-r2-smoke/${new Date().toISOString().slice(0, 10)}/${label}/${randomUUID()}.bin`
}

describe('R2 smoke safety gate', () => {
  const safeEnvironment = {
    RUN_R2_SMOKE: 'true',
    R2_SMOKE_ENDPOINT: `https://${'a'.repeat(32)}.r2.cloudflarestorage.com`,
    R2_SMOKE_BUCKET: 'wx-private-media-smoke-test',
    R2_SMOKE_ACCESS_KEY_ID: 'a'.repeat(32),
    R2_SMOKE_SECRET_ACCESS_KEY: 'b'.repeat(64),
  }

  it('accepts only an explicit Cloudflare endpoint and dedicated smoke-test bucket', () => {
    expect(loadR2SmokeConfig(safeEnvironment)).toEqual({
      endpoint: safeEnvironment.R2_SMOKE_ENDPOINT,
      bucket: safeEnvironment.R2_SMOKE_BUCKET,
      accessKeyId: safeEnvironment.R2_SMOKE_ACCESS_KEY_ID,
      secretAccessKey: safeEnvironment.R2_SMOKE_SECRET_ACCESS_KEY,
      forcePathStyle: false,
    })
  })

  it.each([
    [{ ...safeEnvironment, RUN_R2_SMOKE: 'false' }, 'RUN_R2_SMOKE'],
    [{ ...safeEnvironment, R2_SMOKE_ENDPOINT: 'http://127.0.0.1:9000' }, 'R2_SMOKE_ENDPOINT'],
    [{ ...safeEnvironment, R2_SMOKE_BUCKET: 'wx-private-media' }, 'R2_SMOKE_BUCKET'],
    [{ ...safeEnvironment, R2_BUCKET: safeEnvironment.R2_SMOKE_BUCKET }, 'R2_SMOKE_BUCKET'],
  ])('rejects an unsafe credential-gated environment', (environment, field) => {
    expect(() => loadR2SmokeConfig(environment)).toThrow(field)
  })
})

describe.skipIf(!enabled)('credential-gated Cloudflare R2 smoke', () => {
  beforeAll(async () => {
    config = loadR2SmokeConfig(process.env)
    adapter = new R2ObjectStorage(config)
    cleanupClient = createR2S3Client(config)
    await expect(adapter.ready()).resolves.toBe(true)
  })

  afterEach(async () => {
    const client = cleanupClient
    if (client === undefined) return
    await Promise.all(
      activeUploads
        .splice(0)
        .map((upload) => adapter.abortMultipart(upload).catch(() => undefined)),
    )
    await Promise.all(
      ownedObjectKeys
        .splice(0)
        .map((key) =>
          client
            .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
            .catch(() => undefined),
        ),
    )
  })

  afterAll(() => {
    cleanupClient?.destroy()
  })

  it('completes a two-part object, verifies HEAD, and deletes exactly its unique key', async () => {
    const key = uniqueKey('complete')
    ownedObjectKeys.push(key)
    const first = Buffer.alloc(5 * 1_024 * 1_024, 0x41)
    const second = Buffer.alloc(1_024, 0x42)
    const mediaId = '019f11a0-3000-7000-8000-000000000001'
    const userId = '019f11a0-3000-7000-8000-000000000002'
    const created = await adapter.createMultipart({
      bucket: config.bucket,
      key,
      contentType: 'application/octet-stream',
      metadata: { mediaId, userId },
    })
    const identity = { bucket: config.bucket, key, uploadId: created.uploadId }
    activeUploads.push(identity)

    const partOne = await adapter.uploadPart({
      ...identity,
      partNumber: 1,
      contentLength: first.byteLength,
      body: Readable.from(first),
    })
    const partTwo = await adapter.uploadPart({
      ...identity,
      partNumber: 2,
      contentLength: second.byteLength,
      body: Readable.from(second),
    })
    await expect(adapter.listParts(identity)).resolves.toEqual([
      { partNumber: 1, etag: partOne.etag, sizeBytes: first.byteLength },
      { partNumber: 2, etag: partTwo.etag, sizeBytes: second.byteLength },
    ])

    const completed = await adapter.completeMultipart({
      ...identity,
      parts: [
        { partNumber: 1, etag: partOne.etag },
        { partNumber: 2, etag: partTwo.etag },
      ],
    })
    activeUploads.splice(0)
    await expect(adapter.headObject({ bucket: config.bucket, key })).resolves.toEqual({
      sizeBytes: first.byteLength + second.byteLength,
      contentType: 'application/octet-stream',
      etag: completed.etag,
      metadata: { mediaId, userId },
    })
    if (cleanupClient === undefined) throw new Error('R2 smoke cleanup client is unavailable')
    await cleanupClient.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
    await expect(adapter.headObject({ bucket: config.bucket, key })).resolves.toBeNull()
    ownedObjectKeys.splice(ownedObjectKeys.indexOf(key), 1)
  }, 60_000)

  it('aborts its unique unfinished multipart object and leaves no completed object', async () => {
    const key = uniqueKey('abort')
    ownedObjectKeys.push(key)
    const bytes = Buffer.from('R2 smoke abort payload', 'utf8')
    const created = await adapter.createMultipart({
      bucket: config.bucket,
      key,
      contentType: 'application/octet-stream',
      metadata: {},
    })
    const identity = { bucket: config.bucket, key, uploadId: created.uploadId }
    activeUploads.push(identity)

    await adapter.uploadPart({
      ...identity,
      partNumber: 1,
      contentLength: bytes.byteLength,
      body: Readable.from(bytes),
    })
    await expect(adapter.abortMultipart(identity)).resolves.toBeUndefined()
    activeUploads.splice(0)

    await expect(
      adapter.listMultipartUploads({ bucket: config.bucket, prefix: key }),
    ).resolves.toEqual([])
    await expect(adapter.headObject({ bucket: config.bucket, key })).resolves.toBeNull()
  }, 60_000)
})
