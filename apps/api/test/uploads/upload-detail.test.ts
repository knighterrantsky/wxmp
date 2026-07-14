import { PART_SIZE_BYTES } from '@wx-upload/contracts'
import type { Pool } from 'pg'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { buildAppShell } from '../../src/app.js'
import type { AccessTokenVerifier } from '../../src/auth/auth-routes.js'
import { applyRoleGrants } from '../../src/db/grants.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import { createSecureIdGenerator } from '../../src/lib/id.js'
import { PostgresUploadRepository } from '../../src/uploads/upload-repository.js'
import { registerUploadRoutes } from '../../src/uploads/upload-routes.js'
import { UploadService } from '../../src/uploads/upload-service.js'
import { loadDestructiveDatabaseTestConfig } from '../support/destructive-database.js'
import { fakeDependencies } from '../support/fakes.js'
import {
  mediaFixtureId,
  otherUploadSessionId,
  otherUploadUserId,
  privateFixtureBucket,
  privateFixtureKey,
  privateFixtureMultipartId,
  seedUploadIdentities,
  seedWritableUpload,
  uploadFixtureId,
  uploadOwnerSessionId,
  uploadOwnerUserId,
} from '../support/upload-fixture.js'

const databaseConfig = loadDestructiveDatabaseTestConfig(process.env)
const requestNow = new Date('2026-07-15T05:02:00.000Z')
const detailUpdatedAt = new Date('2026-07-15T05:01:08.000Z')
const clock = { now: () => requestNow }
const partSizes = [PART_SIZE_BYTES, PART_SIZE_BYTES, PART_SIZE_BYTES, 16]
const totalBytes = partSizes.reduce((total, size) => total + size, 0)
const confirmedBytes = PART_SIZE_BYTES * 2
const firstPartSha256 = 'a'.repeat(64)
const secondPartSha256 = 'b'.repeat(64)
const missingUploadId = '01981d0c-ec80-7000-8000-000000000999'

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
const apps: ReturnType<typeof buildAppShell>[] = []

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

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

afterAll(async () => {
  await Promise.all([runtimePool.end(), migrationPool.end()])
})

function fixtureApp() {
  const ids = createSecureIdGenerator(clock)
  const dependencies = fakeDependencies({ pool: runtimePool, clock, ids })
  const repository = new PostgresUploadRepository({ pool: runtimePool, clock, ids })
  const uploads = new UploadService({
    bucket: privateFixtureBucket,
    clock,
    ids,
    repository,
    storage: dependencies.objectStorage,
    concurrency: {
      acquirePart: () =>
        Promise.resolve({
          release: () => Promise.resolve(),
        }),
    },
  })
  const app = buildAppShell(dependencies)
  registerUploadRoutes(app, { uploads, tokens })
  apps.push(app)
  return app
}

async function seedPartProgress(): Promise<void> {
  await seedWritableUpload(migrationPool, { partSizes })
  await migrationPool.query(
    `update media_app.upload_parts
        set status = 'uploaded', actual_size_bytes = expected_size_bytes,
            checksum_sha256 = $3, r2_etag = $4, uploaded_at = $5
      where upload_session_id = $1 and part_number = $2`,
    [
      uploadFixtureId,
      1,
      Buffer.from(firstPartSha256, 'hex'),
      'private-detail-etag-one-sentinel',
      detailUpdatedAt,
    ],
  )
  await migrationPool.query(
    `update media_app.upload_parts
        set status = 'verified', actual_size_bytes = expected_size_bytes,
            checksum_sha256 = $3, r2_etag = $4, uploaded_at = $5, verified_at = $5
      where upload_session_id = $1 and part_number = $2`,
    [
      uploadFixtureId,
      2,
      Buffer.from(secondPartSha256, 'hex'),
      'private-detail-etag-two-sentinel',
      detailUpdatedAt,
    ],
  )
  await migrationPool.query(
    `update media_app.upload_sessions
        set confirmed_size_bytes = $2, confirmed_part_count = 2,
            last_activity_at = $3, updated_at = $3
      where id = $1`,
    [uploadFixtureId, confirmedBytes, detailUpdatedAt],
  )
}

