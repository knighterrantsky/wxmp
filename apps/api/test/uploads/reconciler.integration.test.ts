/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/unbound-method */
import { createHash } from 'node:crypto'

import { PART_SIZE_BYTES, planUploadParts } from '@wx-upload/contracts'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { applyRoleGrants } from '../../src/db/grants.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import { createSecureIdGenerator } from '../../src/lib/id.js'
import { Aborter } from '../../src/uploads/aborter.js'
import { ObjectStorageError, type ObjectStorage } from '../../src/uploads/object-storage.js'
import { DeadlineScanner, Reconciler } from '../../src/uploads/reconciler.js'
import { PostgresUploadConcurrency } from '../../src/uploads/upload-concurrency.js'
import type { ExclusiveUploadConcurrency } from '../../src/uploads/upload-service.js'
import {
  PostgresUploadRepository,
  type InitializeUploadDraft,
} from '../../src/uploads/upload-repository.js'
import { loadDestructiveDatabaseTestConfig } from '../support/destructive-database.js'
import {
  mediaFixtureId,
  privateFixtureBucket,
  privateFixtureKey,
  privateFixtureMultipartId,
  seedUploadIdentities,
  seedWritableUpload,
  uploadFixtureId,
  uploadFixtureNow,
  uploadOwnerSessionId,
  uploadOwnerUserId,
  validPngChunk,
} from '../support/upload-fixture.js'

const databaseConfig = loadDestructiveDatabaseTestConfig(process.env)
const now = uploadFixtureNow
const clock = { now: () => now }
const initializeKey = '01981e34-6c80-7000-8000-000000000301'
const requestHash = createHash('sha256').update('stuck-initialization').digest()

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

async function seedStuckInitialization(input: { expiresAt?: Date } = {}) {
  const createdAt = new Date(now.getTime() - 2 * 60_000)
  await migrationPool.query(
    `insert into media_app.media_objects(
       id, user_id, kind, storage_status, original_filename,
       uploader_nickname_snapshot, declared_content_type, canonical_extension,
       declared_size_bytes, r2_bucket, object_key, create_idempotency_key,
       created_at, updated_at
     ) values ($1, $2, 'image', 'pending_upload', 'stuck.png', '小晴',
               'image/png', '.png', 16, $3, $4, $5, $6, $6)`,
    [
      mediaFixtureId,
      uploadOwnerUserId,
      privateFixtureBucket,
      privateFixtureKey,
      initializeKey,
      createdAt,
    ],
  )
  await migrationPool.query(
    `insert into media_app.upload_sessions(
       id, media_object_id, user_id, status, expected_size_bytes,
       expires_at, last_activity_at, created_at, updated_at
     ) values ($1, $2, $3, 'initiating', 16, $4, $5, $5, $5)`,
    [
      uploadFixtureId,
      mediaFixtureId,
      uploadOwnerUserId,
      input.expiresAt ?? new Date(now.getTime() + 60_000),
      createdAt,
    ],
  )
  await migrationPool.query(
    `insert into media_app.idempotency_records(
       id, principal_type, principal_id, operation, idempotency_key,
       request_hash, status, locked_until, resource_type, resource_id,
       expires_at, created_at, updated_at
     ) values ('01981e34-6c80-7000-8000-000000000302', 'user', $1,
               'upload.initialize', $2, $3, 'in_progress', $4,
               'upload_session', $5, $6, $7, $7)`,
    [
      uploadOwnerUserId,
      initializeKey,
      requestHash,
      new Date(now.getTime() - 1),
      uploadFixtureId,
      new Date(now.getTime() + 7 * 86_400_000),
      createdAt,
    ],
  )
}

function storageFixture(): ObjectStorage {
  return {
    ready: vi.fn().mockResolvedValue(true),
    createMultipart: vi.fn().mockRejectedValue(new Error('must never create')),
    listMultipartUploads: vi.fn().mockResolvedValue([]),
    uploadPart: vi.fn().mockRejectedValue(new Error('outside reconciler')),
    listParts: vi.fn().mockRejectedValue(new Error('outside reconciler')),
    completeMultipart: vi.fn().mockRejectedValue(new Error('outside reconciler')),
    abortMultipart: vi.fn().mockResolvedValue(undefined),
    headObject: vi.fn().mockResolvedValue(null),
  }
}

