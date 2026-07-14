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

const config: R2ObjectStorageConfig = {
  endpoint: process.env['MINIO_ENDPOINT'] ?? 'http://127.0.0.1:59000',
  bucket: process.env['MINIO_BUCKET'] ?? 'wx-private-media',
  accessKeyId: process.env['MINIO_ACCESS_KEY_ID'] ?? 'minio_local',
  secretAccessKey: process.env['MINIO_SECRET_ACCESS_KEY'] ?? 'minio_local_secret',
  forcePathStyle: true,
}

const adapter = new R2ObjectStorage(config)
const cleanupClient = createR2S3Client(config)
const activeUploads: MultipartIdentity[] = []
const cleanupKeys: string[] = []

function keyFor(label: string): string {
  return `integration/${label}/${randomUUID()}.bin`
}

async function anonymousGet(key: string): Promise<Response> {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  return fetch(`${config.endpoint}/${config.bucket}/${encodedKey}`, {
    method: 'GET',
    redirect: 'manual',
  })
}

beforeAll(async () => {
  await expect(adapter.ready()).resolves.toBe(true)
})

afterEach(async () => {
  await Promise.all(
    activeUploads.splice(0).map((upload) => adapter.abortMultipart(upload).catch(() => undefined)),
  )
  await Promise.all(
    cleanupKeys
      .splice(0)
      .map((key) =>
        cleanupClient
          .send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }))
          .catch(() => undefined),
      ),
  )
})

afterAll(() => {
  cleanupClient.destroy()
})

describe('R2ObjectStorage against private MinIO', () => {
  it('creates, discovers, uploads, lists, completes, and heads a private multipart object', async () => {
    const key = keyFor('complete')
    cleanupKeys.push(key)
    const bytes = Buffer.from('private multipart integration payload', 'utf8')
    const created = await adapter.createMultipart({
      bucket: config.bucket,
      key,
      contentType: 'application/octet-stream',
      metadata: { purpose: 'integration-test' },
    })
    const identity = { bucket: config.bucket, key, uploadId: created.uploadId }
    activeUploads.push(identity)

    const uploads = await adapter.listMultipartUploads({ bucket: config.bucket, prefix: key })
    const discovered = uploads.find(
      (upload) => upload.key === key && upload.uploadId === created.uploadId,
    )
    expect(discovered?.initiatedAt).toBeInstanceOf(Date)

    const uploaded = await adapter.uploadPart({
      ...identity,
      partNumber: 1,
      contentLength: bytes.byteLength,
      body: Readable.from(bytes),
    })
    expect(uploaded.etag).toMatch(/^"[A-Fa-f0-9]+"$/)

    await expect(adapter.listParts(identity)).resolves.toEqual([
      { partNumber: 1, etag: uploaded.etag, sizeBytes: bytes.byteLength },
    ])

    const completed = await adapter.completeMultipart({
      ...identity,
      parts: [{ partNumber: 1, etag: uploaded.etag }],
    })
    activeUploads.splice(0)
    expect(completed.etag).toMatch(/^"[A-Fa-f0-9]+-1"$/)

    await expect(adapter.headObject({ bucket: config.bucket, key })).resolves.toEqual({
      sizeBytes: bytes.byteLength,
      contentType: 'application/octet-stream',
      etag: completed.etag,
    })

    const publicResponse = await anonymousGet(key)
    expect(publicResponse.status).toBe(403)
    await publicResponse.body?.cancel()
  })

  it('uploads and aborts an unfinished multipart without creating a complete object', async () => {
    const key = keyFor('abort')
    cleanupKeys.push(key)
    const bytes = Buffer.from('part that must be aborted', 'utf8')
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
    await expect(adapter.listParts(identity)).resolves.toHaveLength(1)

    await expect(adapter.abortMultipart(identity)).resolves.toBeUndefined()
    activeUploads.splice(0)
    await expect(
      adapter.listMultipartUploads({ bucket: config.bucket, prefix: key }),
    ).resolves.toEqual([])
    await expect(adapter.headObject({ bucket: config.bucket, key })).resolves.toBeNull()
  })
})
