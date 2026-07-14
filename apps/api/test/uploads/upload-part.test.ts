import { PART_SIZE_BYTES, type ErrorEnvelope, type UploadPartResponse } from '@wx-upload/contracts'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildAppShell } from '../../src/app.js'
import { PostgresAuthRepository } from '../../src/auth/auth-repository.js'
import type { AccessTokenVerifier } from '../../src/auth/auth-routes.js'
import { applyRoleGrants } from '../../src/db/grants.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import { createSecureIdGenerator } from '../../src/lib/id.js'
import { ObjectStorageError, type ObjectStorage } from '../../src/uploads/object-storage.js'
import { PostgresUploadConcurrency } from '../../src/uploads/upload-concurrency.js'
import {
  PostgresUploadRepository,
  type PreparedPartIdentity,
  type UploadRepository,
} from '../../src/uploads/upload-repository.js'
import { registerUploadRoutes } from '../../src/uploads/upload-routes.js'
import { UploadService, type PartUploadConcurrency } from '../../src/uploads/upload-service.js'
import { loadDestructiveDatabaseTestConfig } from '../support/destructive-database.js'
import { fakeDependencies } from '../support/fakes.js'
import {
  multipartPayload,
  mediaFixtureId,
  otherUploadSessionId,
  otherUploadUserId,
  privateFixtureBucket,
  privateFixtureKey,
  privateFixtureMultipartId,
  seedUploadIdentities,
  seedWritableUpload,
  sha256,
  twoPartFixtureSizes,
  uploadFixtureId,
  uploadFixtureNow,
  uploadOwnerSessionId,
  uploadOwnerUserId,
  validPngChunk,
} from '../support/upload-fixture.js'
import { collect } from '../support/streams.js'

const databaseConfig = loadDestructiveDatabaseTestConfig(process.env)
const clock = { now: () => uploadFixtureNow }
const boundary = '----wx-private-upload-test-boundary'

interface StorageFixture {
  storage: ObjectStorage
  uploadPart: ReturnType<typeof vi.fn<ObjectStorage['uploadPart']>>
  uploadedBodies: Buffer[]
}

interface StorageAbortObservation {
  signal: AbortSignal | undefined
}

function storageFixture(): StorageFixture {
  const uploadedBodies: Buffer[] = []
  const uploadPart = vi.fn<ObjectStorage['uploadPart']>(async (input) => {
    uploadedBodies.push(await collect(input.body))
    return { etag: `private-etag-${String(uploadedBodies.length)}` }
  })
  return {
    uploadedBodies,
    uploadPart,
    storage: {
      ready: vi.fn<ObjectStorage['ready']>().mockResolvedValue(true),
      createMultipart: vi
        .fn<ObjectStorage['createMultipart']>()
        .mockResolvedValue({ uploadId: privateFixtureMultipartId }),
      listMultipartUploads: vi.fn<ObjectStorage['listMultipartUploads']>().mockResolvedValue([]),
      uploadPart,
      listParts: vi.fn<ObjectStorage['listParts']>().mockResolvedValue([]),
      completeMultipart: vi
        .fn<ObjectStorage['completeMultipart']>()
        .mockResolvedValue({ etag: 'private-completed-etag' }),
      abortMultipart: vi.fn<ObjectStorage['abortMultipart']>().mockResolvedValue(undefined),
      headObject: vi.fn<ObjectStorage['headObject']>().mockResolvedValue(null),
    },
  }
}

function stallUploadPartUntilAbort(storage: StorageFixture): StorageAbortObservation {
  const observation: StorageAbortObservation = { signal: undefined }
  storage.uploadPart.mockImplementationOnce(async (input) => {
    observation.signal = input.signal
    await collect(input.body).catch(() => undefined)
    if (input.signal === undefined) throw new Error('upload signal is required')
    if (!input.signal.aborted) {
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener(
          'abort',
          () => {
            resolve()
          },
          { once: true },
        )
      })
    }
    throw new ObjectStorageError({
      certainty: 'ambiguous',
      code: 'TIMEOUT',
      operation: 'uploadPart',
    })
  })
  return observation
}

const tokens: AccessTokenVerifier = {
  verifyAccessToken: (token) =>
    Promise.resolve(
      token === 'other-access-token'
        ? { sub: otherUploadUserId, sid: otherUploadSessionId }
        : { sub: uploadOwnerUserId, sid: uploadOwnerSessionId },
    ),
}

let migrationPool: Pool
let runtimePool: Pool

beforeAll(async () => {
  migrationPool = createPool(databaseConfig.migrationDatabaseUrl)
  await runMigrations(migrationPool, new URL('../../src/db/migrations', import.meta.url).pathname)
  await applyRoleGrants(migrationPool, {
    runtimeRole: 'wx_runtime',
    maintenanceRole: 'wx_maintenance',
  })
  runtimePool = createPool(databaseConfig.runtimeDatabaseUrl)
})

