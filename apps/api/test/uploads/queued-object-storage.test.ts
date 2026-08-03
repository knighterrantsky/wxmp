import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ObjectStorageError, type ObjectStorage } from '../../src/uploads/object-storage.js'
import { LocalUploadSpool, QueuedR2ObjectStorage } from '../../src/uploads/queued-object-storage.js'

const bucket = 'private-media'
const key = 'users/user-id/image/2026/08/media-id.jpg'
const body = Buffer.from('server-staged-media', 'utf8')

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wx-upload-spool-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function remoteHarness() {
  const createMultipart = vi.fn<ObjectStorage['createMultipart']>().mockResolvedValue({
    uploadId: 'remote-upload-id',
  })
  const listMultipartUploads = vi.fn<ObjectStorage['listMultipartUploads']>().mockResolvedValue([])
  const listParts = vi.fn<ObjectStorage['listParts']>().mockResolvedValue([])
  const uploadedBodies: Buffer[] = []
  const uploadPart = vi.fn<ObjectStorage['uploadPart']>(async (input) => {
    const chunks: Buffer[] = []
    for await (const chunk of input.body) chunks.push(Buffer.from(chunk as Uint8Array))
    uploadedBodies.push(Buffer.concat(chunks))
    return { etag: '"remote-part-etag"' }
  })
  const completeMultipart = vi
    .fn<ObjectStorage['completeMultipart']>()
    .mockResolvedValue({ etag: '"remote-object-etag"' })
  const remote: ObjectStorage = {
    ready: vi.fn(() => Promise.resolve(true)),
    createMultipart,
    listMultipartUploads,
    uploadPart,
    listParts,
    completeMultipart,
    abortMultipart: vi.fn(() => Promise.resolve()),
    headObject: vi.fn(() => Promise.resolve(null)),
  }
  return {
    remote,
    createMultipart,
    listMultipartUploads,
    listParts,
    uploadPart,
    uploadedBodies,
    completeMultipart,
  }
}

async function staged(spool: LocalUploadSpool) {
  const created = await spool.createMultipart({
    bucket,
    key,
    contentType: 'image/jpeg',
    metadata: { mediaId: 'media-id', userId: 'user-id' },
  })
  const part = await spool.uploadPart({
    bucket,
    key,
    uploadId: created.uploadId,
    partNumber: 1,
    contentLength: body.byteLength,
    body: Readable.from(body),
  })
  return { ...created, part }
}

