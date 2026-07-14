/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import { PART_SIZE_BYTES, type ErrorEnvelope } from '@wx-upload/contracts'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildAppShell } from '../../src/app.js'
import type { AccessTokenVerifier } from '../../src/auth/auth-routes.js'
import { applyRoleGrants } from '../../src/db/grants.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import { ApiError } from '../../src/http/errors.js'
import { createSecureIdGenerator } from '../../src/lib/id.js'
import { Finalizer } from '../../src/uploads/finalizer.js'
import { ObjectStorageError, type ObjectStorage } from '../../src/uploads/object-storage.js'
import { PostgresUploadRepository } from '../../src/uploads/upload-repository.js'
import { registerUploadRoutes } from '../../src/uploads/upload-routes.js'
import { type ExclusiveUploadConcurrency, UploadService } from '../../src/uploads/upload-service.js'
import { loadDestructiveDatabaseTestConfig } from '../support/destructive-database.js'
import { fakeDependencies } from '../support/fakes.js'
import {
  mediaFixtureId,
  privateFixtureBucket,
  privateFixtureMultipartId,
  seedUploadIdentities,
  seedWritableUpload,
  twoPartFixtureSizes,
  uploadFixtureId,
  uploadFixtureNow,
  uploadOwnerSessionId,
  uploadOwnerUserId,
} from '../support/upload-fixture.js'

const databaseConfig = loadDestructiveDatabaseTestConfig(process.env)
const clock = { now: () => uploadFixtureNow }
const completeKey = '01981e34-6c80-7000-8000-000000000001'

const tokens: AccessTokenVerifier = {
  verifyAccessToken: () => Promise.resolve({ sub: uploadOwnerUserId, sid: uploadOwnerSessionId }),
}

function storageFixture(): ObjectStorage {
  return {
    ready: vi.fn<ObjectStorage['ready']>().mockResolvedValue(true),
    createMultipart: vi
      .fn<ObjectStorage['createMultipart']>()
      .mockResolvedValue({ uploadId: privateFixtureMultipartId }),
    listMultipartUploads: vi.fn<ObjectStorage['listMultipartUploads']>().mockResolvedValue([]),
    uploadPart: vi.fn<ObjectStorage['uploadPart']>().mockResolvedValue({ etag: 'part-etag' }),
    listParts: vi.fn<ObjectStorage['listParts']>().mockResolvedValue([]),
    completeMultipart: vi
      .fn<ObjectStorage['completeMultipart']>()
      .mockResolvedValue({ etag: 'complete-etag' }),
    abortMultipart: vi.fn<ObjectStorage['abortMultipart']>().mockResolvedValue(undefined),
    headObject: vi.fn<ObjectStorage['headObject']>().mockResolvedValue(null),
  }
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

async function seedReadyForComplete(options: { missingPart?: number; expiresAt?: Date } = {}) {
  await seedWritableUpload(migrationPool, {
    partSizes: twoPartFixtureSizes,
    ...(options.expiresAt === undefined
      ? {}
      : {
          createdAt: new Date(options.expiresAt.getTime() - 1_000),
          expiresAt: options.expiresAt,
        }),
  })
  for (const partNumber of [1, 2]) {
    if (partNumber === options.missingPart) continue
    await migrationPool.query(
      `update media_app.upload_parts
          set status = 'uploaded', actual_size_bytes = expected_size_bytes,
              checksum_sha256 = $3, r2_etag = $4, uploaded_at = $5
        where upload_session_id = $1 and part_number = $2`,
      [
        uploadFixtureId,
        partNumber,
        Buffer.alloc(32, partNumber),
        `private-part-etag-${String(partNumber)}`,
        uploadFixtureNow,
      ],
    )
  }
  const confirmedParts = options.missingPart === undefined ? 2 : 1
  const confirmedBytes =
    options.missingPart === 1
      ? twoPartFixtureSizes[1]
      : options.missingPart === 2
        ? twoPartFixtureSizes[0]
        : twoPartFixtureSizes.reduce((total, size) => total + size, 0)
  await migrationPool.query(
    `update media_app.upload_sessions
        set confirmed_size_bytes = $2, confirmed_part_count = $3
      where id = $1`,
    [uploadFixtureId, confirmedBytes, confirmedParts],
  )
}

function fixtureApp(options: { busy?: boolean } = {}) {
  const storage = storageFixture()
  const ids = createSecureIdGenerator(clock)
  const repository = new PostgresUploadRepository({ pool: runtimePool, clock, ids })
  const acquireExclusiveUpload = options.busy
    ? vi.fn().mockRejectedValue(
        new ApiError({
          code: 'UPLOAD_BUSY',
          message: 'UPLOAD_BUSY',
          retryable: true,
          statusCode: 409,
        }),
      )
    : vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) })
  const concurrency = {
    acquirePart: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
  }
  const uploads = new UploadService({
    bucket: privateFixtureBucket,
    clock,
    ids,
    repository,
    storage,
    concurrency,
    exclusiveConcurrency: { acquireExclusiveUpload },
  })
  const app = buildAppShell(fakeDependencies({ pool: runtimePool, clock, ids }))
  registerUploadRoutes(app, { uploads, tokens })
  return { app, acquireExclusiveUpload, storage }
}

