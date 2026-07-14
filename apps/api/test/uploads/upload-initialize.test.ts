import type { Pool } from 'pg'
import type { InitializeUploadRequest, InitializeUploadResponse } from '@wx-upload/contracts'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildAppShell } from '../../src/app.js'
import { PostgresAuthRepository } from '../../src/auth/auth-repository.js'
import type { AccessTokenVerifier } from '../../src/auth/auth-routes.js'
import { applyRoleGrants } from '../../src/db/grants.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import { createSecureIdGenerator } from '../../src/lib/id.js'
import { ApiError } from '../../src/http/errors.js'
import {
  ObjectStorageError,
  type ObjectStorage,
  type ObjectStorageErrorCode,
  type ObjectStorageErrorCertainty,
} from '../../src/uploads/object-storage.js'
import { validateMediaPolicy } from '../../src/uploads/media-policy.js'
import { PostgresUploadRepository } from '../../src/uploads/upload-repository.js'
import { registerUploadRoutes } from '../../src/uploads/upload-routes.js'
import { UploadService } from '../../src/uploads/upload-service.js'
import { loadDestructiveDatabaseTestConfig } from '../support/destructive-database.js'
import { fakeDependencies } from '../support/fakes.js'

const databaseConfig = loadDestructiveDatabaseTestConfig(process.env)
const now = new Date('2026-07-15T03:00:00.000Z')
const clock = { now: () => now }
const userId = '01981c9e-6c80-7000-8000-000000000101'
const sessionId = '01981c9e-6c80-7000-8000-000000000102'
const familyId = '01981c9e-6c80-7000-8000-000000000103'
const bucket = 'private-bucket-sentinel'
const privateUploadId = 'r2-private-upload-id-sentinel'

const request: InitializeUploadRequest = {
  fileName: 'summer-video.mov',
  kind: 'video',
  mimeType: 'video/quicktime',
  sizeBytes: 12_582_913,
}

const publicData: InitializeUploadResponse['data'] = {
  upload: {
    id: '01981c9e-6c80-7000-8000-000000000201',
    mediaId: '01981c9e-6c80-7000-8000-000000000202',
    status: 'uploading',
    fileName: request.fileName,
    kind: request.kind,
    mimeType: request.mimeType,
    sizeBytes: request.sizeBytes,
    partSizeBytes: 8_388_608,
    partCount: 2,
    expiresAt: '2026-07-16T03:00:00.000Z',
    createdAt: '2026-07-15T03:00:00.000Z',
  },
  parts: [
    { partNumber: 1, offsetBytes: 0, sizeBytes: 8_388_608, status: 'pending' },
    { partNumber: 2, offsetBytes: 8_388_608, sizeBytes: 4_194_305, status: 'pending' },
  ],
}

const context = {
  requestId: '01981c9e-6c80-7000-8000-000000000104',
  sourceIp: '198.51.100.20',
  userAgent: 'upload-initialize-test',
}

function idempotencyKey(index: number): string {
  return `01981c9e-6c80-7000-8000-${String(index).padStart(12, '0')}`
}

function storageError(
  certainty: ObjectStorageErrorCertainty,
  code: ObjectStorageErrorCode,
): ObjectStorageError {
  return new ObjectStorageError({ certainty, code })
}

function fakeStorage() {
  let created = 0
  const createMultipart = vi.fn<ObjectStorage['createMultipart']>(() => {
    created += 1
    return Promise.resolve({
      uploadId: created === 1 ? privateUploadId : `${privateUploadId}-${String(created)}`,
    })
  })
  const storage: ObjectStorage = {
    ready: vi.fn<ObjectStorage['ready']>().mockResolvedValue(true),
    createMultipart,
    listMultipartUploads: vi.fn<ObjectStorage['listMultipartUploads']>().mockResolvedValue([]),
    uploadPart: vi.fn<ObjectStorage['uploadPart']>().mockResolvedValue({ etag: 'private-etag' }),
    listParts: vi.fn<ObjectStorage['listParts']>().mockResolvedValue([]),
    completeMultipart: vi
      .fn<ObjectStorage['completeMultipart']>()
      .mockResolvedValue({ etag: 'private-etag' }),
    abortMultipart: vi.fn<ObjectStorage['abortMultipart']>().mockResolvedValue(undefined),
    headObject: vi.fn<ObjectStorage['headObject']>().mockResolvedValue(null),
  }
  return { storage, createMultipart }
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
})

