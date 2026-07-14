import { randomUUID } from 'node:crypto'

import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { applyRoleGrants } from '../../src/db/grants.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import type { Clock } from '../../src/lib/clock.js'
import { RetentionCleaner } from '../../src/uploads/retention-cleaner.js'
import { loadDestructiveDatabaseTestConfig } from '../support/destructive-database.js'

const DAY_MS = 86_400_000
const NOW = new Date('2026-07-15T01:00:00.000Z')
const USER_ID = '01981c31-4c80-7000-8000-000000000071'
const migrationsDirectory = new URL('../../src/db/migrations/', import.meta.url).pathname
const { migrationDatabaseUrl, maintenanceDatabaseUrl } = loadDestructiveDatabaseTestConfig(
  process.env,
)

const clock: Clock = { now: () => new Date(NOW) }

let migrationPool: Pool
let maintenancePool: Pool

function beforeNow(days: number, extraMs = 0): Date {
  return new Date(NOW.getTime() - days * DAY_MS - extraMs)
}

async function resetAndGrant(): Promise<void> {
  await migrationPool.query('drop schema if exists media_app cascade')
  await migrationPool.query('drop table if exists public.schema_migrations')
  await runMigrations(migrationPool, migrationsDirectory)
  await applyRoleGrants(migrationPool, {
    runtimeRole: 'wx_runtime',
    maintenanceRole: 'wx_maintenance',
  })
  await migrationPool.query(
    `insert into media_app.users(id, status, nickname, nickname_confirmed_at)
     values ($1, 'active', '留存测试', $2)`,
    [USER_ID, NOW],
  )
}

beforeAll(() => {
  migrationPool = createPool(migrationDatabaseUrl)
  maintenancePool = createPool(maintenanceDatabaseUrl)
})

beforeEach(resetAndGrant)

afterAll(async () => {
  await migrationPool.query('drop schema if exists media_app cascade')
  await migrationPool.query('drop table if exists public.schema_migrations')
  await Promise.all([maintenancePool.end(), migrationPool.end()])
})

function cleaner(): RetentionCleaner {
  return new RetentionCleaner({ pool: maintenancePool, clock })
}

async function insertIdempotency(input: {
  status: 'in_progress' | 'completed' | 'failed'
  expiresAt: Date
}): Promise<string> {
  const id = randomUUID()
  const stable = input.status !== 'in_progress'
  await migrationPool.query(
    `insert into media_app.idempotency_records(
       id, principal_type, principal_id, operation, idempotency_key,
       request_hash, status, locked_until, response_status, response_body,
       expires_at, created_at
     ) values (
       $1, 'system', 'retention-cleaner', 'retention.fixture', $2,
       decode(repeat('ab', 32), 'hex'), $3, $4, $5, $6::jsonb,
       $7, $8
     )`,
    [
      id,
      `retention-${randomUUID()}`,
      input.status,
      stable ? null : beforeNow(8),
      stable ? 200 : null,
      stable ? '{}' : null,
      input.expiresAt,
      new Date(input.expiresAt.getTime() - 8 * DAY_MS),
    ],
  )
  return id
}

async function existingIds(table: string): Promise<string[]> {
  const result = await migrationPool.query<{ id: string }>(
    `select id::text from media_app.${table} order by id`,
  )
  return result.rows.map((row) => row.id)
}

async function insertTerminalUpload(input: {
  terminalAt: Date
  partCount?: number
  status?: 'completed' | 'aborted' | 'expired' | 'failed'
}): Promise<{ uploadId: string; mediaId: string }> {
  const mediaId = randomUUID()
  const uploadId = randomUUID()
  const partCount = input.partCount ?? 1
  const status = input.status ?? 'failed'
  const expectedSize = partCount * 8_388_608
  const createdAt = new Date(input.terminalAt.getTime() - DAY_MS)

  await migrationPool.query(
    `insert into media_app.media_objects(
       id, user_id, kind, original_filename, uploader_nickname_snapshot,
       declared_content_type, canonical_extension, declared_size_bytes,
       r2_bucket, object_key, create_idempotency_key, created_at
     ) values ($1, $2, 'video', 'retention.mp4', '留存测试',
       'video/mp4', '.mp4', $3, 'private-retention', $4, $5, $6)`,
    [mediaId, USER_ID, expectedSize, `retention/${mediaId}`, randomUUID(), createdAt],
  )
  await migrationPool.query(
    `insert into media_app.upload_sessions(
       id, media_object_id, user_id, status, r2_upload_id, expected_size_bytes,
       confirmed_size_bytes, confirmed_part_count, expires_at,
       completed_at, aborted_at, expired_at, failed_at, failure_code,
       abort_reason, created_at
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8, $9,
       $10, $11, $12, $13, $14, $15, $16
     )`,
    [
      uploadId,
      mediaId,
      USER_ID,
      status,
      status === 'completed' ? `retention-multipart-${uploadId}` : null,
      expectedSize,
      status === 'completed' ? expectedSize : 0,
      status === 'completed' ? partCount : 0,
      new Date(createdAt.getTime() + 2 * DAY_MS),
      status === 'completed' ? input.terminalAt : null,
      status === 'aborted' ? input.terminalAt : null,
      status === 'expired' ? input.terminalAt : null,
      status === 'failed' ? input.terminalAt : null,
      status === 'failed' ? 'RETENTION_FIXTURE' : null,
      status === 'aborted' ? 'userCancelled' : status === 'expired' ? 'expired' : null,
      createdAt,
    ],
  )
  await migrationPool.query(
    `insert into media_app.upload_parts(
       upload_session_id, part_number, offset_bytes, expected_size_bytes, created_at
     )
     select $1, part_number, (part_number - 1)::bigint * 8388608, 8388608, $2
       from generate_series(1, $3::integer) as part_number`,
    [uploadId, createdAt, partCount],
  )
  return { uploadId, mediaId }
}

