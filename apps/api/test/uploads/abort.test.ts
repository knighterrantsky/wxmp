import type { ErrorEnvelope } from '@wx-upload/contracts'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildAppShell } from '../../src/app.js'
import type { AccessTokenVerifier } from '../../src/auth/auth-routes.js'
import { applyRoleGrants } from '../../src/db/grants.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import { ApiError } from '../../src/http/errors.js'
import { createSecureIdGenerator } from '../../src/lib/id.js'
import type { ObjectStorage } from '../../src/uploads/object-storage.js'
import { PostgresUploadRepository } from '../../src/uploads/upload-repository.js'
import { registerUploadRoutes } from '../../src/uploads/upload-routes.js'
import { type ExclusiveUploadConcurrency, UploadService } from '../../src/uploads/upload-service.js'
import { loadDestructiveDatabaseTestConfig } from '../support/destructive-database.js'
import { fakeDependencies } from '../support/fakes.js'
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
} from '../support/upload-fixture.js'

const databaseConfig = loadDestructiveDatabaseTestConfig(process.env)
const clock = { now: () => uploadFixtureNow }
const abortKey = '01981e34-6c80-7000-8000-000000000101'
const secondAbortKey = '01981e34-6c80-7000-8000-000000000102'

const tokens: AccessTokenVerifier = {
  verifyAccessToken: () => Promise.resolve({ sub: uploadOwnerUserId, sid: uploadOwnerSessionId }),
}

const storage = {
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
  vi.clearAllMocks()
})

afterAll(async () => {
  await Promise.all([runtimePool.end(), migrationPool.end()])
})

function fixtureApp(options: { busy?: boolean } = {}) {
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
  const uploads = new UploadService({
    bucket: privateFixtureBucket,
    clock,
    ids,
    repository,
    storage,
    concurrency: {
      acquirePart: vi.fn().mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) }),
    },
    exclusiveConcurrency: { acquireExclusiveUpload },
  })
  const app = buildAppShell(fakeDependencies({ pool: runtimePool, clock, ids }))
  registerUploadRoutes(app, { uploads, tokens })
  return { app, acquireExclusiveUpload }
}

function postAbort(
  app: ReturnType<typeof buildAppShell>,
  input: { key?: string; reason?: 'replaced' | 'userCancelled' } = {},
) {
  return app.inject({
    method: 'POST',
    url: `/v1/uploads/${uploadFixtureId}/abort`,
    headers: {
      authorization: 'Bearer owner-access-token',
      'content-type': 'application/json',
      'idempotency-key': input.key ?? abortKey,
    },
    payload: { reason: input.reason ?? 'userCancelled' },
  })
}

