import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import { loadDestructiveDatabaseTestConfig } from '../support/destructive-database.js'

const { migrationDatabaseUrl } = loadDestructiveDatabaseTestConfig(process.env)
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations')

let pool: Pool

async function resetDatabase(): Promise<void> {
  await pool.query('drop schema if exists media_app cascade')
  await pool.query('drop table if exists public.schema_migrations')
}

beforeAll(() => {
  pool = createPool(migrationDatabaseUrl)
})

beforeEach(resetDatabase)

afterAll(async () => {
  await resetDatabase()
  await pool.end()
})

describe('runMigrations', () => {
  it('creates the eight media_app business tables exactly once', async () => {
    await runMigrations(pool, migrationsDirectory)
    await runMigrations(pool, migrationsDirectory)

    const tables = await pool.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'media_app' order by tablename`,
    )
    const bookkeeping = await pool.query<{ count: string }>(
      'select count(*) from public.schema_migrations',
    )

    expect(tables.rows.map((row) => row.tablename)).toEqual([
      'audit_events',
      'idempotency_records',
      'media_objects',
      'upload_parts',
      'upload_sessions',
      'user_identities',
      'user_sessions',
      'users',
    ])
    expect(bookkeeping.rows[0]?.count).toBe('2')
  })

  it('installs all documented enum types, version triggers, and explicit indexes', async () => {
    await runMigrations(pool, migrationsDirectory)

    const enums = await pool.query<{ typname: string }>(
      `select t.typname
         from pg_type t
         join pg_namespace n on n.oid = t.typnamespace
        where n.nspname = 'media_app' and t.typtype = 'e'
        order by t.typname`,
    )
    const triggers = await pool.query<{ tgname: string }>(
      `select t.tgname
         from pg_trigger t
         join pg_class c on c.oid = t.tgrelid
         join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'media_app' and not t.tgisinternal
        order by t.tgname`,
    )
    const indexes = await pool.query<{ indexname: string }>(
      `select indexname
         from pg_indexes
        where schemaname = 'media_app' and indexname like 'ix_%'
        order by indexname`,
    )

    expect(enums.rows.map((row) => row.typname)).toEqual([
      'audit_actor_type',
      'idempotency_status',
      'identity_provider',
      'media_kind',
      'media_storage_status',
      'upload_part_status',
      'upload_session_status',
      'user_status',
    ])
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      'touch_idempotency_records',
      'touch_media_objects',
      'touch_upload_parts',
      'touch_upload_sessions',
      'touch_users',
    ])
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'ix_audit_entity',
      'ix_audit_request',
      'ix_audit_retention',
      'ix_audit_session',
      'ix_audit_time_brin',
      'ix_audit_user',
      'ix_idempotency_expiry',
      'ix_idempotency_resource',
      'ix_idempotency_stable_retention',
      'ix_media_storage_status',
      'ix_media_user_history',
      'ix_upload_abort_due',
      'ix_upload_expiry',
      'ix_upload_finalize_due',
      'ix_upload_parts_status',
      'ix_upload_reconcile_stuck',
      'ix_upload_terminal_retention',
      'ix_upload_user_history',
      'ix_user_identities_user',
      'ix_user_sessions_active',
      'ix_user_sessions_expired_retention',
      'ix_user_sessions_family',
      'ix_user_sessions_revoked_retention',
      'ix_user_sessions_rotated_from',
    ])
  })

  it('installs ownership, state-machine, size, hash, and audit constraints', async () => {
    await runMigrations(pool, migrationsDirectory)

    const constraints = await pool.query<{ conname: string }>(
      `select conname
         from pg_constraint c
         join pg_namespace n on n.oid = c.connamespace
        where n.nspname = 'media_app'
        order by conname`,
    )
    const names = new Set(constraints.rows.map((row) => row.conname))

    for (const expected of [
      'uq_identity_subject',
      'uq_media_object_key',
      'fk_upload_media_owner',
      'ck_media_size',
      'ck_media_object_key',
      'ck_media_ready_fields',
      'ck_upload_part_size',
      'ck_upload_part_count',
      'ck_upload_confirmed_progress',
      'ck_upload_finalize_schedule',
      'ck_upload_abort_schedule',
      'ck_upload_abort_reason_state',
      'ck_upload_completed',
      'ck_part_checksum',
      'ck_part_uploaded_fields',
      'uq_idempotency_scope',
      'ck_idempotency_hash',
      'ck_idempotency_response',
      'uq_audit_event_id',
      'ck_audit_actor',
      'ck_audit_json',
    ]) {
      expect(names).toContain(expected)
    }
  })

  it('serializes concurrent runners with an advisory lock', async () => {
    await Promise.all([
      runMigrations(pool, migrationsDirectory),
      runMigrations(pool, migrationsDirectory),
    ])

    const applied = await pool.query<{ count: string }>(
      'select count(*) from public.schema_migrations',
    )
    expect(applied.rows[0]?.count).toBe('2')
  })

  it('checksums the original migration bytes and refuses any drift', async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'wx-upload-migrations-'))
    const migrationName = '0001_initial.sql'
    const sql = await readFile(join(migrationsDirectory, migrationName), 'utf8')
    const temporaryMigration = join(temporaryDirectory, migrationName)

    try {
      await writeFile(temporaryMigration, sql)
      await runMigrations(pool, temporaryDirectory)
      await writeFile(temporaryMigration, `${sql}\n-- checksum drift\n`)

      await expect(runMigrations(pool, temporaryDirectory)).rejects.toThrow(
        /applied migration changed: 0001_initial\.sql/,
      )
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true })
    }
  })

  it('releases the advisory lock after a failed migration', async () => {
    const brokenDirectory = await mkdtemp(join(tmpdir(), 'wx-upload-broken-migrations-'))
    const brokenPool = new Pool({ connectionString: migrationDatabaseUrl, max: 1 })
    const contenderPool = new Pool({ connectionString: migrationDatabaseUrl, max: 1 })

    try {
      await writeFile(join(brokenDirectory, '0001_broken.sql'), 'this is invalid sql;')
      await expect(runMigrations(brokenPool, brokenDirectory)).rejects.toBeInstanceOf(Error)
      await contenderPool.query("set statement_timeout = '2s'")
      await runMigrations(contenderPool, migrationsDirectory)

      const applied = await contenderPool.query<{ count: string }>(
        'select count(*) from public.schema_migrations',
      )
      expect(applied.rows[0]?.count).toBe('2')
    } finally {
      await Promise.all([brokenPool.end(), contenderPool.end()])
      await rm(brokenDirectory, { recursive: true, force: true })
    }
  })
})