afterAll(async () => {
  await Promise.all([runtimePool.end(), migrationPool.end()])
})

async function seedUser(options: { status?: 'active' | 'disabled'; confirmed?: boolean } = {}) {
  const status = options.status ?? 'active'
  const confirmed = options.confirmed ?? true
  await migrationPool.query(
    `insert into media_app.users(
       id, status, nickname, nickname_confirmed_at, created_at, updated_at
     ) values ($1, $2, $3, $4, $5, $5)`,
    [userId, status, confirmed ? '小晴' : null, confirmed ? now : null, now],
  )
  await migrationPool.query(
    `insert into media_app.user_sessions(
       id, user_id, token_family_id, refresh_token_hash, issued_at, expires_at
     ) values ($1, $2, $3, $4, $5, $6)`,
    [sessionId, userId, familyId, Buffer.alloc(32, 1), now, new Date('2026-08-14T03:00:00Z')],
  )
}

function uploadService(
  storage: ObjectStorage,
  options: { createMultipartTimeoutMs?: number } = {},
): UploadService {
  const ids = createSecureIdGenerator(clock)
  const repository = new PostgresUploadRepository({ pool: runtimePool, clock, ids })
  return new UploadService({
    bucket,
    clock,
    ids,
    repository,
    storage,
    concurrency: {
      acquirePart: () => Promise.reject(new Error('part upload is outside this test')),
    },
    ...options,
  })
}

