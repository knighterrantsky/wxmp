import { randomUUID } from 'node:crypto'

import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { loadRuntimeConfig } from '../../src/config.js'
import { applyRoleGrants } from '../../src/db/grants.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import { runMaintenanceOnce } from '../../src/maintenance.js'
import { loadDestructiveDatabaseTestConfig } from '../support/destructive-database.js'

const migrationsDirectory = new URL('../../src/db/migrations/', import.meta.url).pathname
const { migrationDatabaseUrl, runtimeDatabaseUrl, maintenanceDatabaseUrl } =
  loadDestructiveDatabaseTestConfig(process.env)

let migrationPool: Pool
let runtimePool: Pool
let maintenancePool: Pool

async function resetAndGrant(): Promise<void> {
  await migrationPool.query('drop schema if exists media_app cascade')
  await migrationPool.query('drop table if exists public.schema_migrations')
  await runMigrations(migrationPool, migrationsDirectory)
  await applyRoleGrants(migrationPool, {
    runtimeRole: 'wx_runtime',
    maintenanceRole: 'wx_maintenance',
  })
}

beforeAll(() => {
  migrationPool = createPool(migrationDatabaseUrl)
  runtimePool = createPool(runtimeDatabaseUrl)
  maintenancePool = createPool(maintenanceDatabaseUrl)
})

beforeEach(resetAndGrant)

afterAll(async () => {
  await migrationPool.query('drop schema if exists media_app cascade')
  await migrationPool.query('drop table if exists public.schema_migrations')
  await Promise.all([runtimePool.end(), maintenancePool.end(), migrationPool.end()])
})

describe('runtime and maintenance database separation', () => {
  it('denies runtime UPDATE and DELETE on audit events while retaining append/read access', async () => {
    const eventId = randomUUID()
    await runtimePool.query(
      `insert into media_app.audit_events(
         event_id, actor_type, actor_service, event_type, entity_type
       ) values ($1, 'system', 'runtime-permission-test', 'runtime.audit.fixture', 'audit')`,
      [eventId],
    )

    await expect(
      runtimePool.query(
        `update media_app.audit_events set metadata = '{"changed":true}' where event_id = $1`,
        [eventId],
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      runtimePool.query('delete from media_app.audit_events where event_id = $1', [eventId]),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      runtimePool.query('select event_id from media_app.audit_events where event_id = $1', [
        eventId,
      ]),
    ).resolves.toMatchObject({ rowCount: 1 })
  })

  it('grants maintenance only the reads and deletes required by retention cleanup', async () => {
    const grants = await migrationPool.query<{
      table_name: string
      privilege_type: string
    }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'media_app' and grantee = 'wx_maintenance'
        order by table_name, privilege_type`,
    )

    expect(grants.rows).toEqual([
      { table_name: 'audit_events', privilege_type: 'DELETE' },
      { table_name: 'idempotency_records', privilege_type: 'DELETE' },
      { table_name: 'upload_parts', privilege_type: 'DELETE' },
      { table_name: 'user_sessions', privilege_type: 'DELETE' },
    ])
    const columnGrants = await migrationPool.query<{
      column_name: string
      privilege_type: string
      table_name: string
    }>(
      `select table_name, column_name, privilege_type
         from information_schema.role_column_grants
        where table_schema = 'media_app' and grantee = 'wx_maintenance'
          and privilege_type = 'SELECT'
        order by table_name, column_name`,
    )
    expect(columnGrants.rows).toEqual([
      { table_name: 'audit_events', column_name: 'id', privilege_type: 'SELECT' },
      { table_name: 'audit_events', column_name: 'occurred_at', privilege_type: 'SELECT' },
      {
        table_name: 'idempotency_records',
        column_name: 'expires_at',
        privilege_type: 'SELECT',
      },
      { table_name: 'idempotency_records', column_name: 'id', privilege_type: 'SELECT' },
      { table_name: 'idempotency_records', column_name: 'status', privilege_type: 'SELECT' },
      { table_name: 'upload_parts', column_name: 'upload_session_id', privilege_type: 'SELECT' },
      { table_name: 'upload_sessions', column_name: 'aborted_at', privilege_type: 'SELECT' },
      { table_name: 'upload_sessions', column_name: 'completed_at', privilege_type: 'SELECT' },
      { table_name: 'upload_sessions', column_name: 'expired_at', privilege_type: 'SELECT' },
      { table_name: 'upload_sessions', column_name: 'failed_at', privilege_type: 'SELECT' },
      { table_name: 'upload_sessions', column_name: 'id', privilege_type: 'SELECT' },
      { table_name: 'upload_sessions', column_name: 'status', privilege_type: 'SELECT' },
      { table_name: 'user_sessions', column_name: 'expires_at', privilege_type: 'SELECT' },
      { table_name: 'user_sessions', column_name: 'id', privilege_type: 'SELECT' },
      { table_name: 'user_sessions', column_name: 'revoked_at', privilege_type: 'SELECT' },
    ])
    await expect(
      maintenancePool.query('delete from media_app.upload_sessions where false'),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      maintenancePool.query('delete from media_app.media_objects where false'),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      maintenancePool.query(
        `insert into media_app.audit_events(
           event_id, actor_type, actor_service, event_type, entity_type
         ) values ($1, 'system', 'maintenance-test', 'maintenance.audit.fixture', 'audit')`,
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: '42501' })
    for (const query of [
      'select refresh_token_hash from media_app.user_sessions where false',
      'select response_body from media_app.idempotency_records where false',
      'select checksum_sha256 from media_app.upload_parts where false',
      'select r2_upload_id from media_app.upload_sessions where false',
    ]) {
      await expect(maintenancePool.query(query)).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('loads the API runtime without reading migration or maintenance credentials', () => {
    const forbidden = new Set(['MIGRATION_DATABASE_URL', 'MAINTENANCE_DATABASE_URL'])
    const env = new Proxy<Record<string, string | undefined>>(
      {
        NODE_ENV: 'test',
        DATABASE_URL: runtimeDatabaseUrl,
      },
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && forbidden.has(property)) {
            throw new Error(`runtime read forbidden key ${property}`)
          }
          return Reflect.get(target, property, receiver) as string | undefined
        },
      },
    )

    expect(loadRuntimeConfig(env).databaseUrl).toBe(runtimeDatabaseUrl)
  })

  it('runs maintenance without reading runtime, migration, or object-storage credentials', async () => {
    const forbidden = new Set([
      'DATABASE_URL',
      'MIGRATION_DATABASE_URL',
      'R2_ENDPOINT',
      'R2_BUCKET',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ])
    const env = new Proxy<Record<string, string | undefined>>(
      { MAINTENANCE_DATABASE_URL: maintenanceDatabaseUrl },
      {
        get(target, property, receiver) {
          if (typeof property === 'string' && forbidden.has(property)) {
            throw new Error(`maintenance read forbidden key ${property}`)
          }
          return Reflect.get(target, property, receiver) as string | undefined
        },
      },
    )

    await expect(runMaintenanceOnce(env)).resolves.toEqual({
      idempotencyRecords: 0,
      uploadParts: 0,
      uploadsWhosePartsWereDeleted: 0,
      userSessions: 0,
      auditEvents: 0,
    })
  })
})