function reconcilerFixture(
  storage = storageFixture(),
  suppliedConcurrency?: ReturnType<
    typeof vi.fn<ExclusiveUploadConcurrency['acquireExclusiveUpload']>
  >,
) {
  const acquireExclusiveUpload =
    suppliedConcurrency ??
    vi
      .fn<ExclusiveUploadConcurrency['acquireExclusiveUpload']>()
      .mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) })
  const criticalReconciliation = vi.fn()
  return {
    storage,
    acquireExclusiveUpload,
    criticalReconciliation,
    reconciler: new Reconciler({
      pool: runtimePool,
      storage,
      concurrency: { acquireExclusiveUpload },
      clock,
      ids: createSecureIdGenerator(clock),
      alerts: { criticalReconciliation },
      operationTimeoutMs: 5_000,
    }),
  }
}

async function sagaState() {
  const result = await migrationPool.query<{
    idempotency_status: string
    media_status: string
    response_status: number | null
    upload_status: string
  }>(
    `select u.status as upload_status, m.storage_status as media_status,
            i.status as idempotency_status, i.response_status
       from media_app.upload_sessions u
       join media_app.media_objects m on m.id = u.media_object_id
       join media_app.idempotency_records i on i.resource_id = u.id
      where u.id = $1`,
    [uploadFixtureId],
  )
  return result.rows[0]
}