beforeEach(async () => {
  await migrationPool.query(`truncate table
    media_app.audit_events,
    media_app.idempotency_records,
    media_app.upload_parts,
    media_app.upload_sessions,
    media_app.media_objects,
    media_app.user_sessions,
    media_app.user_identities,
    media_app.users restart identity cascade`)
  await seedUploadIdentities(migrationPool)
})

afterAll(async () => {
  await Promise.all([runtimePool.end(), migrationPool.end()])
})

function failFirstPartConfirmation(repository: UploadRepository): UploadRepository {
  let shouldFail = true
  return {
    beginInitialization: (input) => repository.beginInitialization(input),
    completeInitialization: (input) => repository.completeInitialization(input),
    failInitialization: (input) => repository.failInitialization(input),
    assertPartOwnership: (input) => repository.assertPartOwnership(input),
    preparePart: (input) => repository.preparePart(input),
    async confirmPart(input) {
      if (shouldFail) {
        shouldFail = false
        throw new Error('simulated database write failure after R2 success')
      }
      return repository.confirmPart(input)
    },
    scheduleValidationAbort: (input) => repository.scheduleValidationAbort(input),
    getDetail: (input) => repository.getDetail(input),
  }
}

function fixtureApp(
  storage: ObjectStorage,
  options: {
    concurrency?: PartUploadConcurrency
    failFirstConfirm?: boolean
    uploadPartTimeoutMs?: number
  } = {},
) {
  const ids = createSecureIdGenerator(clock)
  const postgresRepository = new PostgresUploadRepository({ pool: runtimePool, clock, ids })
  const repository = options.failFirstConfirm
    ? failFirstPartConfirmation(postgresRepository)
    : postgresRepository
  const uploads = new UploadService({
    bucket: privateFixtureBucket,
    clock,
    ids,
    repository,
    storage,
    concurrency:
      options.concurrency ??
      ({
        acquirePart: () =>
          Promise.resolve({
            release: () => Promise.resolve(),
          }),
      } satisfies PartUploadConcurrency),
    ...(options.uploadPartTimeoutMs === undefined
      ? {}
      : { uploadPartTimeoutMs: options.uploadPartTimeoutMs }),
  })
  const app = buildAppShell(
    fakeDependencies({
      pool: runtimePool,
      clock,
      ids,
    }),
  )
  registerUploadRoutes(app, { uploads, tokens })
  return app
}

async function postPart(input: {
  app: ReturnType<typeof fixtureApp>
  chunk?: Buffer
  chunkFirst?: boolean
  chunkSizeBytes?: string
  extraField?: boolean
  sha?: string
  token?: string
  uploadId?: string
  partNumber?: number
}) {
  const payload = multipartPayload({
    boundary,
    ...(input.chunk === undefined ? {} : { chunk: input.chunk }),
    ...(input.chunkFirst === undefined ? {} : { chunkFirst: input.chunkFirst }),
    ...(input.chunkSizeBytes === undefined ? {} : { chunkSizeBytes: input.chunkSizeBytes }),
    ...(input.extraField === undefined ? {} : { extraField: input.extraField }),
  })
  return input.app.inject({
    method: 'POST',
    url: `/v1/uploads/${input.uploadId ?? uploadFixtureId}/parts/${String(input.partNumber ?? 1)}`,
    headers: {
      authorization: `Bearer ${input.token ?? 'owner-access-token'}`,
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'x-chunk-sha256': input.sha ?? sha256(input.chunk ?? validPngChunk),
    },
    payload,
  })
}