describe('LocalUploadSpool', () => {
  it('durably stages bytes and metadata without calling object storage', async () => {
    const spool = new LocalUploadSpool({ rootDirectory: root })

    const upload = await staged(spool)

    await expect(spool.ready()).resolves.toBe(true)
    await expect(readFile(spool.partPath(upload.uploadId, 1))).resolves.toEqual(body)
    await expect(spool.listParts({ bucket, key, uploadId: upload.uploadId })).resolves.toEqual([
      {
        partNumber: 1,
        etag: upload.part.etag,
        sizeBytes: body.byteLength,
      },
    ])
    await expect(spool.listMultipartUploads({ bucket, prefix: 'users/user-id/' })).resolves.toEqual(
      [expect.objectContaining({ key, uploadId: upload.uploadId })],
    )
  })

  it('does not publish a partial part when the streamed length is wrong', async () => {
    const spool = new LocalUploadSpool({ rootDirectory: root })
    const created = await spool.createMultipart({
      bucket,
      key,
      contentType: 'image/jpeg',
      metadata: { mediaId: 'media-id', userId: 'user-id' },
    })

    await expect(
      spool.uploadPart({
        bucket,
        key,
        uploadId: created.uploadId,
        partNumber: 1,
        contentLength: body.byteLength + 1,
        body: Readable.from(body),
      }),
    ).rejects.toBeInstanceOf(ObjectStorageError)

    await expect(spool.listParts({ bucket, key, uploadId: created.uploadId })).resolves.toEqual([])
    await expect(readFile(spool.partPath(created.uploadId, 1))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('atomically replaces the same server part during a manual retry', async () => {
    const spool = new LocalUploadSpool({ rootDirectory: root })
    const upload = await staged(spool)
    const replacement = Buffer.from('server-retried-media', 'utf8')

    const part = await spool.uploadPart({
      bucket,
      key,
      uploadId: upload.uploadId,
      partNumber: 1,
      contentLength: replacement.byteLength,
      body: Readable.from(replacement),
    })

    await expect(readFile(spool.partPath(upload.uploadId, 1))).resolves.toEqual(replacement)
    await expect(spool.listParts({ bucket, key, uploadId: upload.uploadId })).resolves.toEqual([
      { partNumber: 1, etag: part.etag, sizeBytes: replacement.byteLength },
    ])
  })
})

describe('QueuedR2ObjectStorage', () => {
  it('uploads staged parts in the worker and completes R2 with remote ETags', async () => {
    const spool = new LocalUploadSpool({ rootDirectory: root })
    const upload = await staged(spool)
    const remote = remoteHarness()
    const queued = new QueuedR2ObjectStorage({ spool, remote: remote.remote })

    const localParts = await queued.listParts({ bucket, key, uploadId: upload.uploadId })
    await expect(
      queued.completeMultipart({
        bucket,
        key,
        uploadId: upload.uploadId,
        parts: localParts.map(({ partNumber, etag }) => ({ partNumber, etag })),
      }),
    ).resolves.toEqual({ etag: '"remote-object-etag"' })

    expect(remote.createMultipart).toHaveBeenCalledOnce()
    expect(remote.uploadPart).toHaveBeenCalledOnce()
    expect(remote.uploadedBodies).toEqual([body])
    expect(remote.completeMultipart).toHaveBeenCalledWith(
      expect.objectContaining({
        uploadId: 'remote-upload-id',
        parts: [{ partNumber: 1, etag: '"remote-part-etag"' }],
      }),
    )
    await expect(spool.listMultipartUploads({ bucket, prefix: key })).resolves.toHaveLength(1)
    remote.remote.headObject = vi.fn(() =>
      Promise.resolve({
        sizeBytes: body.byteLength,
        contentType: 'image/jpeg',
        etag: '"remote-object-etag"',
        metadata: { mediaId: 'media-id', userId: 'user-id' },
      }),
    )
    await expect(queued.headObject({ bucket, key })).resolves.toMatchObject({
      etag: '"remote-object-etag"',
    })
    await expect(spool.listMultipartUploads({ bucket, prefix: key })).resolves.toEqual([])
  })

  it('adopts an existing remote multipart after a worker restart', async () => {
    const spool = new LocalUploadSpool({ rootDirectory: root })
    const upload = await staged(spool)
    const remote = remoteHarness()
    remote.listMultipartUploads.mockResolvedValue([
      { key, uploadId: 'orphaned-remote-upload', initiatedAt: new Date('2026-08-03T10:00:00Z') },
    ])
    const queued = new QueuedR2ObjectStorage({ spool, remote: remote.remote })

    await expect(
      queued.listParts({ bucket, key, uploadId: upload.uploadId }),
    ).resolves.toHaveLength(1)

    expect(remote.createMultipart).not.toHaveBeenCalled()
    expect(remote.listParts).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: 'orphaned-remote-upload' }),
    )
    expect(remote.uploadPart).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: 'orphaned-remote-upload' }),
    )
  })

  it('recreates a remote multipart when the persisted one no longer exists', async () => {
    const spool = new LocalUploadSpool({ rootDirectory: root })
    const upload = await staged(spool)
    const firstRemote = remoteHarness()
    const firstQueued = new QueuedR2ObjectStorage({ spool, remote: firstRemote.remote })
    await firstQueued.listParts({ bucket, key, uploadId: upload.uploadId })

    const restarted = remoteHarness()
    restarted.createMultipart.mockResolvedValue({ uploadId: 'replacement-remote-upload' })
    restarted.listParts
      .mockRejectedValueOnce(
        new ObjectStorageError({
          certainty: 'definite',
          code: 'NOT_FOUND',
          operation: 'listParts',
          retryable: false,
        }),
      )
      .mockResolvedValueOnce([])
    const queued = new QueuedR2ObjectStorage({ spool, remote: restarted.remote })

    await expect(
      queued.listParts({ bucket, key, uploadId: upload.uploadId }),
    ).resolves.toHaveLength(1)

    expect(restarted.createMultipart).toHaveBeenCalledOnce()
    expect(restarted.uploadPart).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: 'replacement-remote-upload' }),
    )
  })

  it('keeps the spool when HEAD finds an object with mismatched metadata', async () => {
    const spool = new LocalUploadSpool({ rootDirectory: root })
    const upload = await staged(spool)
    const remote = remoteHarness()
    remote.remote.headObject = vi.fn(() =>
      Promise.resolve({
        sizeBytes: body.byteLength,
        contentType: 'image/jpeg',
        etag: '"unexpected-object"',
        metadata: { mediaId: 'different-media', userId: 'user-id' },
      }),
    )
    const queued = new QueuedR2ObjectStorage({ spool, remote: remote.remote })

    await queued.headObject({ bucket, key })

    await expect(spool.listMultipartUploads({ bucket, prefix: key })).resolves.toHaveLength(1)
    await expect(readFile(spool.partPath(upload.uploadId, 1))).resolves.toEqual(body)
  })

  it('keeps the spool until HEAD includes an object ETag', async () => {
    const spool = new LocalUploadSpool({ rootDirectory: root })
    const upload = await staged(spool)
    const remote = remoteHarness()
    remote.remote.headObject = vi.fn(() =>
      Promise.resolve({
        sizeBytes: body.byteLength,
        contentType: 'image/jpeg',
        metadata: { mediaId: 'media-id', userId: 'user-id' },
      }),
    )
    const queued = new QueuedR2ObjectStorage({ spool, remote: remote.remote })

    await queued.headObject({ bucket, key })

    await expect(spool.listMultipartUploads({ bucket, prefix: key })).resolves.toHaveLength(1)
    await expect(readFile(spool.partPath(upload.uploadId, 1))).resolves.toEqual(body)
  })

  it('keeps the local spool intact when R2 is unavailable', async () => {
    const spool = new LocalUploadSpool({ rootDirectory: root })
    const upload = await staged(spool)
    const remote = remoteHarness()
    remote.createMultipart.mockRejectedValue(new Error('remote unavailable'))
    const queued = new QueuedR2ObjectStorage({ spool, remote: remote.remote })

    await expect(queued.listParts({ bucket, key, uploadId: upload.uploadId })).rejects.toThrow(
      'remote unavailable',
    )

    await expect(spool.listParts({ bucket, key, uploadId: upload.uploadId })).resolves.toHaveLength(
      1,
    )
    await expect(readFile(spool.partPath(upload.uploadId, 1))).resolves.toEqual(body)
  })
})