function initialize(
  service: UploadService,
  key: string,
  requestOverride: InitializeUploadRequest = request,
) {
  return service.initialize({
    userId,
    sessionId,
    request: requestOverride,
    idempotencyKey: key,
    context,
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

interface SagaState {
  idempotency_status: 'in_progress' | 'completed' | 'failed'
  locked_until: Date | null
  resource_id: string | null
  response_status: number | null
  response_body: unknown
  upload_status: string | null
  r2_upload_id: string | null
  media_status: string | null
  r2_bucket: string | null
  object_key: string | null
  part_count: number
}

async function sagaState(key: string): Promise<SagaState | undefined> {
  const result = await migrationPool.query<SagaState>(
    `select i.status as idempotency_status, i.locked_until, i.resource_id,
            i.response_status, i.response_body,
            u.status as upload_status, u.r2_upload_id,
            m.storage_status as media_status, m.r2_bucket, m.object_key,
            (select count(*)::integer from media_app.upload_parts p
              where p.upload_session_id = u.id) as part_count
      from media_app.idempotency_records i
      left join media_app.upload_sessions u on u.id = i.resource_id
      left join media_app.media_objects m on m.id = u.media_object_id
      where i.principal_type = 'user' and i.principal_id = $1
        and i.idempotency_key = $2`,
    [userId, key],
  )
  return result.rows[0]
}

describe('upload initialization saga', () => {
  it('returns a private-storage-redacted plan and commits the two-transaction saga', async () => {
    await seedUser()
    const storage = fakeStorage()

    const result = await initialize(uploadService(storage.storage), idempotencyKey(1))

    expect(result.replayed).toBe(false)
    expect(result.data.upload).toMatchObject({
      status: 'uploading',
      fileName: request.fileName,
      sizeBytes: request.sizeBytes,
      partSizeBytes: 8_388_608,
      partCount: 2,
    })
    expect(result.data.parts).toEqual([
      { partNumber: 1, offsetBytes: 0, sizeBytes: 8_388_608, status: 'pending' },
      { partNumber: 2, offsetBytes: 8_388_608, sizeBytes: 4_194_305, status: 'pending' },
    ])
    expect(JSON.stringify(result)).not.toMatch(
      /private-bucket-sentinel|r2-private-upload-id-sentinel|objectKey|r2UploadId|etag/i,
    )
    expect(storage.createMultipart).toHaveBeenCalledOnce()
    expect(storage.createMultipart).toHaveBeenCalledWith(
      expect.objectContaining({ bucket, contentType: request.mimeType }),
    )

    await expect(sagaState(idempotencyKey(1))).resolves.toMatchObject({
      idempotency_status: 'completed',
      locked_until: null,
      response_status: 201,
      upload_status: 'uploading',
      r2_upload_id: privateUploadId,
      media_status: 'pending_upload',
      r2_bucket: bucket,
      part_count: 2,
    })
  })

  it('replays the same stable response without creating another multipart', async () => {
    await seedUser()
    const storage = fakeStorage()
    const service = uploadService(storage.storage)
    const key = idempotencyKey(2)

    const first = await initialize(service, key)
    const replay = await initialize(service, key)

    expect(replay).toEqual({ data: first.data, replayed: true })
    expect(storage.createMultipart).toHaveBeenCalledOnce()
  })

  it('rejects a changed request under the same idempotency key', async () => {
    await seedUser()
    const storage = fakeStorage()
    const service = uploadService(storage.storage)
    const key = idempotencyKey(3)
    await initialize(service, key)

    await expect(
      initialize(service, key, { ...request, fileName: 'different-video.mov' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', statusCode: 409 })
    expect(storage.createMultipart).toHaveBeenCalledOnce()
  })

  it('rechecks the user status before replaying a completed initialization', async () => {
    await seedUser()
    const storage = fakeStorage()
    const service = uploadService(storage.storage)
    const key = idempotencyKey(6)
    await initialize(service, key)
    await migrationPool.query(`update media_app.users set status = 'disabled' where id = $1`, [
      userId,
    ])

    await expect(initialize(service, key)).rejects.toMatchObject({
      code: 'USER_DISABLED',
      statusCode: 403,
    })
    expect(storage.createMultipart).toHaveBeenCalledOnce()
  })

  it('does not complete initialization when the user is disabled during storage creation', async () => {
    await seedUser()
    const storage = fakeStorage()
    const key = idempotencyKey(7)
    storage.createMultipart.mockImplementationOnce(async () => {
      await migrationPool.query(`update media_app.users set status = 'disabled' where id = $1`, [
        userId,
      ])
      return { uploadId: privateUploadId }
    })

    await expect(initialize(uploadService(storage.storage), key)).rejects.toMatchObject({
      code: 'USER_DISABLED',
      statusCode: 403,
    })
    expect(storage.createMultipart).toHaveBeenCalledOnce()
    await expect(sagaState(key)).resolves.toMatchObject({
      idempotency_status: 'in_progress',
      upload_status: 'initiating',
      r2_upload_id: null,
      media_status: 'pending_upload',
      part_count: 0,
    })
  })

  it('does not deadlock completion against a same-key initialization retry', async () => {
    await seedUser()
    const storage = fakeStorage()
    const service = uploadService(storage.storage)
    const key = idempotencyKey(8)
    let storageEnteredResolve!: () => void
    let storageReleaseResolve!: () => void
    const storageEntered = new Promise<void>((resolve) => {
      storageEnteredResolve = resolve
    })
    const storageRelease = new Promise<void>((resolve) => {
      storageReleaseResolve = resolve
    })
    storage.createMultipart.mockImplementationOnce(async () => {
      storageEnteredResolve()
      await storageRelease
      return { uploadId: privateUploadId }
    })
    const primary = initialize(service, key)
    void primary.catch(() => undefined)
    await storageEntered
    const media = await migrationPool.query<{ id: string }>(
      `select m.id
         from media_app.idempotency_records i
         join media_app.upload_sessions u on u.id = i.resource_id
         join media_app.media_objects m on m.id = u.media_object_id
        where i.principal_type = 'user' and i.principal_id = $1
          and i.operation = 'upload.initialize' and i.idempotency_key = $2`,
      [userId, key],
    )
    const blocker = await runtimePool.connect()
    await blocker.query('begin')
    await blocker.query(`select id from media_app.media_objects where id = $1 for update`, [
      media.rows[0]?.id,
    ])

    try {
      storageReleaseResolve()
      await waitForRuntimeLockWaiters(1)
      const retry = initialize(service, key)
      void retry.catch(() => undefined)
      const retrySettled = retry.then(
        () => undefined,
        () => undefined,
      )
      await Promise.race([retrySettled, waitForRuntimeLockWaiters(2)])
      await blocker.query('commit')

      const [primaryResult, retryResult] = await Promise.allSettled([primary, retry])
      expect(primaryResult.status).toBe('fulfilled')
      expect(retryResult).toMatchObject({
        status: 'rejected',
        reason: { code: 'IDEMPOTENCY_IN_PROGRESS', statusCode: 409 },
      })
      for (const result of [primaryResult, retryResult]) {
        if (result.status === 'rejected') {
          expect(result.reason).not.toMatchObject({ code: '40P01' })
        }
      }
    } finally {
      storageReleaseResolve()
      await blocker.query('rollback').catch(() => undefined)
      blocker.release()
    }
  })

  it('requires a confirmed nickname before reserving idempotency or calling storage', async () => {
    await seedUser({ confirmed: false })
    const storage = fakeStorage()
    const key = idempotencyKey(4)

    await expect(initialize(uploadService(storage.storage), key)).rejects.toMatchObject({
      code: 'NICKNAME_REQUIRED',
      statusCode: 428,
    })
    expect(storage.createMultipart).not.toHaveBeenCalled()
    await expect(sagaState(key)).resolves.toBeUndefined()
  })

  it('rejects a disabled user before calling storage', async () => {
    await seedUser({ status: 'disabled' })
    const storage = fakeStorage()
    const key = idempotencyKey(5)

    await expect(initialize(uploadService(storage.storage), key)).rejects.toMatchObject({
      code: 'USER_DISABLED',
      statusCode: 403,
    })
    expect(storage.createMultipart).not.toHaveBeenCalled()
    await expect(sagaState(key)).resolves.toBeUndefined()
  })

  it('enforces at most five unfinished sessions before a sixth storage call', async () => {
    await seedUser()
    const storage = fakeStorage()
    const service = uploadService(storage.storage)
    for (let index = 10; index < 15; index += 1) {
      await initialize(service, idempotencyKey(index))
    }

    await expect(initialize(service, idempotencyKey(15))).rejects.toMatchObject({
      code: 'UPLOAD_SESSION_LIMIT',
      statusCode: 429,
    })
    expect(storage.createMultipart).toHaveBeenCalledTimes(5)
    const count = await migrationPool.query<{ count: string }>(
      `select count(*)::text as count from media_app.upload_sessions
        where user_id = $1 and status in ('initiating', 'uploading', 'completing', 'aborting')`,
      [userId],
    )
    expect(count.rows[0]?.count).toBe('5')
  })

  it('serializes concurrent initialization when only one unfinished-session slot remains', async () => {
    await seedUser()
    const storage = fakeStorage()
    const service = uploadService(storage.storage)
    for (let index = 30; index < 34; index += 1) {
      await initialize(service, idempotencyKey(index))
    }
    await migrationPool.query(`
      create function media_app.test_slow_concurrent_initialize()
      returns trigger language plpgsql as $function$
      begin
        perform pg_sleep(0.2);
        return new;
      end
      $function$;
      create trigger test_slow_concurrent_initialize
      before insert on media_app.media_objects
      for each row execute function media_app.test_slow_concurrent_initialize();
    `)

    let results: PromiseSettledResult<Awaited<ReturnType<typeof initialize>>>[]
    try {
      results = await Promise.allSettled([
        initialize(service, idempotencyKey(34)),
        initialize(service, idempotencyKey(35)),
      ])
    } finally {
      await migrationPool.query(`
        drop trigger if exists test_slow_concurrent_initialize on media_app.media_objects;
        drop function if exists media_app.test_slow_concurrent_initialize();
      `)
    }

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find((result) => result.status === 'rejected')
    expect(rejected?.status).toBe('rejected')
    if (rejected?.status !== 'rejected') throw new Error('one initialization must be rejected')
    expect(rejected.reason as unknown).toMatchObject({
      code: 'UPLOAD_SESSION_LIMIT',
      statusCode: 429,
    })
    expect(storage.createMultipart).toHaveBeenCalledTimes(5)
    const count = await migrationPool.query<{ count: string }>(
      `select count(*)::text as count from media_app.upload_sessions
        where user_id = $1 and status in ('initiating', 'uploading', 'completing', 'aborting')`,
      [userId],
    )
    expect(count.rows[0]?.count).toBe('5')
  })

  it('does not deadlock initialization audit against refresh rotation', async () => {
    await seedUser()
    const storage = fakeStorage()
    const ids = createSecureIdGenerator(clock)
    const authRepository = new PostgresAuthRepository({ pool: runtimePool, clock, ids })
    const blocker = await migrationPool.connect()
    await blocker.query(`select pg_advisory_lock(8675309)`)
    await migrationPool.query(`
      create function media_app.test_pause_initialize_audit()
      returns trigger language plpgsql as $function$
      begin
        if new.event_type = 'upload.initialize_started' then
          perform pg_advisory_xact_lock(8675309);
        end if;
        return new;
      end
      $function$;
      create trigger test_pause_initialize_audit
      before insert on media_app.audit_events
      for each row execute function media_app.test_pause_initialize_audit();
    `)

    try {
      const initialization = initialize(uploadService(storage.storage), idempotencyKey(36))
      void initialization.catch(() => undefined)
      await waitForRuntimeLockWaiters(1)
      const refresh = authRepository.rotateRefresh({
        refreshTokenHash: Buffer.alloc(32, 1),
        nextRefreshTokenHash: Buffer.alloc(32, 2),
        refreshExpiresAt: new Date('2026-08-14T05:00:00.000Z'),
        context,
      })
      void refresh.catch(() => undefined)
      await waitForRuntimeLockWaiters(2)
      await blocker.query(`select pg_advisory_unlock(8675309)`)

      const [initializationResult, refreshResult] = await Promise.allSettled([
        initialization,
        refresh,
      ])
      expect(initializationResult.status).toBe('fulfilled')
      expect(refreshResult).toMatchObject({
        status: 'fulfilled',
        value: { kind: 'rotated' },
      })
      for (const result of [initializationResult, refreshResult]) {
        if (result.status === 'rejected') {
          expect(result.reason).not.toMatchObject({ code: '40P01' })
        }
      }
    } finally {
      await blocker.query(`select pg_advisory_unlock(8675309)`).catch(() => undefined)
      blocker.release()
      await migrationPool.query(`
        drop trigger if exists test_pause_initialize_audit on media_app.audit_events;
        drop function if exists media_app.test_pause_initialize_audit();
      `)
    }
  })

  it('does not call storage when the first transaction rolls back', async () => {
    await seedUser()
    const storage = fakeStorage()
    const key = idempotencyKey(20)
    await migrationPool.query(`
      create function media_app.test_fail_initialize_first_transaction()
      returns trigger language plpgsql as $function$
      begin
        raise exception 'test first transaction failure';
      end
      $function$;
      create trigger test_fail_initialize_first_transaction
      before insert on media_app.media_objects
      for each row execute function media_app.test_fail_initialize_first_transaction();
    `)

    try {
      await expect(initialize(uploadService(storage.storage), key)).rejects.toBeDefined()
    } finally {
      await migrationPool.query(`
        drop trigger if exists test_fail_initialize_first_transaction on media_app.media_objects;
        drop function if exists media_app.test_fail_initialize_first_transaction();
      `)
    }
    expect(storage.createMultipart).not.toHaveBeenCalled()
    await expect(sagaState(key)).resolves.toBeUndefined()
  })

  it('converges a definite multipart rejection to one stable failed result', async () => {
    await seedUser()
    const storage = fakeStorage()
    storage.createMultipart.mockRejectedValue(storageError('definite', 'ACCESS_DENIED'))
    const service = uploadService(storage.storage)
    const key = idempotencyKey(21)

    await expect(initialize(service, key)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      statusCode: 503,
      idempotencyReplayed: false,
    })
    await expect(initialize(service, key)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      statusCode: 503,
      idempotencyReplayed: true,
    })
    expect(storage.createMultipart).toHaveBeenCalledOnce()
    const state = await sagaState(key)
    expect(state).toMatchObject({
      idempotency_status: 'failed',
      locked_until: null,
      response_status: 503,
      upload_status: 'failed',
      r2_upload_id: null,
      media_status: 'failed',
      part_count: 0,
    })
    expect(JSON.stringify(state?.response_body)).not.toMatch(
      /private storage failure|private-bucket-sentinel|r2-private-upload-id-sentinel/i,
    )
  })

  it('keeps an ambiguous create timeout linked and in progress', async () => {
    await seedUser()
    const storage = fakeStorage()
    storage.createMultipart.mockRejectedValue(storageError('ambiguous', 'TIMEOUT'))
    const key = idempotencyKey(22)

    await expect(initialize(uploadService(storage.storage), key)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      statusCode: 503,
      retryable: true,
    })
    expect(await sagaState(key)).toMatchObject({
      idempotency_status: 'in_progress',
      upload_status: 'initiating',
      r2_upload_id: null,
      media_status: 'pending_upload',
      response_status: null,
      response_body: null,
      part_count: 0,
    })
    expect((await sagaState(key))?.resource_id).toBeTruthy()
    expect((await sagaState(key))?.locked_until).toBeInstanceOf(Date)
    expect(storage.createMultipart).toHaveBeenCalledOnce()
  })

  it('refreshes the initialization lease immediately before the first transaction commits', async () => {
    await seedUser()
    const storage = fakeStorage()
    storage.createMultipart.mockRejectedValue(storageError('ambiguous', 'TIMEOUT'))
    let clockCalls = 0
    const delayedClock = {
      now: () => {
        clockCalls += 1
        return clockCalls === 1 ? now : new Date(now.getTime() + 5 * 60_000)
      },
    }
    const ids = createSecureIdGenerator(clock)
    const repository = new PostgresUploadRepository({
      pool: runtimePool,
      clock: delayedClock,
      ids,
    })
    const service = new UploadService({
      bucket,
      clock: delayedClock,
      ids,
      repository,
      storage: storage.storage,
      concurrency: {
        acquirePart: () => Promise.reject(new Error('part upload is outside this test')),
      },
    })
    const key = idempotencyKey(27)

    await expect(initialize(service, key)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    })

    const state = await sagaState(key)
    expect(state?.locked_until?.toISOString()).toBe('2026-07-15T03:06:00.000Z')
  })

  it('keeps the saga linked when persisting a definite storage failure rolls back', async () => {
    await seedUser()
    const storage = fakeStorage()
    storage.createMultipart.mockRejectedValue(storageError('definite', 'ACCESS_DENIED'))
    const key = idempotencyKey(25)
    await migrationPool.query(`
      create function media_app.test_fail_initialize_failure_transaction()
      returns trigger language plpgsql as $function$
      begin
        if old.status = 'initiating' and new.status = 'failed' then
          raise exception 'test failure transaction rollback';
        end if;
        return new;
      end
      $function$;
      create trigger test_fail_initialize_failure_transaction
      before update on media_app.upload_sessions
      for each row execute function media_app.test_fail_initialize_failure_transaction();
    `)

    try {
      await expect(initialize(uploadService(storage.storage), key)).rejects.toMatchObject({
        code: 'STORAGE_UNAVAILABLE',
        statusCode: 503,
        retryable: true,
      })
    } finally {
      await migrationPool.query(`
        drop trigger if exists test_fail_initialize_failure_transaction
          on media_app.upload_sessions;
        drop function if exists media_app.test_fail_initialize_failure_transaction();
      `)
    }

    expect(await sagaState(key)).toMatchObject({
      idempotency_status: 'in_progress',
      upload_status: 'initiating',
      media_status: 'pending_upload',
    })
    expect(storage.createMultipart).toHaveBeenCalledOnce()
  })

  it('aborts a slow create request before the initialization lease can expire', async () => {
    await seedUser()
    const storage = fakeStorage()
    storage.createMultipart.mockImplementation(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              reject(storageError('ambiguous', 'TIMEOUT'))
            },
            { once: true },
          )
        }),
    )
    const key = idempotencyKey(26)

    await expect(
      initialize(uploadService(storage.storage, { createMultipartTimeoutMs: 5 }), key),
    ).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
      statusCode: 503,
      retryable: true,
    })
    expect(await sagaState(key)).toMatchObject({
      idempotency_status: 'in_progress',
      upload_status: 'initiating',
      media_status: 'pending_upload',
    })
  })

  it('never steals an expired lease for a linked initiating session', async () => {
    await seedUser()
    const storage = fakeStorage()
    storage.createMultipart.mockRejectedValueOnce(storageError('ambiguous', 'TIMEOUT'))
    const service = uploadService(storage.storage)
    const key = idempotencyKey(23)
    await expect(initialize(service, key)).rejects.toMatchObject({
      code: 'STORAGE_UNAVAILABLE',
    })
    await migrationPool.query(
      `update media_app.idempotency_records set locked_until = $3
        where principal_id = $1 and idempotency_key = $2`,
      [userId, key, new Date(now.getTime() - 60_000)],
    )

    await expect(initialize(service, key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      statusCode: 409,
      retryable: true,
    })
    expect(storage.createMultipart).toHaveBeenCalledOnce()
    expect(await sagaState(key)).toMatchObject({
      idempotency_status: 'in_progress',
      upload_status: 'initiating',
    })
  })

  it('keeps R2 success linked and initiating when the second transaction fails', async () => {
    await seedUser()
    const storage = fakeStorage()
    const service = uploadService(storage.storage)
    const key = idempotencyKey(24)
    await migrationPool.query(`
      create function media_app.test_fail_initialize_second_transaction()
      returns trigger language plpgsql as $function$
      begin
        if old.status = 'initiating' and new.status = 'uploading' then
          raise exception 'test second transaction failure';
        end if;
        return new;
      end
      $function$;
      create trigger test_fail_initialize_second_transaction
      before update on media_app.upload_sessions
      for each row execute function media_app.test_fail_initialize_second_transaction();
    `)

    try {
      await expect(initialize(service, key)).rejects.toBeDefined()
    } finally {
      await migrationPool.query(`
        drop trigger if exists test_fail_initialize_second_transaction on media_app.upload_sessions;
        drop function if exists media_app.test_fail_initialize_second_transaction();
      `)
    }

    expect(await sagaState(key)).toMatchObject({
      idempotency_status: 'in_progress',
      upload_status: 'initiating',
      r2_upload_id: null,
      media_status: 'pending_upload',
      response_status: null,
      part_count: 0,
    })
    await expect(initialize(service, key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      statusCode: 409,
    })
    expect(storage.createMultipart).toHaveBeenCalledOnce()
  })
})