describe('Reconciler.runOnce', () => {
  it('surfaces an unexpected advisory-lock failure to the supervisor', async () => {
    await seedStuckInitialization()
    const gateFailure = new Error('database lock query failed')
    const acquireExclusiveUpload = vi
      .fn<ExclusiveUploadConcurrency['acquireExclusiveUpload']>()
      .mockRejectedValue(gateFailure)
    const fixture = reconcilerFixture(storageFixture(), acquireExclusiveUpload)

    await expect(fixture.reconciler.runOnce(10)).rejects.toBe(gateFailure)
  })

  it('aborts every exact-key orphan and settles the linked initialization atomically', async () => {
    await seedStuckInitialization()
    const storage = storageFixture()
    vi.mocked(storage.listMultipartUploads)
      .mockResolvedValueOnce([
        { key: privateFixtureKey, uploadId: 'orphan-one' },
        { key: `${privateFixtureKey}-not-exact`, uploadId: 'unrelated' },
        { key: privateFixtureKey, uploadId: 'orphan-two' },
      ])
      .mockResolvedValueOnce([{ key: `${privateFixtureKey}-not-exact`, uploadId: 'unrelated' }])
    const fixture = reconcilerFixture(storage)

    await expect(fixture.reconciler.runOnce(10)).resolves.toMatchObject({ settled: 1 })

    expect(storage.abortMultipart).toHaveBeenCalledTimes(2)
    expect(storage.abortMultipart).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: 'orphan-one', signal: expect.any(AbortSignal) }),
    )
    expect(storage.abortMultipart).toHaveBeenCalledWith(
      expect.objectContaining({ uploadId: 'orphan-two', signal: expect.any(AbortSignal) }),
    )
    expect(storage.createMultipart).not.toHaveBeenCalled()
    expect(await sagaState()).toEqual({
      upload_status: 'failed',
      media_status: 'failed',
      idempotency_status: 'failed',
      response_status: 503,
    })
  })

  it('leaves the saga pending when listing storage is an unknown fact', async () => {
    await seedStuckInitialization()
    const storage = storageFixture()
    vi.mocked(storage.listMultipartUploads).mockRejectedValue(
      new ObjectStorageError({
        operation: 'listMultipartUploads',
        certainty: 'ambiguous',
        code: 'NETWORK',
      }),
    )
    const fixture = reconcilerFixture(storage)

    await expect(fixture.reconciler.runOnce(10)).resolves.toMatchObject({ retried: 1 })

    expect(await sagaState()).toEqual({
      upload_status: 'initiating',
      media_status: 'pending_upload',
      idempotency_status: 'in_progress',
      response_status: null,
    })
  })

  it('fences a late initializer even if its advisory connection was lost', async () => {
    await seedStuckInitialization()
    const oldFence = await migrationPool.query<{ row_version: string }>(
      `select row_version::text
         from media_app.idempotency_records
        where operation = 'upload.initialize' and idempotency_key = $1`,
      [initializeKey],
    )
    let listEnteredResolve!: () => void
    let releaseListResolve!: () => void
    const listEntered = new Promise<void>((resolve) => {
      listEnteredResolve = resolve
    })
    const releaseList = new Promise<void>((resolve) => {
      releaseListResolve = resolve
    })
    const storage = storageFixture()
    vi.mocked(storage.listMultipartUploads).mockImplementation(async () => {
      listEnteredResolve()
      await releaseList
      return []
    })
    const fixture = reconcilerFixture(storage)
    const reconciling = fixture.reconciler.runOnce(10)
    await listEntered

    const createdAt = new Date(now.getTime() - 2 * 60_000)
    const parts = planUploadParts(16)
    const draft: InitializeUploadDraft = {
      userId: uploadOwnerUserId,
      sessionId: uploadOwnerSessionId,
      idempotencyKey: initializeKey,
      requestHash,
      mediaId: mediaFixtureId,
      uploadId: uploadFixtureId,
      bucket: privateFixtureBucket,
      objectKey: privateFixtureKey,
      fileName: 'stuck.png',
      kind: 'image',
      mimeType: 'image/png',
      sizeBytes: 16,
      canonicalExtension: '.png',
      parts,
      createdAt,
      expiresAt: new Date(now.getTime() + 60_000),
      lockedUntil: new Date(now.getTime() + 60_000),
      idempotencyExpiresAt: new Date(now.getTime() + 7 * 86_400_000),
      context: {
        requestId: '01981e34-6c80-7000-8000-000000000399',
        sourceIp: '127.0.0.1',
      },
      data: {
        upload: {
          id: uploadFixtureId,
          mediaId: mediaFixtureId,
          status: 'uploading',
          fileName: 'stuck.png',
          kind: 'image',
          mimeType: 'image/png',
          sizeBytes: 16,
          partSizeBytes: PART_SIZE_BYTES,
          partCount: 1,
          expiresAt: new Date(now.getTime() + 60_000).toISOString(),
          createdAt: createdAt.toISOString(),
        },
        parts: parts.map((part) => ({ ...part, status: 'pending' })),
      },
    }
    const repository = new PostgresUploadRepository({
      pool: runtimePool,
      clock,
      ids: createSecureIdGenerator(clock),
    })
    const oldFenceValue = oldFence.rows[0]?.row_version
    if (oldFenceValue === undefined) throw new Error('initial idempotency fence is missing')

    await expect(
      repository.completeInitialization({
        draft,
        r2UploadId: 'late-private-multipart',
        fence: BigInt(oldFenceValue),
      }),
    ).rejects.toThrow(/idempotency|completable/i)

    releaseListResolve()
    await expect(reconciling).resolves.toMatchObject({ settled: 1 })
    expect(await sagaState()).toMatchObject({
      upload_status: 'failed',
      idempotency_status: 'failed',
    })
  })
})