function postComplete(app: ReturnType<typeof buildAppShell>, key = completeKey) {
  return app.inject({
    method: 'POST',
    url: `/v1/uploads/${uploadFixtureId}/complete`,
    headers: {
      authorization: 'Bearer owner-access-token',
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    payload: {},
  })
}

describe('POST /v1/uploads/:uploadId/complete', () => {
  it('persists finalizing before returning 202 and never completes R2 in the request', async () => {
    await seedReadyForComplete()
    const fixture = fixtureApp()

    const response = await postComplete(fixture.app)

    expect(response.statusCode, response.body).toBe(202)
    expect(response.json()).toMatchObject({
      data: {
        upload: {
          id: uploadFixtureId,
          status: 'finalizing',
          progress: {
            confirmedBytes: PART_SIZE_BYTES + 16,
            totalBytes: PART_SIZE_BYTES + 16,
            percent: 100,
          },
        },
        pollAfterSeconds: 2,
      },
    })
    const state = await migrationPool.query<{
      next_finalize_at: Date | null
      status: string
    }>(`select status, next_finalize_at from media_app.upload_sessions where id = $1`, [
      uploadFixtureId,
    ])
    expect(state.rows[0]).toMatchObject({
      status: 'completing',
      next_finalize_at: uploadFixtureNow,
    })
    expect(fixture.storage.completeMultipart).not.toHaveBeenCalled()
    expect(fixture.acquireExclusiveUpload).toHaveBeenCalledWith({
      uploadId: uploadFixtureId,
      waitMs: 8_000,
    })
    await fixture.app.close()
  })

  it('replays the first 202 response after the upload reaches uploaded', async () => {
    await seedReadyForComplete()
    const fixture = fixtureApp()
    const first = await postComplete(fixture.app)
    await migrationPool.query(
      `update media_app.upload_parts
          set status = 'verified', verified_at = $2
        where upload_session_id = $1`,
      [uploadFixtureId, uploadFixtureNow],
    )
    await migrationPool.query(
      `update media_app.upload_sessions
          set status = 'completed', completed_at = $2, next_finalize_at = null
        where id = $1`,
      [uploadFixtureId, uploadFixtureNow],
    )
    await migrationPool.query(
      `update media_app.media_objects
          set storage_status = 'ready', verified_content_type = declared_content_type,
              verified_size_bytes = declared_size_bytes, object_etag = 'private-final-etag',
              uploaded_at = $2
        where id = $1`,
      [mediaFixtureId, uploadFixtureNow],
    )

    const replay = await postComplete(fixture.app)

    expect(first.statusCode).toBe(202)
    expect(replay.statusCode).toBe(202)
    expect(replay.headers['idempotency-replayed']).toBe('true')
    expect(replay.json()).toMatchObject({ data: first.json<{ data: unknown }>().data })
    await fixture.app.close()
  })

  it('returns missing part numbers without reserving the complete key', async () => {
    await seedReadyForComplete({ missingPart: 2 })
    const fixture = fixtureApp()

    const response = await postComplete(fixture.app)

    expect(response.statusCode).toBe(409)
    expect(response.json<ErrorEnvelope>().error).toMatchObject({
      code: 'PARTS_INCOMPLETE',
      retryable: false,
      details: { missingPartNumbers: [2] },
    })
    const idempotency = await migrationPool.query<{ count: string }>(
      `select count(*)::text as count from media_app.idempotency_records
        where operation = 'upload.complete' and idempotency_key = $1`,
      [completeKey],
    )
    expect(idempotency.rows[0]?.count).toBe('0')
    await fixture.app.close()
  })

  it('atomically schedules expiry and stably replays 410', async () => {
    await seedReadyForComplete({ expiresAt: uploadFixtureNow })
    const fixture = fixtureApp()

    const first = await postComplete(fixture.app)
    const replay = await postComplete(fixture.app)

    expect(first.statusCode).toBe(410)
    expect(first.json<ErrorEnvelope>().error).toMatchObject({ code: 'UPLOAD_EXPIRED' })
    expect(replay.statusCode).toBe(410)
    expect(replay.headers['idempotency-replayed']).toBe('true')
    const state = await migrationPool.query<{
      abort_reason: string
      next_abort_at: Date | null
      status: string
    }>(`select status, abort_reason, next_abort_at from media_app.upload_sessions where id = $1`, [
      uploadFixtureId,
    ])
    expect(state.rows[0]).toEqual({
      status: 'aborting',
      abort_reason: 'expired',
      next_abort_at: uploadFixtureNow,
    })
    await fixture.app.close()
  })

  it('returns UPLOAD_BUSY before creating idempotency state', async () => {
    await seedReadyForComplete()
    const fixture = fixtureApp({ busy: true })

    const response = await postComplete(fixture.app)

    expect(response.statusCode).toBe(409)
    expect(response.headers['retry-after']).toBe('1')
    expect(response.json<ErrorEnvelope>().error).toMatchObject({
      code: 'UPLOAD_BUSY',
      retryable: true,
    })
    const idempotency = await migrationPool.query<{ count: string }>(
      `select count(*)::text as count from media_app.idempotency_records
        where operation = 'upload.complete'`,
    )
    expect(idempotency.rows[0]?.count).toBe('0')
    await fixture.app.close()
  })
})

async function seedCompleting(options: { expiresAt?: Date } = {}) {
  await seedReadyForComplete(options)
  await migrationPool.query(
    `update media_app.upload_sessions
        set status = 'completing', next_finalize_at = $2
      where id = $1`,
    [uploadFixtureId, uploadFixtureNow],
  )
}

function matchingR2Parts() {
  return twoPartFixtureSizes.map((sizeBytes, index) => ({
    partNumber: index + 1,
    etag: `private-part-etag-${String(index + 1)}`,
    sizeBytes,
  }))
}

function finalizerFixture(
  input: {
    now?: () => Date
    storage?: ObjectStorage
    random?: () => number
    acquireExclusiveUpload?: ReturnType<
      typeof vi.fn<ExclusiveUploadConcurrency['acquireExclusiveUpload']>
    >
  } = {},
) {
  const workerClock = { now: input.now ?? (() => uploadFixtureNow) }
  const storage = input.storage ?? storageFixture()
  const acquireExclusiveUpload =
    input.acquireExclusiveUpload ??
    vi
      .fn<ExclusiveUploadConcurrency['acquireExclusiveUpload']>()
      .mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) })
  const criticalReconciliation = vi.fn()
  const finalizer = new Finalizer({
    pool: runtimePool,
    storage,
    concurrency: { acquireExclusiveUpload },
    clock: workerClock,
    ids: createSecureIdGenerator(workerClock),
    alerts: { criticalReconciliation },
    random: input.random ?? (() => 0.5),
    operationTimeoutMs: 5_000,
  })
  return { acquireExclusiveUpload, criticalReconciliation, finalizer, storage }
}