describe('POST /v1/uploads/:uploadId/abort', () => {
  it('persists cancelling and returns 202 without calling R2', async () => {
    await seedWritableUpload(migrationPool)
    const fixture = fixtureApp()

    const response = await postAbort(fixture.app)

    expect(response.statusCode, response.body).toBe(202)
    expect(response.json()).toMatchObject({
      data: {
        upload: { id: uploadFixtureId, status: 'cancelling' },
        pollAfterSeconds: 2,
      },
    })
    const state = await migrationPool.query<{
      abort_reason: string
      next_abort_at: Date | null
      status: string
    }>(`select status, abort_reason, next_abort_at from media_app.upload_sessions where id = $1`, [
      uploadFixtureId,
    ])
    expect(state.rows[0]).toEqual({
      status: 'aborting',
      abort_reason: 'userCancelled',
      next_abort_at: uploadFixtureNow,
    })
    expect(storage.abortMultipart).not.toHaveBeenCalled()
    await fixture.app.close()
  })

  it('replays the original 202 after background abort settlement', async () => {
    await seedWritableUpload(migrationPool)
    const fixture = fixtureApp()
    const first = await postAbort(fixture.app)
    await migrationPool.query(
      `update media_app.upload_sessions
          set status = 'aborted', aborted_at = $2, next_abort_at = null
        where id = $1`,
      [uploadFixtureId, uploadFixtureNow],
    )
    await migrationPool.query(
      `update media_app.media_objects set storage_status = 'aborted' where id = $1`,
      [mediaFixtureId],
    )

    const replay = await postAbort(fixture.app)

    expect(first.statusCode).toBe(202)
    expect(replay.statusCode).toBe(202)
    expect(replay.headers['idempotency-replayed']).toBe('true')
    expect(replay.json()).toMatchObject({ data: first.json<{ data: unknown }>().data })
    await fixture.app.close()
  })

  it('rejects changing the reason under the same idempotency key', async () => {
    await seedWritableUpload(migrationPool)
    const fixture = fixtureApp()
    await postAbort(fixture.app, { reason: 'userCancelled' })

    const changed = await postAbort(fixture.app, { reason: 'replaced' })

    expect(changed.statusCode).toBe(409)
    expect(changed.json<ErrorEnvelope>().error).toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      retryable: false,
    })
    await fixture.app.close()
  })

  it('rejects a new abort key after the upload is already aborting', async () => {
    await seedWritableUpload(migrationPool)
    const fixture = fixtureApp()
    await postAbort(fixture.app)

    const second = await postAbort(fixture.app, { key: secondAbortKey })

    expect(second.statusCode).toBe(409)
    expect(second.json<ErrorEnvelope>().error).toMatchObject({ code: 'UPLOAD_NOT_ABORTABLE' })
    await fixture.app.close()
  })

  it('returns UPLOAD_BUSY before reserving abort idempotency state', async () => {
    await seedWritableUpload(migrationPool)
    const fixture = fixtureApp({ busy: true })

    const response = await postAbort(fixture.app)

    expect(response.statusCode).toBe(409)
    expect(response.headers['retry-after']).toBe('1')
    expect(response.json<ErrorEnvelope>().error).toMatchObject({
      code: 'UPLOAD_BUSY',
      retryable: true,
    })
    const records = await migrationPool.query<{ count: string }>(
      `select count(*)::text as count from media_app.idempotency_records
        where operation = 'upload.abort'`,
    )
    expect(records.rows[0]?.count).toBe('0')
    await fixture.app.close()
  })
})

const { Aborter } = await import('../../src/uploads/aborter.js')
const { ObjectStorageError: AborterStorageError } =
  await import('../../src/uploads/object-storage.js')

function aborterStorageFixture() {
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

async function seedAborting(input: {
  failureCode?: 'FILE_TOO_SMALL' | 'MIME_MISMATCH'
  r2UploadId?: string | null
  reason: 'expired' | 'replaced' | 'userCancelled' | 'validationFailed'
}) {
  await seedWritableUpload(migrationPool)
  await migrationPool.query(
    `update media_app.upload_sessions
        set status = 'aborting', abort_reason = $2, r2_upload_id = $3,
            failure_code = $4, next_abort_at = $5
      where id = $1`,
    [
      uploadFixtureId,
      input.reason,
      input.r2UploadId === undefined ? privateFixtureMultipartId : input.r2UploadId,
      input.failureCode ?? null,
      uploadFixtureNow,
    ],
  )
}

function aborterFixture(
  input: {
    acquireExclusiveUpload?: ReturnType<
      typeof vi.fn<ExclusiveUploadConcurrency['acquireExclusiveUpload']>
    >
    now?: () => Date
    random?: () => number
    storage?: ReturnType<typeof aborterStorageFixture>
  } = {},
) {
  const workerClock = { now: input.now ?? (() => uploadFixtureNow) }
  const storage = input.storage ?? aborterStorageFixture()
  const acquireExclusiveUpload =
    input.acquireExclusiveUpload ??
    vi
      .fn<ExclusiveUploadConcurrency['acquireExclusiveUpload']>()
      .mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) })
  const criticalReconciliation = vi.fn()
  const aborter = new Aborter({
    pool: runtimePool,
    storage,
    concurrency: { acquireExclusiveUpload },
    clock: workerClock,
    ids: createSecureIdGenerator(workerClock),
    alerts: { criticalReconciliation },
    random: input.random ?? (() => 0.5),
    operationTimeoutMs: 5_000,
  })
  return { aborter, acquireExclusiveUpload, criticalReconciliation, storage }
}