async function partCount(uploadId: string): Promise<number> {
  const result = await migrationPool.query<{ count: string }>(
    'select count(*)::text as count from media_app.upload_parts where upload_session_id = $1',
    [uploadId],
  )
  return Number(result.rows[0]?.count ?? 0)
}

async function insertSession(input: {
  expiresAt: Date
  revokedAt?: Date
  rotatedFrom?: string
}): Promise<string> {
  const id = randomUUID()
  const referenceTime = input.revokedAt ?? input.expiresAt
  await migrationPool.query(
    `insert into media_app.user_sessions(
       id, user_id, token_family_id, rotated_from_session_id,
       refresh_token_hash, issued_at, expires_at, revoked_at
     ) values ($1, $2, $3, $4, decode($5, 'hex'), $6, $7, $8)`,
    [
      id,
      USER_ID,
      randomUUID(),
      input.rotatedFrom ?? null,
      randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
      new Date(referenceTime.getTime() - DAY_MS),
      input.expiresAt,
      input.revokedAt ?? null,
    ],
  )
  return id
}

describe('RetentionCleaner', () => {
  it('deletes only stable idempotency records whose retention expiry is strictly before now', async () => {
    const completedExpired = await insertIdempotency({
      status: 'completed',
      expiresAt: new Date(NOW.getTime() - 1),
    })
    const failedExpired = await insertIdempotency({
      status: 'failed',
      expiresAt: new Date(NOW.getTime() - 1),
    })
    const completedAtBoundary = await insertIdempotency({
      status: 'completed',
      expiresAt: NOW,
    })
    const staleInProgress = await insertIdempotency({
      status: 'in_progress',
      expiresAt: beforeNow(30),
    })

    const result = await cleaner().runOnce(5_000)

    expect(result.idempotencyRecords).toBe(2)
    expect(await existingIds('idempotency_records')).toEqual(
      [completedAtBoundary, staleInProgress].sort(),
    )
    expect(await existingIds('idempotency_records')).not.toContain(completedExpired)
    expect(await existingIds('idempotency_records')).not.toContain(failedExpired)
  })

  it('deletes complete terminal part groups strictly after 90 days and retains the boundary', async () => {
    const expired = await insertTerminalUpload({ terminalAt: beforeNow(90, 1), partCount: 3 })
    const completed = await insertTerminalUpload({
      terminalAt: beforeNow(90, 1),
      status: 'completed',
    })
    const aborted = await insertTerminalUpload({
      terminalAt: beforeNow(90, 1),
      status: 'aborted',
    })
    const timedOut = await insertTerminalUpload({
      terminalAt: beforeNow(90, 1),
      status: 'expired',
    })
    const boundary = await insertTerminalUpload({ terminalAt: beforeNow(90), partCount: 2 })
    const nonterminal = await insertTerminalUpload({ terminalAt: beforeNow(100) })
    await migrationPool.query(
      `update media_app.upload_sessions
          set status = 'uploading', r2_upload_id = $2,
              failed_at = null, failure_code = null
        where id = $1`,
      [nonterminal.uploadId, `retention-active-${nonterminal.uploadId}`],
    )

    const result = await cleaner().runOnce(5_000)

    expect(result.uploadParts).toBe(6)
    expect(result.uploadsWhosePartsWereDeleted).toBe(4)
    expect(await partCount(expired.uploadId)).toBe(0)
    expect(await partCount(completed.uploadId)).toBe(0)
    expect(await partCount(aborted.uploadId)).toBe(0)
    expect(await partCount(timedOut.uploadId)).toBe(0)
    expect(await partCount(boundary.uploadId)).toBe(2)
    expect(await partCount(nonterminal.uploadId)).toBe(1)
    await expect(
      migrationPool.query('select 1 from media_app.upload_sessions where id = $1', [
        expired.uploadId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(
      migrationPool.query('select 1 from media_app.media_objects where id = $1', [expired.mediaId]),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('caps terminal part cleanup at 200 complete uploads and 5,000 rows per run', async () => {
    await Promise.all(
      Array.from({ length: 201 }, () =>
        insertTerminalUpload({ terminalAt: beforeNow(91), partCount: 25 }),
      ),
    )

    const first = await cleaner().runOnce(5_000)

    expect(first.uploadsWhosePartsWereDeleted).toBe(200)
    expect(first.uploadParts).toBe(5_000)
    const remaining = await migrationPool.query<{ uploads: string; parts: string }>(
      `select count(distinct upload_session_id)::text as uploads, count(*)::text as parts
         from media_app.upload_parts`,
    )
    expect(remaining.rows[0]).toEqual({ uploads: '1', parts: '25' })
  })

  it('deletes revoked or expired sessions strictly after 90 days and preserves references safely', async () => {
    const expiredParent = await insertSession({ expiresAt: beforeNow(90, 1) })
    const revokedOld = await insertSession({
      expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
      revokedAt: beforeNow(90, 1),
    })
    const expiredOld = await insertSession({ expiresAt: beforeNow(90, 1) })
    const expiryBoundary = await insertSession({ expiresAt: beforeNow(90) })
    const revokeBoundary = await insertSession({
      expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
      revokedAt: beforeNow(90),
    })
    const activeChild = await insertSession({
      expiresAt: new Date(NOW.getTime() + 30 * DAY_MS),
      rotatedFrom: expiredParent,
    })
    const auditEventId = randomUUID()
    await migrationPool.query(
      `insert into media_app.audit_events(
         event_id, occurred_at, actor_type, actor_user_id, actor_session_id,
         event_type, entity_type
       ) values ($1, $2, 'user', $3, $4, 'retention.session.fixture', 'session')`,
      [auditEventId, NOW, USER_ID, expiredParent],
    )

    const result = await cleaner().runOnce(5_000)

    expect(result.userSessions).toBe(3)
    expect(await existingIds('user_sessions')).toEqual(
      [activeChild, expiryBoundary, revokeBoundary].sort(),
    )
    expect(await existingIds('user_sessions')).not.toContain(revokedOld)
    expect(await existingIds('user_sessions')).not.toContain(expiredOld)
    const child = await migrationPool.query<{ rotated_from_session_id: string | null }>(
      'select rotated_from_session_id from media_app.user_sessions where id = $1',
      [activeChild],
    )
    const audit = await migrationPool.query<{ actor_session_id: string | null }>(
      'select actor_session_id from media_app.audit_events where event_id = $1',
      [auditEventId],
    )
    expect(child.rows[0]?.rotated_from_session_id).toBeNull()
    expect(audit.rows[0]?.actor_session_id).toBeNull()
  })

  it('deletes audit events strictly after 365 days and retains the exact boundary', async () => {
    const oldEvent = randomUUID()
    const boundaryEvent = randomUUID()
    await migrationPool.query(
      `insert into media_app.audit_events(
         event_id, occurred_at, actor_type, actor_service, event_type, entity_type
       ) values
         ($1, $2, 'system', 'retention-cleaner', 'retention.audit.fixture', 'audit'),
         ($3, $4, 'system', 'retention-cleaner', 'retention.audit.fixture', 'audit')`,
      [oldEvent, beforeNow(365, 1), boundaryEvent, beforeNow(365)],
    )

    const result = await cleaner().runOnce(5_000)

    expect(result.auditEvents).toBe(1)
    const remaining = await migrationPool.query<{ event_id: string }>(
      'select event_id::text from media_app.audit_events',
    )
    expect(remaining.rows).toEqual([{ event_id: boundaryEvent }])
  })

  it('never deletes more than 5,000 rows from an individual retention class', async () => {
    await migrationPool.query(
      `insert into media_app.audit_events(
         event_id, occurred_at, actor_type, actor_service, event_type, entity_type
       )
       select md5('retention-audit-' || value::text)::uuid, $1,
              'system', 'retention-cleaner', 'retention.audit.fixture', 'audit'
         from generate_series(1, 5001) as value`,
      [beforeNow(366)],
    )

    const result = await cleaner().runOnce(5_000)

    expect(result.auditEvents).toBe(5_000)
    const remaining = await migrationPool.query<{ count: string }>(
      'select count(*)::text as count from media_app.audit_events',
    )
    expect(remaining.rows[0]?.count).toBe('1')
  })

  it('rejects invalid batch sizes before issuing maintenance SQL', async () => {
    await expect(cleaner().runOnce(0)).rejects.toThrow(/batch size/i)
    await expect(cleaner().runOnce(5_001)).rejects.toThrow(/batch size/i)
    await expect(cleaner().runOnce(1.5)).rejects.toThrow(/batch size/i)
  })
})