async function waitForRuntimeLockWaiters(expected: number): Promise<void> {
  const deadline = performance.now() + 2_000
  for (;;) {
    const waiting = await runtimePool.query<{ count: string }>(
      `select count(*)::text as count
         from pg_stat_activity
        where datname = current_database()
          and usename = 'wx_runtime'
          and wait_event_type = 'Lock'`,
    )
    if (Number(waiting.rows[0]?.count ?? 0) >= expected) return
    if (performance.now() >= deadline) throw new Error('runtime lock waiter was not observed')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('streaming upload parts', () => {
  it('streams a part to private storage and returns authoritative progress without internals', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })

    expect(response.statusCode).toBe(200)
    expect(response.json<UploadPartResponse>().data).toEqual({
      part: {
        partNumber: 1,
        sizeBytes: validPngChunk.length,
        sha256: sha256(validPngChunk),
        status: 'uploaded',
        uploadedAt: uploadFixtureNow.toISOString(),
      },
      progress: {
        confirmedBytes: validPngChunk.length,
        totalBytes: validPngChunk.length,
        uploadedParts: 1,
        totalParts: 1,
        percent: 100,
      },
      replayed: false,
    })
    expect(JSON.stringify(response.json<UploadPartResponse>())).not.toMatch(
      new RegExp(
        `${privateFixtureBucket}|${privateFixtureKey}|${privateFixtureMultipartId}|private-etag|r2`,
        'i',
      ),
    )
    expect(storage.uploadPart).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: privateFixtureBucket,
        key: privateFixtureKey,
        uploadId: privateFixtureMultipartId,
        partNumber: 1,
        contentLength: validPngChunk.length,
      }),
    )
    expect(storage.uploadedBodies).toEqual([validPngChunk])
    await app.close()
  })

  it('naturally replays the same confirmed part without a second storage call', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const first = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })
    const replay = await postPart({
      app,
      chunk: validPngChunk,
      chunkFirst: true,
      chunkSizeBytes: String(validPngChunk.length),
    })

    expect(first.statusCode).toBe(200)
    expect(replay.statusCode).toBe(200)
    expect(replay.json<UploadPartResponse>().data).toMatchObject({ replayed: true })
    expect(storage.uploadPart).toHaveBeenCalledOnce()
    await app.close()
  })

  it('replays verified content but does not allow a verified part to be replaced', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)
    await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })
    await migrationPool.query(
      `update media_app.upload_parts
          set status = 'verified', verified_at = $3
        where upload_session_id = $1 and part_number = $2`,
      [uploadFixtureId, 1, uploadFixtureNow],
    )

    const replay = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })
    const replacement = Buffer.from(validPngChunk)
    replacement[replacement.length - 1] = 0x44
    const rejected = await postPart({
      app,
      chunk: replacement,
      chunkSizeBytes: String(replacement.length),
    })

    expect(replay.statusCode).toBe(200)
    expect(replay.json<UploadPartResponse>().data).toMatchObject({ replayed: true })
    expect(rejected.statusCode).toBe(409)
    expect(rejected.json<ErrorEnvelope>().error).toMatchObject({ code: 'UPLOAD_NOT_WRITABLE' })
    expect(storage.uploadPart).toHaveBeenCalledOnce()
    const persisted = await migrationPool.query<{ checksum: string; status: string }>(
      `select status, encode(checksum_sha256, 'hex') as checksum
         from media_app.upload_parts
        where upload_session_id = $1 and part_number = 1`,
      [uploadFixtureId],
    )
    expect(persisted.rows[0]).toEqual({
      status: 'verified',
      checksum: sha256(validPngChunk),
    })
    await app.close()
  })

  it('requires the persisted size as well as the hash before replaying a part', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)
    await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length - 1),
    })

    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({
      code: 'PART_LENGTH_MISMATCH',
      retryable: false,
    })
    expect(storage.uploadPart).toHaveBeenCalledOnce()
    await app.close()
  })

  it('rehashes replay request bytes instead of trusting a stale matching header', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)
    await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })
    const changedBody = Buffer.from(validPngChunk)
    changedBody[changedBody.length - 1] = 0x44

    const response = await postPart({
      app,
      chunk: changedBody,
      chunkSizeBytes: String(changedBody.length),
      sha: sha256(validPngChunk),
    })

    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({
      code: 'PART_CHECKSUM_MISMATCH',
      retryable: true,
    })
    expect(storage.uploadPart).toHaveBeenCalledOnce()
    await app.close()
  })

  it('safely overwrites R2 and persists on retry after R2 success but database failure', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage, { failFirstConfirm: true })

    const first = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })
    const retry = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })

    expect(first.statusCode).toBe(500)
    expect(first.json<ErrorEnvelope>().error).toMatchObject({ code: 'INTERNAL_ERROR' })
    expect(retry.statusCode).toBe(200)
    expect(retry.json<UploadPartResponse>().data).toMatchObject({
      part: { sha256: sha256(validPngChunk) },
      progress: { confirmedBytes: validPngChunk.length, uploadedParts: 1 },
      replayed: false,
    })
    expect(storage.uploadPart).toHaveBeenCalledTimes(2)
    await app.close()
  })

  it('overwrites changed content and recomputes progress instead of incrementing it twice', async () => {
    await seedWritableUpload(migrationPool)
    const replacement = Buffer.from(validPngChunk)
    replacement[replacement.length - 1] = 0x43
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })
    const replaced = await postPart({
      app,
      chunk: replacement,
      chunkSizeBytes: String(replacement.length),
    })

    expect(replaced.statusCode).toBe(200)
    expect(replaced.json<UploadPartResponse>().data).toMatchObject({
      part: { sha256: sha256(replacement) },
      progress: { confirmedBytes: replacement.length, uploadedParts: 1, percent: 100 },
      replayed: false,
    })
    expect(storage.uploadPart).toHaveBeenCalledTimes(2)
    const persisted = await migrationPool.query<{
      confirmed_part_count: number
      confirmed_size_bytes: string
      checksum: string
    }>(
      `select u.confirmed_part_count, u.confirmed_size_bytes::text,
              encode(p.checksum_sha256, 'hex') as checksum
         from media_app.upload_sessions u
         join media_app.upload_parts p on p.upload_session_id = u.id
        where u.id = $1 and p.part_number = 1`,
      [uploadFixtureId],
    )
    expect(persisted.rows[0]).toEqual({
      confirmed_part_count: 1,
      confirmed_size_bytes: String(replacement.length),
      checksum: sha256(replacement),
    })
    await app.close()
  })

  it('keeps a checksum mismatch writable and unconfirmed', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
      sha: '0'.repeat(64),
    })

    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({
      code: 'PART_CHECKSUM_MISMATCH',
      retryable: true,
    })
    const state = await migrationPool.query<{
      part_status: string
      upload_status: string
      confirmed_size_bytes: string
    }>(
      `select u.status as upload_status, u.confirmed_size_bytes::text,
              p.status as part_status
         from media_app.upload_sessions u
         join media_app.upload_parts p on p.upload_session_id = u.id
        where u.id = $1 and p.part_number = 1`,
      [uploadFixtureId],
    )
    expect(state.rows[0]).toEqual({
      upload_status: 'uploading',
      confirmed_size_bytes: '0',
      part_status: 'pending',
    })
    await app.close()
  })

  it.each([
    {
      label: 'checksum failure',
      chunk: validPngChunk,
      chunkFirst: false,
      sha: '0'.repeat(64),
      code: 'PART_CHECKSUM_MISMATCH',
    },
    {
      label: 'length failure',
      chunk: Buffer.concat([validPngChunk, Buffer.alloc(1024 * 1024, 0x42)]),
      chunkFirst: true,
      sha: sha256(Buffer.concat([validPngChunk, Buffer.alloc(1024 * 1024, 0x42)])),
      code: 'PART_LENGTH_MISMATCH',
    },
  ])('aborts a stalled storage request immediately after $label', async (fixture) => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    let storageSignal: AbortSignal | undefined
    storage.uploadPart.mockImplementationOnce(async (input) => {
      storageSignal = input.signal
      await collect(input.body).catch(() => undefined)
      if (!input.signal?.aborted) {
        await new Promise<void>((resolve) => {
          input.signal?.addEventListener(
            'abort',
            () => {
              resolve()
            },
            { once: true },
          )
        })
      }
      throw new ObjectStorageError({
        certainty: 'ambiguous',
        code: 'TIMEOUT',
        operation: 'uploadPart',
      })
    })
    const app = fixtureApp(storage.storage, { uploadPartTimeoutMs: 1_000 })
    const startedAt = performance.now()

    const response = await postPart({
      app,
      chunk: fixture.chunk,
      chunkFirst: fixture.chunkFirst,
      chunkSizeBytes: String(validPngChunk.length),
      sha: fixture.sha,
    })

    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: fixture.code })
    expect(storageSignal?.aborted).toBe(true)
    await app.close()
  })

  it('terminates the incoming stream and releases the request after early storage rejection', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    storage.uploadPart.mockRejectedValueOnce(
      new ObjectStorageError({
        certainty: 'ambiguous',
        code: 'NETWORK',
        operation: 'uploadPart',
      }),
    )
    const app = fixtureApp(storage.storage)

    const failed = await postPart({
      app,
      chunk: validPngChunk,
      chunkFirst: true,
      chunkSizeBytes: String(validPngChunk.length),
    })
    const retry = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })

    expect(failed.statusCode).toBe(503)
    expect(failed.headers['retry-after']).toBe('1')
    expect(failed.json<ErrorEnvelope>().error).toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      retryable: true,
    })
    expect(retry.statusCode).toBe(200)
    expect(storage.uploadPart).toHaveBeenCalledTimes(2)
    await app.close()
  })

  it('drains the request when a storage adapter throws before returning a promise', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    storage.uploadPart.mockImplementationOnce(() => {
      throw new ObjectStorageError({
        certainty: 'ambiguous',
        code: 'NETWORK',
        operation: 'uploadPart',
      })
    })
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkFirst: true,
      chunkSizeBytes: String(validPngChunk.length),
    })

    expect(response.statusCode).toBe(503)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      retryable: true,
    })
    await app.close()
  })

  it('durably schedules validation abort when first-part magic bytes do not match', async () => {
    await seedWritableUpload(migrationPool, {
      mimeType: 'image/jpeg',
      fileName: 'fixture.jpg',
    })
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })

    expect(response.statusCode).toBe(415)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({
      code: 'MIME_MISMATCH',
      retryable: false,
    })
    const state = await migrationPool.query<{
      abort_reason: string
      failure_code: string
      next_abort_at: Date | null
      status: string
    }>(
      `select status, abort_reason, failure_code, next_abort_at
         from media_app.upload_sessions where id = $1`,
      [uploadFixtureId],
    )
    expect(state.rows[0]).toMatchObject({
      status: 'aborting',
      abort_reason: 'validationFailed',
      failure_code: 'MIME_MISMATCH',
      next_abort_at: uploadFixtureNow,
    })
    await app.close()
  })

  it('returns FILE_TOO_SMALL and schedules validation abort for a truncated signature', async () => {
    const truncatedWebp = Buffer.concat([
      Buffer.from('RIFF', 'ascii'),
      Buffer.alloc(4),
      Buffer.from('WEBP', 'ascii'),
    ])
    await seedWritableUpload(migrationPool, { partSizes: [truncatedWebp.length] })
    await migrationPool.query(
      `update media_app.media_objects
          set original_filename = 'truncated.webp',
              declared_content_type = 'image/webp', canonical_extension = '.webp'
        where id = $1`,
      [mediaFixtureId],
    )
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: truncatedWebp,
      chunkSizeBytes: String(truncatedWebp.length),
    })

    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({
      code: 'FILE_TOO_SMALL',
      retryable: false,
    })
    const state = await migrationPool.query<{
      abort_reason: string
      failure_code: string
      status: string
    }>(
      `select status, abort_reason, failure_code
         from media_app.upload_sessions where id = $1`,
      [uploadFixtureId],
    )
    expect(state.rows[0]).toEqual({
      status: 'aborting',
      abort_reason: 'validationFailed',
      failure_code: 'FILE_TOO_SMALL',
    })
    await app.close()
  })

  it('aborts stalled storage and durably rejects a first-part signature mismatch', async () => {
    await seedWritableUpload(migrationPool, {
      mimeType: 'image/jpeg',
      fileName: 'fixture.jpg',
    })
    const storage = storageFixture()
    const observation = stallUploadPartUntilAbort(storage)
    const app = fixtureApp(storage.storage, { uploadPartTimeoutMs: 1_000 })
    const startedAt = performance.now()

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })

    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(response.statusCode).toBe(415)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'MIME_MISMATCH' })
    expect(observation.signal?.aborted).toBe(true)
    const state = await migrationPool.query<{ abort_reason: string; status: string }>(
      `select status, abort_reason from media_app.upload_sessions where id = $1`,
      [uploadFixtureId],
    )
    expect(state.rows[0]).toEqual({ status: 'aborting', abort_reason: 'validationFailed' })
    await app.close()
  })

  it('atomically expires a due upload before touching storage', async () => {
    await seedWritableUpload(migrationPool, {
      createdAt: new Date(uploadFixtureNow.getTime() - 60_000),
      expiresAt: uploadFixtureNow,
    })
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })

    expect(response.statusCode).toBe(410)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({
      code: 'UPLOAD_EXPIRED',
      retryable: false,
    })
    expect(storage.uploadPart).not.toHaveBeenCalled()
    const state = await migrationPool.query<{
      abort_reason: string
      next_abort_at: Date | null
      status: string
    }>(
      `select status, abort_reason, next_abort_at
         from media_app.upload_sessions where id = $1`,
      [uploadFixtureId],
    )
    expect(state.rows[0]).toMatchObject({
      status: 'aborting',
      abort_reason: 'expired',
      next_abort_at: uploadFixtureNow,
    })
    await app.close()
  })

  it('requires the first part before accepting a later part', async () => {
    await seedWritableUpload(migrationPool, { partSizes: twoPartFixtureSizes })
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
      partNumber: 2,
    })

    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'FIRST_PART_REQUIRED' })
    expect(storage.uploadPart).not.toHaveBeenCalled()
    await app.close()
  })

  it('hides another user upload behind ownership-as-not-found', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const acquirePart = vi.fn<PartUploadConcurrency['acquirePart']>()
    const app = fixtureApp(storage.storage, { concurrency: { acquirePart } })

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
      token: 'other-access-token',
    })

    expect(response.statusCode).toBe(404)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'UPLOAD_NOT_FOUND' })
    expect(acquirePart).not.toHaveBeenCalled()
    expect(storage.uploadPart).not.toHaveBeenCalled()
    await app.close()
  })

  it('drains multipart and returns promptly when the same part lock is already held', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const concurrency = new PostgresUploadConcurrency({ pool: runtimePool })
    const held = await concurrency.acquirePart({
      uploadId: uploadFixtureId,
      partNumber: 1,
      userId: uploadOwnerUserId,
    })
    const app = fixtureApp(storage.storage, { concurrency })

    try {
      const response = await postPart({
        app,
        chunk: validPngChunk,
        chunkSizeBytes: String(validPngChunk.length),
      })

      expect(response.statusCode).toBe(409)
      expect(response.json<ErrorEnvelope>().error).toMatchObject({
        code: 'PART_UPLOAD_IN_PROGRESS',
        retryable: true,
      })
      expect(storage.uploadPart).not.toHaveBeenCalled()
    } finally {
      await held.release()
      await app.close()
    }
  })

  it.each([
    { label: 'a missing size field', chunkSizeBytes: undefined },
    { label: 'a non-decimal size', chunkSizeBytes: '16.0' },
    { label: 'an extra field', chunkSizeBytes: '16', extraField: true },
  ])('rejects $label as invalid multipart input', async ({ chunkSizeBytes, extraField }) => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: validPngChunk,
      ...(chunkSizeBytes === undefined ? {} : { chunkSizeBytes }),
      ...(extraField === undefined ? {} : { extraField }),
    })

    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'VALIDATION_ERROR' })
    const state = await migrationPool.query<{ status: string }>(
      `select status from media_app.upload_parts
        where upload_session_id = $1 and part_number = 1`,
      [uploadFixtureId],
    )
    expect(state.rows[0]?.status).toBe('pending')
    await app.close()
  })

  it('drains a large file after an invalid field that appears before it', async () => {
    await seedWritableUpload(migrationPool)
    const largeChunk = Buffer.alloc(1024 * 1024, 0x42)
    validPngChunk.copy(largeChunk, 0, 0, 8)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: largeChunk,
      chunkSizeBytes: '16.0',
    })

    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(storage.uploadPart).not.toHaveBeenCalled()
    const part = await migrationPool.query<{ status: string }>(
      `select status from media_app.upload_parts
        where upload_session_id = $1 and part_number = 1`,
      [uploadFixtureId],
    )
    expect(part.rows[0]?.status).toBe('pending')
    await app.close()
  })

  it('drains a large file when the checksum header is malformed', async () => {
    await seedWritableUpload(migrationPool)
    const largeChunk = Buffer.alloc(1024 * 1024, 0x42)
    validPngChunk.copy(largeChunk, 0, 0, 8)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: largeChunk,
      chunkSizeBytes: String(largeChunk.length),
      sha: 'not-a-sha256',
    })

    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(storage.uploadPart).not.toHaveBeenCalled()
    await app.close()
  })

  it('closes an unauthorized multipart request without accepting its large body', async () => {
    const largeChunk = Buffer.alloc(1024 * 1024, 0x42)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)
    const payload = multipartPayload({
      boundary,
      chunk: largeChunk,
      chunkSizeBytes: String(largeChunk.length),
    })

    const response = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadFixtureId}/parts/1`,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-chunk-sha256': sha256(largeChunk),
      },
      payload,
    })

    expect(response.statusCode).toBe(401)
    expect(response.headers.connection).toBe('close')
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'UNAUTHORIZED' })
    expect(storage.uploadPart).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects an oversized multipart part header before storage', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chunkSizeBytes"\r\n\r\n${String(
          validPngChunk.length,
        )}\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="${'a'.repeat(
          4_096,
        )}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      validPngChunk,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])

    const response = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadFixtureId}/parts/1`,
      headers: {
        authorization: 'Bearer owner-access-token',
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-chunk-sha256': sha256(validPngChunk),
      },
      payload,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(storage.uploadPart).not.toHaveBeenCalled()
    await app.close()
  })

  it('maps a truncated multipart body to a public validation error without confirming the part', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chunkSizeBytes"\r\n\r\n${String(
          validPngChunk.length,
        )}\r\n`,
      ),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="chunk"; filename="chunk.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      validPngChunk,
    ])

    const response = await app.inject({
      method: 'POST',
      url: `/v1/uploads/${uploadFixtureId}/parts/1`,
      headers: {
        authorization: 'Bearer owner-access-token',
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-chunk-sha256': sha256(validPngChunk),
      },
      payload,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'VALIDATION_ERROR' })
    const part = await migrationPool.query<{ status: string }>(
      `select status from media_app.upload_parts
        where upload_session_id = $1 and part_number = 1`,
      [uploadFixtureId],
    )
    expect(part.rows[0]?.status).toBe('pending')
    await app.close()
  })

  it('blocks an in-flight access token immediately after the owner is disabled', async () => {
    await seedWritableUpload(migrationPool)
    await migrationPool.query(`update media_app.users set status = 'disabled' where id = $1`, [
      uploadOwnerUserId,
    ])
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })

    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'USER_DISABLED' })
    expect(storage.uploadPart).not.toHaveBeenCalled()
    await app.close()
  })

  it('refuses to confirm a storage part when the owner is disabled during transfer', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    storage.uploadPart.mockImplementationOnce(async (input) => {
      await collect(input.body)
      await migrationPool.query(`update media_app.users set status = 'disabled' where id = $1`, [
        uploadOwnerUserId,
      ])
      return { etag: 'private-disabled-during-transfer-etag' }
    })
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
    })

    expect(response.statusCode).toBe(403)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'USER_DISABLED' })
    const part = await migrationPool.query<{
      checksum_sha256: Buffer | null
      status: string
    }>(
      `select status, checksum_sha256 from media_app.upload_parts
        where upload_session_id = $1 and part_number = 1`,
      [uploadFixtureId],
    )
    expect(part.rows[0]).toEqual({ status: 'pending', checksum_sha256: null })
    await app.close()
  })

  it('uses one user-to-media lock order for validation abort and part confirmation', async () => {
    await seedWritableUpload(migrationPool, { partSizes: [16, 16] })
    const ids = createSecureIdGenerator(clock)
    const repository = new PostgresUploadRepository({ pool: runtimePool, clock, ids })
    const common = {
      uploadId: uploadFixtureId,
      mediaId: mediaFixtureId,
      userId: uploadOwnerUserId,
      bucket: privateFixtureBucket,
      objectKey: privateFixtureKey,
      r2UploadId: privateFixtureMultipartId,
      expectedSizeBytes: 16,
      expectedTotalBytes: 32,
      expectedPartCount: 2,
      mimeType: 'image/png',
      canonicalExtension: '.png',
    } as const
    const validationPart: PreparedPartIdentity = { ...common, partNumber: 1 }
    const confirmationPart: PreparedPartIdentity = { ...common, partNumber: 2 }
    const context = {
      requestId: '01981d0c-ec80-7000-8000-000000000301',
      sessionId: uploadOwnerSessionId,
      sourceIp: '127.0.0.1',
    }
    const blocker = await runtimePool.connect()
    await blocker.query('begin')
    await blocker.query(`select id from media_app.media_objects where id = $1 for update`, [
      mediaFixtureId,
    ])

    try {
      const validation = repository.scheduleValidationAbort({
        prepared: validationPart,
        failureCode: 'MIME_MISMATCH',
        context,
      })
      void validation.catch(() => undefined)
      await waitForRuntimeLockWaiters(1)
      const confirmation = repository.confirmPart({
        prepared: confirmationPart,
        actualSizeBytes: 16,
        checksumSha256: Buffer.alloc(32, 0x42),
        etag: 'private-lock-order-etag',
        context,
      })
      void confirmation.catch(() => undefined)
      await waitForRuntimeLockWaiters(2)
      await blocker.query('commit')

      const [validationResult, confirmationResult] = await Promise.allSettled([
        validation,
        confirmation,
      ])
      expect(validationResult.status).toBe('fulfilled')
      expect(confirmationResult).toMatchObject({
        status: 'rejected',
        reason: { code: 'UPLOAD_NOT_WRITABLE' },
      })
      for (const result of [validationResult, confirmationResult]) {
        if (result.status === 'rejected') {
          expect(result.reason).not.toMatchObject({ code: '40P01' })
        }
      }
    } finally {
      await blocker.query('rollback').catch(() => undefined)
      blocker.release()
    }
  })

  it('does not deadlock a refresh session against part-confirmation audit locks', async () => {
    await seedWritableUpload(migrationPool)
    const ids = createSecureIdGenerator(clock)
    const uploadRepository = new PostgresUploadRepository({ pool: runtimePool, clock, ids })
    const authRepository = new PostgresAuthRepository({ pool: runtimePool, clock, ids })
    const prepared: PreparedPartIdentity = {
      uploadId: uploadFixtureId,
      mediaId: mediaFixtureId,
      userId: uploadOwnerUserId,
      partNumber: 1,
      bucket: privateFixtureBucket,
      objectKey: privateFixtureKey,
      r2UploadId: privateFixtureMultipartId,
      expectedSizeBytes: validPngChunk.length,
      expectedTotalBytes: validPngChunk.length,
      expectedPartCount: 1,
      mimeType: 'image/png',
      canonicalExtension: '.png',
    }
    const context = {
      requestId: '01981d0c-ec80-7000-8000-000000000302',
      sessionId: uploadOwnerSessionId,
      sourceIp: '127.0.0.1',
    }
    const blocker = await runtimePool.connect()
    await blocker.query('begin')
    await blocker.query(`select id from media_app.users where id = $1 for update`, [
      uploadOwnerUserId,
    ])

    try {
      const confirmation = uploadRepository.confirmPart({
        prepared,
        actualSizeBytes: validPngChunk.length,
        checksumSha256: Buffer.from(sha256(validPngChunk), 'hex'),
        etag: 'private-refresh-lock-order-etag',
        context,
      })
      void confirmation.catch(() => undefined)
      await waitForRuntimeLockWaiters(1)
      const refresh = authRepository.rotateRefresh({
        refreshTokenHash: Buffer.alloc(32, 7),
        nextRefreshTokenHash: Buffer.alloc(32, 9),
        refreshExpiresAt: new Date('2026-08-14T05:00:00.000Z'),
        context,
      })
      void refresh.catch(() => undefined)
      await waitForRuntimeLockWaiters(2)
      await blocker.query('commit')

      const [confirmationResult, refreshResult] = await Promise.allSettled([confirmation, refresh])
      expect(confirmationResult.status).toBe('fulfilled')
      expect(refreshResult).toMatchObject({
        status: 'fulfilled',
        value: { kind: 'rotated' },
      })
      for (const result of [confirmationResult, refreshResult]) {
        if (result.status === 'rejected') {
          expect(result.reason).not.toMatchObject({ code: '40P01' })
        }
      }
    } finally {
      await blocker.query('rollback').catch(() => undefined)
      blocker.release()
    }
  })

  it('rejects a non-lowercase SHA-256 header before storage', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
      sha: sha256(validPngChunk).toUpperCase(),
    })

    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(storage.uploadPart).not.toHaveBeenCalled()
    await app.close()
  })

  it('rejects a streamed file above the fixed 8 MiB part limit', async () => {
    await seedWritableUpload(migrationPool, { partSizes: [PART_SIZE_BYTES] })
    const oversized = Buffer.alloc(PART_SIZE_BYTES + 1, 0x42)
    validPngChunk.copy(oversized, 0, 0, 8)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: oversized,
      chunkSizeBytes: String(PART_SIZE_BYTES),
      sha: sha256(oversized),
    })

    expect(response.statusCode).toBe(413)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({
      code: 'PART_TOO_LARGE',
      retryable: false,
    })
    const state = await migrationPool.query<{ status: string }>(
      `select status from media_app.upload_parts
        where upload_session_id = $1 and part_number = 1`,
      [uploadFixtureId],
    )
    expect(state.rows[0]?.status).toBe('pending')
    await app.close()
  })

  it('rejects a declared or streamed part length different from the persisted plan', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const declaredMismatch = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length - 1),
    })
    const shortBody = validPngChunk.subarray(0, validPngChunk.length - 1)
    const actualMismatch = await postPart({
      app,
      chunk: shortBody,
      chunkSizeBytes: String(validPngChunk.length),
      sha: sha256(shortBody),
    })
    const longBody = Buffer.alloc(1024 * 1024, 0x42)
    validPngChunk.copy(longBody, 0, 0, 8)
    const overlongBody = await postPart({
      app,
      chunk: longBody,
      chunkFirst: true,
      chunkSizeBytes: String(validPngChunk.length),
      sha: sha256(longBody),
    })

    for (const response of [declaredMismatch, actualMismatch, overlongBody]) {
      expect(response.statusCode).toBe(422)
      expect(response.json<ErrorEnvelope>().error).toMatchObject({
        code: 'PART_LENGTH_MISMATCH',
        retryable: false,
      })
    }
    const state = await migrationPool.query<{ confirmed_size_bytes: string; status: string }>(
      `select status, confirmed_size_bytes::text
         from media_app.upload_sessions where id = $1`,
      [uploadFixtureId],
    )
    expect(state.rows[0]).toEqual({ status: 'uploading', confirmed_size_bytes: '0' })
    await app.close()
  })

  it('aborts stalled storage when the declared multipart size differs from the plan', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const observation = stallUploadPartUntilAbort(storage)
    const app = fixtureApp(storage.storage, { uploadPartTimeoutMs: 1_000 })
    const startedAt = performance.now()

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length - 1),
    })

    expect(performance.now() - startedAt).toBeLessThan(500)
    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({
      code: 'PART_LENGTH_MISMATCH',
    })
    expect(observation.signal?.aborted).toBe(true)
    await app.close()
  })

  it('defensively refuses a stale confirmation that targets a verified part', async () => {
    await seedWritableUpload(migrationPool)
    await migrationPool.query(
      `update media_app.upload_parts
          set status = 'verified', actual_size_bytes = expected_size_bytes,
              checksum_sha256 = $3, r2_etag = $4, uploaded_at = $5, verified_at = $5
        where upload_session_id = $1 and part_number = $2`,
      [
        uploadFixtureId,
        1,
        Buffer.from(sha256(validPngChunk), 'hex'),
        'private-verified-etag',
        uploadFixtureNow,
      ],
    )
    const repository = new PostgresUploadRepository({
      pool: runtimePool,
      clock,
      ids: createSecureIdGenerator(clock),
    })
    const prepared: PreparedPartIdentity = {
      uploadId: uploadFixtureId,
      mediaId: mediaFixtureId,
      userId: uploadOwnerUserId,
      partNumber: 1,
      bucket: privateFixtureBucket,
      objectKey: privateFixtureKey,
      r2UploadId: privateFixtureMultipartId,
      expectedSizeBytes: validPngChunk.length,
      expectedTotalBytes: validPngChunk.length,
      expectedPartCount: 1,
      mimeType: 'image/png',
      canonicalExtension: '.png',
    }

    await expect(
      repository.confirmPart({
        prepared,
        actualSizeBytes: validPngChunk.length,
        checksumSha256: Buffer.alloc(32, 0x55),
        etag: 'private-stale-etag',
        context: {
          requestId: '01981d0c-ec80-7000-8000-000000000303',
          sessionId: uploadOwnerSessionId,
          sourceIp: '127.0.0.1',
        },
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_NOT_WRITABLE', statusCode: 409 })
    const persisted = await migrationPool.query<{ checksum: string; status: string }>(
      `select status, encode(checksum_sha256, 'hex') as checksum
         from media_app.upload_parts
        where upload_session_id = $1 and part_number = 1`,
      [uploadFixtureId],
    )
    expect(persisted.rows[0]).toEqual({
      status: 'verified',
      checksum: sha256(validPngChunk),
    })
  })

  it('does not expose owner existence through malformed part numbers', async () => {
    await seedWritableUpload(migrationPool)
    const storage = storageFixture()
    const app = fixtureApp(storage.storage)

    const response = await postPart({
      app,
      chunk: validPngChunk,
      chunkSizeBytes: String(validPngChunk.length),
      partNumber: 2,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({ code: 'PART_NUMBER_INVALID' })
    expect(storage.uploadPart).not.toHaveBeenCalled()
    await app.close()
  })
})