async function lifecycleState() {
  const result = await migrationPool.query<{
    abort_reason: string | null
    confirmed_part_count: number
    confirmed_size_bytes: string
    failure_code: string | null
    media_status: string
    next_abort_at: Date | null
    next_finalize_at: Date | null
    status: string
  }>(
    `select u.status, u.abort_reason, u.confirmed_size_bytes::text,
            u.confirmed_part_count, u.next_finalize_at, u.next_abort_at,
            u.failure_code, m.storage_status as media_status
       from media_app.upload_sessions u
       join media_app.media_objects m on m.id = u.media_object_id
      where u.id = $1`,
    [uploadFixtureId],
  )
  return result.rows[0]
}

describe('Finalizer.runOnce', () => {
  it('surfaces an unexpected advisory-lock failure to the supervisor', async () => {
    await seedCompleting()
    const gateFailure = new Error('database lock query failed')
    const acquireExclusiveUpload = vi
      .fn<ExclusiveUploadConcurrency['acquireExclusiveUpload']>()
      .mockRejectedValue(gateFailure)
    const fixture = finalizerFixture({ acquireExclusiveUpload })

    await expect(fixture.finalizer.runOnce(10)).rejects.toBe(gateFailure)
  })

  it('repairs a lost Complete response by HEAD without completing a second time', async () => {
    await seedCompleting()
    const storage = storageFixture()
    vi.mocked(storage.headObject).mockResolvedValue({
      sizeBytes: PART_SIZE_BYTES + 16,
      contentType: 'image/png',
      etag: 'private-final-etag',
      metadata: { mediaId: mediaFixtureId, userId: uploadOwnerUserId },
    })
    const fixture = finalizerFixture({ storage })

    await expect(fixture.finalizer.runOnce(10)).resolves.toMatchObject({ succeeded: 1 })

    expect(storage.completeMultipart).not.toHaveBeenCalled()
    expect(await lifecycleState()).toMatchObject({
      status: 'completed',
      media_status: 'ready',
      next_finalize_at: null,
    })
    const parts = await migrationPool.query<{ status: string }>(
      `select status from media_app.upload_parts where upload_session_id = $1 order by part_number`,
      [uploadFixtureId],
    )
    expect(parts.rows).toEqual([{ status: 'verified' }, { status: 'verified' }])
  })

  it('validates the persisted manifest, completes multipart, then verifies HEAD', async () => {
    await seedCompleting()
    const storage = storageFixture()
    vi.mocked(storage.headObject)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        sizeBytes: PART_SIZE_BYTES + 16,
        contentType: 'image/png',
        etag: 'head-etag',
        metadata: { mediaId: mediaFixtureId, userId: uploadOwnerUserId },
      })
    vi.mocked(storage.listParts).mockResolvedValue(matchingR2Parts())
    const fixture = finalizerFixture({ storage })

    await fixture.finalizer.runOnce(10)

    expect(storage.completeMultipart).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: privateFixtureBucket,
        uploadId: privateFixtureMultipartId,
        parts: [
          { partNumber: 1, etag: 'private-part-etag-1' },
          { partNumber: 2, etag: 'private-part-etag-2' },
        ],
        signal: expect.any(AbortSignal),
      }),
    )
    expect(await lifecycleState()).toMatchObject({ status: 'completed', media_status: 'ready' })
  })

  it('returns a pre-expiry mismatch to uploading and resets only affected confirmations', async () => {
    await seedCompleting()
    const storage = storageFixture()
    vi.mocked(storage.headObject).mockResolvedValue(null)
    vi.mocked(storage.listParts).mockResolvedValue(matchingR2Parts().slice(0, 1))
    const fixture = finalizerFixture({ storage })

    await fixture.finalizer.runOnce(10)

    expect(await lifecycleState()).toMatchObject({
      status: 'uploading',
      confirmed_size_bytes: String(PART_SIZE_BYTES),
      confirmed_part_count: 1,
      next_finalize_at: null,
    })
    const parts = await migrationPool.query<{
      actual_size_bytes: number | null
      r2_etag: string | null
      status: string
    }>(
      `select status, actual_size_bytes, r2_etag
         from media_app.upload_parts
        where upload_session_id = $1 order by part_number`,
      [uploadFixtureId],
    )
    expect(parts.rows).toEqual([
      {
        status: 'uploaded',
        actual_size_bytes: PART_SIZE_BYTES,
        r2_etag: 'private-part-etag-1',
      },
      { status: 'pending', actual_size_bytes: null, r2_etag: null },
    ])
  })

  it('schedules abort when the multipart manifest mismatch is known at expiry', async () => {
    await seedCompleting({ expiresAt: uploadFixtureNow })
    const storage = storageFixture()
    vi.mocked(storage.headObject).mockResolvedValue(null)
    vi.mocked(storage.listParts).mockResolvedValue([])
    const fixture = finalizerFixture({ storage })

    await fixture.finalizer.runOnce(10)

    expect(await lifecycleState()).toMatchObject({
      status: 'aborting',
      abort_reason: 'expired',
      next_abort_at: uploadFixtureNow,
      next_finalize_at: null,
    })
  })

  it('fails and alerts without deleting an object whose HEAD size is wrong', async () => {
    await seedCompleting()
    const storage = storageFixture()
    vi.mocked(storage.headObject).mockResolvedValue({
      sizeBytes: PART_SIZE_BYTES + 15,
      etag: 'wrong-size-etag',
    })
    const fixture = finalizerFixture({ storage })

    await fixture.finalizer.runOnce(10)

    expect(await lifecycleState()).toMatchObject({
      status: 'failed',
      media_status: 'failed',
      failure_code: 'STORAGE_OBJECT_SIZE_MISMATCH',
      next_finalize_at: null,
    })
    expect(fixture.criticalReconciliation).toHaveBeenCalledWith('STORAGE_OBJECT_SIZE_MISMATCH')
    expect(storage).not.toHaveProperty('deleteObject')
  })

  it('fails closed when an equal-sized object has different private metadata', async () => {
    await seedCompleting()
    const storage = storageFixture()
    vi.mocked(storage.headObject).mockResolvedValue({
      sizeBytes: PART_SIZE_BYTES + 16,
      contentType: 'image/jpeg',
      etag: 'wrong-object-etag',
      metadata: { mediaId: mediaFixtureId, userId: '01981d0c-ec80-7000-8000-000000000111' },
    })
    const fixture = finalizerFixture({ storage })

    await fixture.finalizer.runOnce(10)

    expect(await lifecycleState()).toMatchObject({
      status: 'failed',
      media_status: 'failed',
      failure_code: 'STORAGE_UNAVAILABLE',
      next_finalize_at: null,
    })
    expect(fixture.criticalReconciliation).toHaveBeenCalledWith('STORAGE_UNAVAILABLE')
    expect(storage).not.toHaveProperty('deleteObject')
  })

  it('converges definite absence of both object and multipart to storage failure', async () => {
    await seedCompleting()
    const storage = storageFixture()
    vi.mocked(storage.headObject).mockResolvedValue(null)
    vi.mocked(storage.listParts).mockRejectedValue(
      new ObjectStorageError({
        operation: 'listParts',
        certainty: 'definite',
        code: 'NOT_FOUND',
      }),
    )
    const fixture = finalizerFixture({ storage })

    await fixture.finalizer.runOnce(10)

    expect(await lifecycleState()).toMatchObject({
      status: 'failed',
      media_status: 'failed',
      failure_code: 'STORAGE_UNAVAILABLE',
    })
  })

  it('persists an ambiguous retry and a restarted worker later converges it', async () => {
    await seedCompleting()
    let now = uploadFixtureNow
    const failingStorage = storageFixture()
    vi.mocked(failingStorage.headObject).mockRejectedValue(
      new ObjectStorageError({
        operation: 'headObject',
        certainty: 'ambiguous',
        code: 'NETWORK',
      }),
    )

    const first = finalizerFixture({ now: () => now, storage: failingStorage, random: () => 0.5 })
    await first.finalizer.runOnce(10)
    const retry = await lifecycleState()
    expect(retry).toMatchObject({ status: 'completing', media_status: 'pending_upload' })
    const retryAt = retry?.next_finalize_at
    expect(retryAt?.getTime()).toBeGreaterThan(now.getTime())
    if (retryAt === null || retryAt === undefined) throw new Error('retry was not scheduled')

    now = new Date(retryAt.getTime() + 1)
    const recoveredStorage = storageFixture()
    vi.mocked(recoveredStorage.headObject).mockResolvedValue({
      sizeBytes: PART_SIZE_BYTES + 16,
      etag: 'recovered-etag',
      contentType: 'image/png',
      metadata: { mediaId: mediaFixtureId, userId: uploadOwnerUserId },
    })
    const restarted = finalizerFixture({ now: () => now, storage: recoveredStorage })
    await restarted.finalizer.runOnce(10)

    expect(await lifecycleState()).toMatchObject({ status: 'completed', media_status: 'ready' })
  })

  it('reports an ignored outcome when a concurrent row-version change rejects settlement', async () => {
    await seedCompleting()
    const storage = storageFixture()
    let headStartedResolve: (() => void) | undefined
    const headStarted = new Promise<void>((resolve) => {
      headStartedResolve = resolve
    })
    let resolveHead:
      ((value: NonNullable<Awaited<ReturnType<ObjectStorage['headObject']>>>) => void) | undefined
    const pendingHead = new Promise<NonNullable<Awaited<ReturnType<ObjectStorage['headObject']>>>>(
      (resolve) => {
        resolveHead = resolve
      },
    )
    vi.mocked(storage.headObject).mockImplementation(() => {
      headStartedResolve?.()
      return pendingHead
    })
    const fixture = finalizerFixture({ storage })

    const running = fixture.finalizer.runOnce(10)
    await headStarted
    await migrationPool.query(
      `update media_app.upload_sessions set last_activity_at = $2 where id = $1`,
      [uploadFixtureId, new Date(uploadFixtureNow.getTime() + 1)],
    )
    if (resolveHead === undefined) throw new Error('HEAD request did not start')
    resolveHead({
      sizeBytes: PART_SIZE_BYTES + 16,
      contentType: 'image/png',
      etag: 'stale-head-etag',
      metadata: { mediaId: mediaFixtureId, userId: uploadOwnerUserId },
    })

    await expect(running).resolves.toEqual({
      claimed: 1,
      failed: 0,
      repaired: 0,
      retried: 0,
      succeeded: 0,
    })
    expect(await lifecycleState()).toMatchObject({
      status: 'completing',
      media_status: 'pending_upload',
    })
  })
})