type UploadRouteService = Parameters<typeof registerUploadRoutes>[1]['uploads']
const routeApps: ReturnType<typeof buildAppShell>[] = []

afterEach(async () => {
  await Promise.all(routeApps.splice(0).map((app) => app.close()))
})

function uploadRouteApp(
  result: { data: InitializeUploadResponse['data']; replayed: boolean } = {
    data: publicData,
    replayed: false,
  },
) {
  const initializeUpload = vi.fn<UploadRouteService['initialize']>().mockResolvedValue(result)
  const uploads: UploadRouteService = {
    initialize: initializeUpload,
    uploadPart: () => Promise.reject(new Error('part upload is outside this test')),
    getDetail: () => Promise.reject(new Error('upload detail is outside this test')),
  }
  const verifyAccessToken = vi
    .fn<AccessTokenVerifier['verifyAccessToken']>()
    .mockResolvedValue({ sub: userId, sid: sessionId })
  const tokens: AccessTokenVerifier = { verifyAccessToken }
  const app = buildAppShell(fakeDependencies({ clock }))
  registerUploadRoutes(app, { uploads, tokens })
  routeApps.push(app)
  return { app, initializeUpload, verifyAccessToken }
}

describe('POST /v1/uploads', () => {
  it('returns 201 with only the strict public upload envelope', async () => {
    const privateResult = {
      data: {
        ...publicData,
        bucket,
        upload: {
          ...publicData.upload,
          objectKey: 'users/private/object.mov',
          r2UploadId: privateUploadId,
          etag: 'private-etag',
        },
      },
      replayed: false,
    }
    const { app, initializeUpload } = uploadRouteApp(privateResult)

    const response = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: {
        authorization: 'Bearer access-token-valid',
        'idempotency-key': idempotencyKey(30),
        'user-agent': 'upload-route-test',
      },
      payload: request,
    })

    expect(response.statusCode, response.body).toBe(201)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toMatchObject({
      data: publicData,
      meta: { requestId: response.headers['x-request-id'], serverTime: now.toISOString() },
    })
    expect(response.body).not.toMatch(
      /private-bucket-sentinel|users\/private|r2-private-upload-id-sentinel|private-etag|objectKey|r2UploadId|replayed/i,
    )
    expect(initializeUpload).toHaveBeenCalledWith({
      userId,
      sessionId,
      request,
      idempotencyKey: idempotencyKey(30),
      context: {
        requestId: response.headers['x-request-id'],
        sourceIp: '127.0.0.1',
        userAgent: 'upload-route-test',
      },
    })
  })

  it('enforces the ten-per-user initialization quota', async () => {
    const { app, initializeUpload } = uploadRouteApp()

    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/uploads',
        headers: {
          authorization: 'Bearer access-token-valid',
          'idempotency-key': idempotencyKey(40 + index),
        },
        payload: request,
      })
      expect(response.statusCode, `initialize ${String(index + 1)}`).toBe(201)
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: {
        authorization: 'Bearer access-token-valid',
        'idempotency-key': idempotencyKey(50),
      },
      payload: request,
    })

    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED', retryable: true } })
    expect(initializeUpload).toHaveBeenCalledTimes(10)
  })

  it('marks a successful idempotent replay without exposing the flag in the body', async () => {
    const { app } = uploadRouteApp({ data: publicData, replayed: true })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: {
        authorization: 'Bearer access-token-valid',
        'idempotency-key': idempotencyKey(55),
      },
      payload: request,
    })

    expect(response.statusCode).toBe(201)
    expect(response.headers['idempotency-replayed']).toBe('true')
    expect(response.body).not.toContain('replayed')
  })

  it.each([
    ['IDEMPOTENCY_IN_PROGRESS', 409],
    ['STORAGE_UNAVAILABLE', 503],
    ['UPLOAD_SESSION_LIMIT', 429],
  ] as const)('returns Retry-After for retryable %s', async (code, statusCode) => {
    const { app, initializeUpload } = uploadRouteApp()
    initializeUpload.mockRejectedValue(
      new ApiError({ code, message: code, statusCode, retryable: true }),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: {
        authorization: 'Bearer access-token-valid',
        'idempotency-key': idempotencyKey(56),
      },
      payload: request,
    })

    expect(response.statusCode).toBe(statusCode)
    expect(response.headers['retry-after']).toBe('1')
  })

  it('marks a stable failure replay in the response headers', async () => {
    const { app, initializeUpload } = uploadRouteApp()
    initializeUpload.mockRejectedValue(
      new ApiError({
        code: 'STORAGE_UNAVAILABLE',
        message: 'STORAGE_UNAVAILABLE',
        statusCode: 503,
        retryable: true,
        idempotencyReplayed: true,
      }),
    )

    const response = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: {
        authorization: 'Bearer access-token-valid',
        'idempotency-key': idempotencyKey(57),
      },
      payload: request,
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers['idempotency-replayed']).toBe('true')
    expect(response.headers['retry-after']).toBe('1')
  })

  it.each([
    [{ ...request, sizeBytes: 11 }, 422, 'FILE_TOO_SMALL'],
    [{ ...request, sizeBytes: 209_715_201 }, 413, 'FILE_TOO_LARGE'],
    [{ ...request, mimeType: 'application/octet-stream' }, 415, 'FILE_TYPE_NOT_ALLOWED'],
  ] as const)(
    'maps business file policy errors before persistence',
    async (payload, status, code) => {
      const { app, initializeUpload } = uploadRouteApp()
      initializeUpload.mockImplementation((input) => {
        validateMediaPolicy(input.request)
        return Promise.resolve({ data: publicData, replayed: false })
      })

      const response = await app.inject({
        method: 'POST',
        url: '/v1/uploads',
        headers: {
          authorization: 'Bearer access-token-valid',
          'idempotency-key': idempotencyKey(58),
        },
        payload,
      })

      expect(response.statusCode).toBe(status)
      expect(response.json()).toMatchObject({ error: { code } })
    },
  )

  it('rejects an invalid idempotency key before initialization', async () => {
    const { app, initializeUpload } = uploadRouteApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: {
        authorization: 'Bearer access-token-valid',
        'idempotency-key': 'invalid key value',
      },
      payload: request,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(initializeUpload).not.toHaveBeenCalled()
  })

  it.each([
    ['missing bearer token', {}, request, 401, 'UNAUTHORIZED'],
    [
      'missing idempotency key',
      { authorization: 'Bearer access-token-valid' },
      request,
      400,
      'IDEMPOTENCY_KEY_REQUIRED',
    ],
    [
      'client-controlled user id',
      {
        authorization: 'Bearer access-token-valid',
        'idempotency-key': idempotencyKey(60),
      },
      { ...request, userId: 'attacker-selected-user' },
      422,
      'VALIDATION_ERROR',
    ],
  ] as const)('rejects %s before initialization', async (_name, headers, payload, status, code) => {
    const { app, initializeUpload } = uploadRouteApp()

    const response = await app.inject({ method: 'POST', url: '/v1/uploads', headers, payload })

    expect(response.statusCode).toBe(status)
    expect(response.json()).toMatchObject({ error: { code } })
    expect(initializeUpload).not.toHaveBeenCalled()
  })
})