describe('GET /v1/uploads/:uploadId', () => {
  it('returns authoritative active progress and resumable part hashes without storage internals', async () => {
    await seedPartProgress()
    const app = fixtureApp()

    const response = await app.inject({
      method: 'GET',
      url: `/v1/uploads/${uploadFixtureId}`,
      headers: { authorization: 'Bearer owner-access-token' },
    })

    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toEqual({
      data: {
        upload: {
          id: uploadFixtureId,
          mediaId: mediaFixtureId,
          status: 'uploading',
          fileName: 'fixture.png',
          kind: 'image',
          mimeType: 'image/png',
          sizeBytes: totalBytes,
          progress: {
            confirmedBytes,
            totalBytes,
            uploadedParts: 2,
            totalParts: 4,
            percent: 66.67,
          },
          expiresAt: '2026-07-16T05:00:00.000Z',
          failure: null,
          createdAt: '2026-07-15T05:00:00.000Z',
          updatedAt: detailUpdatedAt.toISOString(),
        },
        partDetailsRetained: true,
        partsAvailableUntil: null,
        parts: [
          {
            partNumber: 1,
            offsetBytes: 0,
            sizeBytes: PART_SIZE_BYTES,
            status: 'uploaded',
            sha256: firstPartSha256,
          },
          {
            partNumber: 2,
            offsetBytes: PART_SIZE_BYTES,
            sizeBytes: PART_SIZE_BYTES,
            status: 'verified',
            sha256: secondPartSha256,
          },
          {
            partNumber: 3,
            offsetBytes: PART_SIZE_BYTES * 2,
            sizeBytes: PART_SIZE_BYTES,
            status: 'pending',
            sha256: null,
          },
          {
            partNumber: 4,
            offsetBytes: PART_SIZE_BYTES * 3,
            sizeBytes: 16,
            status: 'pending',
            sha256: null,
          },
        ],
        pollAfterSeconds: 2,
      },
      meta: {
        requestId: response.headers['x-request-id'],
        serverTime: requestNow.toISOString(),
      },
    })
    expect(response.body).not.toMatch(
      new RegExp(
        [
          privateFixtureBucket,
          privateFixtureKey,
          privateFixtureMultipartId,
          'private-detail-etag',
          'objectKey',
          'r2UploadId',
          'etag',
          'rowVersion',
          'attemptCount',
        ].join('|'),
        'i',
      ),
    )
  })

  it('returns the same owner-scoped 404 for another user and an unknown upload id', async () => {
    await seedWritableUpload(migrationPool)
    const app = fixtureApp()

    const hidden = await app.inject({
      method: 'GET',
      url: `/v1/uploads/${uploadFixtureId}`,
      headers: { authorization: 'Bearer other-access-token' },
    })
    const missing = await app.inject({
      method: 'GET',
      url: `/v1/uploads/${missingUploadId}`,
      headers: { authorization: 'Bearer owner-access-token' },
    })
    const hiddenError = hidden.json<{
      error: { code: string; message: string; retryable: boolean }
    }>().error
    const missingError = missing.json<{
      error: { code: string; message: string; retryable: boolean }
    }>().error

    expect(hidden.statusCode).toBe(404)
    expect(missing.statusCode).toBe(404)
    expect(hiddenError).toEqual({
      code: 'UPLOAD_NOT_FOUND',
      message: '上传记录不存在',
      retryable: false,
    })
    expect(missingError).toEqual(hiddenError)
    expect(hidden.body).not.toMatch(
      new RegExp(
        `${privateFixtureBucket}|${privateFixtureKey}|${privateFixtureMultipartId}|${mediaFixtureId}`,
        'i',
      ),
    )
  })

  it('blocks an already authenticated owner immediately after the account is disabled', async () => {
    await seedWritableUpload(migrationPool)
    await migrationPool.query(`update media_app.users set status = 'disabled' where id = $1`, [
      uploadOwnerUserId,
    ])
    const app = fixtureApp()

    const response = await app.inject({
      method: 'GET',
      url: `/v1/uploads/${uploadFixtureId}`,
      headers: { authorization: 'Bearer owner-access-token' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({
      error: {
        code: 'USER_DISABLED',
        message: '用户已被禁用',
        retryable: false,
      },
    })
  })

  it('projects a truncated-signature failure as a public validation failure', async () => {
    await seedWritableUpload(migrationPool)
    await migrationPool.query(
      `update media_app.upload_sessions
          set status = 'failed', failure_code = 'FILE_TOO_SMALL', failed_at = $2
        where id = $1`,
      [uploadFixtureId, detailUpdatedAt],
    )
    await migrationPool.query(
      `update media_app.media_objects
          set storage_status = 'failed', failure_code = 'FILE_TOO_SMALL', failed_at = $2
        where id = $1`,
      [mediaFixtureId, detailUpdatedAt],
    )
    const app = fixtureApp()

    const response = await app.inject({
      method: 'GET',
      url: `/v1/uploads/${uploadFixtureId}`,
      headers: { authorization: 'Bearer owner-access-token' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({
      data: {
        upload: {
          status: 'upload_failed',
          failure: {
            stage: 'validation',
            code: 'FILE_TOO_SMALL',
            message: '文件过小，无法验证格式',
            failedAt: detailUpdatedAt.toISOString(),
          },
        },
      },
    })
  })
})