describe('DeadlineScanner.runOnce', () => {
  it('expires initiating and uploading sessions but never completing sessions', async () => {
    await seedStuckInitialization({ expiresAt: now })
    const completingUploadId = '01981e34-6c80-7000-8000-000000000311'
    const completingMediaId = '01981e34-6c80-7000-8000-000000000312'
    await migrationPool.query(
      `insert into media_app.media_objects(
         id, user_id, kind, storage_status, original_filename,
         uploader_nickname_snapshot, declared_content_type, canonical_extension,
         declared_size_bytes, r2_bucket, object_key, create_idempotency_key,
         created_at, updated_at
       ) values ($1, $2, 'image', 'pending_upload', 'complete.png', '小晴',
                 'image/png', '.png', 16, $3, $4, 'complete-deadline-key', $5, $5)`,
      [
        completingMediaId,
        uploadOwnerUserId,
        privateFixtureBucket,
        `${privateFixtureKey}-completing`,
        new Date(now.getTime() - 86_400_000),
      ],
    )
    await migrationPool.query(
      `insert into media_app.upload_sessions(
         id, media_object_id, user_id, status, r2_upload_id,
         expected_size_bytes, confirmed_size_bytes, confirmed_part_count,
         next_finalize_at, expires_at, last_activity_at, created_at, updated_at
       ) values ($1, $2, $3, 'completing', 'multipart-completing',
                 16, 16, 1, $4, $4, $4, $5, $5)`,
      [
        completingUploadId,
        completingMediaId,
        uploadOwnerUserId,
        now,
        new Date(now.getTime() - 86_400_000),
      ],
    )
    const scanner = new DeadlineScanner({
      pool: runtimePool,
      clock,
      ids: createSecureIdGenerator(clock),
    })

    await expect(scanner.runOnce(10)).resolves.toEqual({ scheduled: 1 })

    const states = await migrationPool.query<{ id: string; status: string; abort_reason: string }>(
      `select id, status, abort_reason from media_app.upload_sessions order by id`,
    )
    expect(states.rows).toEqual([
      { id: uploadFixtureId, status: 'aborting', abort_reason: 'expired' },
      { id: completingUploadId, status: 'completing', abort_reason: null },
    ])
  })

  it('prevents an in-flight shared-gate part from persisting and defers abort cleanup', async () => {
    await seedWritableUpload(migrationPool, {
      createdAt: new Date(now.getTime() - 1_000),
      expiresAt: now,
    })
    const concurrency = new PostgresUploadConcurrency({ pool: runtimePool, pollIntervalMs: 1 })
    const partLease = await concurrency.acquirePart({
      uploadId: uploadFixtureId,
      partNumber: 1,
      userId: uploadOwnerUserId,
    })
    const scanner = new DeadlineScanner({
      pool: runtimePool,
      clock,
      ids: createSecureIdGenerator(clock),
    })
    const storage = storageFixture()
    const aborter = new Aborter({
      pool: runtimePool,
      storage,
      concurrency,
      clock,
      ids: createSecureIdGenerator(clock),
      alerts: { criticalReconciliation: vi.fn() },
      operationTimeoutMs: 5_000,
    })
    const repository = new PostgresUploadRepository({
      pool: runtimePool,
      clock,
      ids: createSecureIdGenerator(clock),
    })

    try {
      await expect(scanner.runOnce(10)).resolves.toEqual({ scheduled: 1 })
      await expect(
        repository.confirmPart({
          prepared: {
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
          },
          actualSizeBytes: validPngChunk.length,
          checksumSha256: createHash('sha256').update(validPngChunk).digest(),
          etag: 'must-not-persist',
          context: {
            requestId: '01981e34-6c80-7000-8000-000000000398',
            sessionId: uploadOwnerSessionId,
            sourceIp: '127.0.0.1',
          },
        }),
      ).rejects.toMatchObject({ code: 'UPLOAD_NOT_WRITABLE' })
      await expect(aborter.runOnce(10)).resolves.toEqual({ claimed: 0, retried: 0, succeeded: 0 })
      expect(storage.abortMultipart).not.toHaveBeenCalled()
    } finally {
      await partLease.release()
    }

    await expect(aborter.runOnce(10)).resolves.toEqual({ claimed: 1, retried: 0, succeeded: 1 })
    expect(storage.abortMultipart).toHaveBeenCalledOnce()
    const state = await migrationPool.query<{
      part_status: string
      upload_status: string
    }>(
      `select u.status as upload_status, p.status as part_status
         from media_app.upload_sessions u
         join media_app.upload_parts p on p.upload_session_id = u.id
        where u.id = $1 and p.part_number = 1`,
      [uploadFixtureId],
    )
    expect(state.rows[0]).toEqual({ upload_status: 'expired', part_status: 'pending' })
  })
})