async function abortLifecycleState() {
  const selected = await migrationPool.query<{
    abort_reason: string
    aborted_at: Date | null
    expired_at: Date | null
    failed_at: Date | null
    failure_code: string | null
    last_abort_error_code: string | null
    media_failure_code: string | null
    media_status: string
    next_abort_at: Date | null
    status: string
  }>(
    `select u.status, u.abort_reason, u.aborted_at, u.expired_at, u.failed_at,
            u.failure_code, u.next_abort_at, u.last_abort_error_code,
            m.storage_status as media_status, m.failure_code as media_failure_code
       from media_app.upload_sessions u
       join media_app.media_objects m on m.id = u.media_object_id
      where u.id = $1`,
    [uploadFixtureId],
  )
  return selected.rows[0]
}

describe('Aborter.runOnce', () => {
  it('surfaces an unexpected advisory-lock failure to the supervisor', async () => {
    await seedAborting({ reason: 'userCancelled' })
    const gateFailure = new Error('database lock query failed')
    const acquireExclusiveUpload = vi
      .fn<ExclusiveUploadConcurrency['acquireExclusiveUpload']>()
      .mockRejectedValue(gateFailure)
    const fixture = aborterFixture({ acquireExclusiveUpload })

    await expect(fixture.aborter.runOnce(10)).rejects.toBe(gateFailure)
  })

  it.each([
    {
      reason: 'userCancelled' as const,
      sessionStatus: 'aborted',
      mediaStatus: 'aborted',
    },
    { reason: 'replaced' as const, sessionStatus: 'aborted', mediaStatus: 'aborted' },
    { reason: 'expired' as const, sessionStatus: 'expired', mediaStatus: 'aborted' },
    {
      reason: 'validationFailed' as const,
      sessionStatus: 'failed',
      mediaStatus: 'failed',
    },
  ])(
    'maps $reason cleanup to $sessionStatus only after HEAD and multipart abort',
    async ({ mediaStatus, reason, sessionStatus }) => {
      await seedAborting({
        reason,
        ...(reason === 'validationFailed' ? { failureCode: 'MIME_MISMATCH' as const } : {}),
      })
      const storage = aborterStorageFixture()
      const fixture = aborterFixture({ storage })

      await expect(fixture.aborter.runOnce(10)).resolves.toMatchObject({
        claimed: 1,
        succeeded: 1,
      })

      expect(fixture.acquireExclusiveUpload).toHaveBeenCalledWith({
        uploadId: uploadFixtureId,
        waitMs: 0,
      })
      expect(storage.headObject).toHaveBeenCalledTimes(1)
      expect(storage.headObject.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal)
      expect(storage.abortMultipart).toHaveBeenCalledWith(
        expect.objectContaining({
          bucket: privateFixtureBucket,
          uploadId: privateFixtureMultipartId,
        }),
      )
      expect(storage.abortMultipart.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal)
      expect(await abortLifecycleState()).toMatchObject({
        status: sessionStatus,
        media_status: mediaStatus,
        next_abort_at: null,
        ...(reason === 'validationFailed'
          ? { failure_code: 'MIME_MISMATCH', media_failure_code: 'MIME_MISMATCH' }
          : {}),
      })
      const audit = await migrationPool.query<{
        actor_service: string
        actor_type: string
        event_type: string
        metadata: Record<string, unknown>
      }>(
        `select actor_type, actor_service, event_type, metadata
           from media_app.audit_events
          where entity_id = $1`,
        [uploadFixtureId],
      )
      expect(audit.rows.at(-1)).toMatchObject({
        actor_type: 'system',
        actor_service: 'upload-aborter',
        metadata: { reason },
      })
    },
  )

  it('lists by the reserved key, aborts every exact orphan, and settles linked initialization', async () => {
    await seedAborting({ reason: 'userCancelled', r2UploadId: null })
    await migrationPool.query(
      `insert into media_app.idempotency_records(
         id, principal_type, principal_id, operation, idempotency_key,
         request_hash, status, locked_until, resource_type, resource_id,
         expires_at, created_at, updated_at
       ) values ($1, 'user', $2, 'upload.initialize', 'fixture-idempotency-key',
                 $3, 'in_progress', $4, 'upload_session', $5, $6, $7, $7)`,
      [
        '01981e34-6c80-7000-8000-000000000201',
        uploadOwnerUserId,
        Buffer.alloc(32, 9),
        new Date(uploadFixtureNow.getTime() + 60_000),
        uploadFixtureId,
        new Date(uploadFixtureNow.getTime() + 24 * 60 * 60 * 1_000),
        new Date(uploadFixtureNow.getTime() - 1_000),
      ],
    )
    const storage = aborterStorageFixture()
    vi.mocked(storage.listMultipartUploads).mockResolvedValue([
      { key: privateFixtureKey, uploadId: 'exact-orphan-1' },
      { key: `${privateFixtureKey}.collision`, uploadId: 'prefix-collision' },
      { key: privateFixtureKey, uploadId: 'exact-orphan-2' },
    ])
    const fixture = aborterFixture({ storage })

    await fixture.aborter.runOnce(10)

    expect(storage.listMultipartUploads).toHaveBeenCalledWith({
      bucket: privateFixtureBucket,
      prefix: privateFixtureKey,
      signal: storage.listMultipartUploads.mock.calls[0]?.[0].signal,
    })
    expect(storage.listMultipartUploads.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal)
    expect(storage.abortMultipart).toHaveBeenCalledTimes(2)
    expect(storage.abortMultipart).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ key: privateFixtureKey, uploadId: 'exact-orphan-1' }),
    )
    expect(storage.abortMultipart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ key: privateFixtureKey, uploadId: 'exact-orphan-2' }),
    )
    const idempotency = await migrationPool.query<{
      expires_at: Date
      locked_until: Date | null
      response_body: Record<string, unknown>
      response_status: number
      status: string
    }>(
      `select status, locked_until, response_status, response_body, expires_at
         from media_app.idempotency_records
        where operation = 'upload.initialize' and resource_id = $1`,
      [uploadFixtureId],
    )
    expect(idempotency.rows[0]).toMatchObject({
      status: 'failed',
      locked_until: null,
      response_status: 503,
      response_body: { code: 'STORAGE_UNAVAILABLE', retryable: true },
      expires_at: new Date(uploadFixtureNow.getTime() + 7 * 24 * 60 * 60 * 1_000),
    })
  })

  it('never aborts when HEAD finds a completed object and emits a critical safe-code alert', async () => {
    await seedAborting({ reason: 'userCancelled' })
    const storage = aborterStorageFixture()
    vi.mocked(storage.headObject).mockResolvedValue({
      sizeBytes: 16,
      etag: 'must-not-be-persisted',
    })
    const fixture = aborterFixture({ storage })

    await expect(fixture.aborter.runOnce(10)).resolves.toMatchObject({ retried: 1 })

    expect(storage.abortMultipart).not.toHaveBeenCalled()
    expect(fixture.criticalReconciliation).toHaveBeenCalledWith('STORAGE_OBJECT_PRESENT')
    expect(await abortLifecycleState()).toMatchObject({
      status: 'aborting',
      last_abort_error_code: 'STORAGE_OBJECT_PRESENT',
    })
  })

  it.each(['ACCESS_DENIED', 'INVALID_REQUEST'] as const)(
    'keeps %s cleanup durable, alerts, and schedules the fixed critical recheck',
    async (code) => {
      await seedAborting({ reason: 'expired' })
      const storage = aborterStorageFixture()
      vi.mocked(storage.abortMultipart).mockRejectedValue(
        new AborterStorageError({
          operation: 'abortMultipart',
          certainty: 'definite',
          code,
        }),
      )
      const fixture = aborterFixture({ storage })

      await fixture.aborter.runOnce(10)

      const state = await abortLifecycleState()
      expect(state).toMatchObject({ status: 'aborting', last_abort_error_code: code })
      expect(state?.next_abort_at).toEqual(new Date(uploadFixtureNow.getTime() + 5 * 60 * 1_000))
      expect(fixture.criticalReconciliation).toHaveBeenCalledWith(code)
    },
  )

  it('persists only UNKNOWN for an unclassified failure and a restarted worker later converges', async () => {
    await seedAborting({ reason: 'userCancelled' })
    let now = uploadFixtureNow
    const failingStorage = aborterStorageFixture()
    vi.mocked(failingStorage.headObject).mockRejectedValue(
      new Error(`secret ${privateFixtureKey} etag private-etag`),
    )
    const first = aborterFixture({ now: () => now, random: () => 0.5, storage: failingStorage })

    await first.aborter.runOnce(10)

    const retry = await abortLifecycleState()
    expect(retry).toMatchObject({ status: 'aborting', last_abort_error_code: 'UNKNOWN' })
    expect(JSON.stringify(retry)).not.toContain(privateFixtureKey)
    const retryAt = retry?.next_abort_at
    if (retryAt === null || retryAt === undefined) throw new Error('abort retry was not scheduled')
    now = new Date(retryAt.getTime() + 1)
    const restarted = aborterFixture({ now: () => now })

    await expect(restarted.aborter.runOnce(10)).resolves.toMatchObject({ succeeded: 1 })
    expect(await abortLifecycleState()).toMatchObject({
      status: 'aborted',
      media_status: 'aborted',
      next_abort_at: null,
    })
  })

  it('treats a definitely missing multipart as already clean', async () => {
    await seedAborting({ reason: 'expired' })
    const storage = aborterStorageFixture()
    vi.mocked(storage.abortMultipart).mockRejectedValue(
      new AborterStorageError({
        operation: 'abortMultipart',
        certainty: 'definite',
        code: 'NOT_FOUND',
      }),
    )
    const fixture = aborterFixture({ storage })

    await expect(fixture.aborter.runOnce(10)).resolves.toMatchObject({ succeeded: 1 })

    expect(await abortLifecycleState()).toMatchObject({
      status: 'expired',
      media_status: 'aborted',
      next_abort_at: null,
    })
  })

  it('holds no row transaction during R2 calls and CAS rejects a changed claim', async () => {
    await seedAborting({ reason: 'userCancelled' })
    const storage = aborterStorageFixture()
    let markStorageStarted: (() => void) | undefined
    const storageStarted = new Promise<void>((resolve) => {
      markStorageStarted = resolve
    })
    let resolveHead: ((value: null) => void) | undefined
    const pendingHead = new Promise<null>((resolve) => {
      resolveHead = resolve
    })
    vi.mocked(storage.headObject).mockImplementation(() => {
      markStorageStarted?.()
      return pendingHead
    })
    const fixture = aborterFixture({ storage })

    const running = fixture.aborter.runOnce(10)
    await storageStarted
    await migrationPool.query(
      `update media_app.upload_sessions set last_activity_at = $2 where id = $1`,
      [uploadFixtureId, new Date(uploadFixtureNow.getTime() + 1)],
    )
    if (resolveHead === undefined) throw new Error('HEAD request did not start')
    resolveHead(null)

    await expect(running).resolves.toEqual({ claimed: 1, retried: 0, succeeded: 0 })
    expect(storage.abortMultipart).toHaveBeenCalledTimes(1)
    expect(await abortLifecycleState()).toMatchObject({
      status: 'aborting',
      media_status: 'pending_upload',
    })
  })
})

describe('POST /v1/uploads/:uploadId/abort expiry boundary', () => {
  it('forces reason=expired when now is exactly expires_at', async () => {
    await seedWritableUpload(migrationPool, {
      createdAt: new Date(uploadFixtureNow.getTime() - 1_000),
      expiresAt: uploadFixtureNow,
    })
    const fixture = fixtureApp()

    const response = await postAbort(fixture.app, { reason: 'userCancelled' })

    expect(response.statusCode, response.body).toBe(202)
    expect(await abortLifecycleState()).toMatchObject({
      status: 'aborting',
      abort_reason: 'expired',
      next_abort_at: uploadFixtureNow,
    })
    await fixture.app.close()
  })
})
