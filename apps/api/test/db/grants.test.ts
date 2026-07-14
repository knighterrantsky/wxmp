import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { applyRoleGrants } from '../../src/db/grants.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import { loadDestructiveDatabaseTestConfig } from '../support/destructive-database.js'

const { migrationDatabaseUrl, runtimeDatabaseUrl, maintenanceDatabaseUrl } =
  loadDestructiveDatabaseTestConfig(process.env)
const migrationsDirectory = new URL('../../src/db/migrations/', import.meta.url).pathname

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

describe('applyRoleGrants', () => {
  it('safely quotes every configured role identifier', async () => {
    const statements: string[] = []
    const fakeClient = {
      query(statement: string) {
        statements.push(statement)
        if (statement.includes('from pg_roles')) {
          return Promise.resolve({
            rows: [
              { rolname: 'RuntimeRole', is_safe: true },
              { rolname: 'MaintenanceRole', is_safe: true },
            ],
            rowCount: 2,
          })
        }
        if (statement === 'select current_database() as name') {
          return Promise.resolve({ rows: [{ name: 'wx_upload' }], rowCount: 1 })
        }
        return Promise.resolve({ rows: [], rowCount: 0 })
      },
      release() {
        return undefined
      },
    }
    const fakePool = {
      connect() {
        return Promise.resolve(fakeClient)
      },
    } as unknown as Pool

    await applyRoleGrants(fakePool, {
      runtimeRole: 'RuntimeRole',
      maintenanceRole: 'MaintenanceRole',
    })

    const sql = statements.join('\n')
    expect(sql).toContain('to "RuntimeRole"')
    expect(sql).toContain('to "MaintenanceRole"')
    expect(sql).not.toMatch(/to RuntimeRole\b/)
  })

  it.each([
    {
      runtimeRole: 'wx_migrate',
      maintenanceRole: 'wx_maintenance',
      field: 'DATABASE_RUNTIME_ROLE',
    },
    {
      runtimeRole: 'wx_runtime',
      maintenanceRole: 'wx_migrate',
      field: 'DATABASE_MAINTENANCE_ROLE',
    },
  ])('rejects the migration owner as a lower-privilege role', async (roleNames) => {
    await expect(applyRoleGrants(migrationPool, roleNames)).rejects.toThrow(roleNames.field)
  })

  it('rejects a missing database role before issuing grants', async () => {
    await expect(
      applyRoleGrants(migrationPool, {
        runtimeRole: 'wx_role_does_not_exist',
        maintenanceRole: 'wx_maintenance',
      }),
    ).rejects.toThrow(/DATABASE_RUNTIME_ROLE/)
  })

  it('gives runtime only INSERT and SELECT on audit events', async () => {
    const grants = await migrationPool.query<{ privilege_type: string }>(
      `select privilege_type
         from information_schema.role_table_grants
        where table_schema = 'media_app'
          and table_name = 'audit_events'
          and grantee = 'wx_runtime'
        order by privilege_type`,
    )

    expect(grants.rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT'])
  })

  it('does not grant runtime DELETE on any business table', async () => {
    const grants = await migrationPool.query<{ table_name: string }>(
      `select table_name
         from information_schema.role_table_grants
        where table_schema = 'media_app'
          and grantee = 'wx_runtime'
          and privilege_type = 'DELETE'
        order by table_name`,
    )

    expect(grants.rows).toEqual([])

    for (const table of [
      'audit_events',
      'idempotency_records',
      'media_objects',
      'upload_parts',
      'upload_sessions',
      'user_identities',
      'user_sessions',
      'users',
    ]) {
      await expect(
        runtimePool.query(`delete from media_app.${table} where false`),
        table,
      ).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('prevents the runtime role from deleting audit rows', async () => {
    await runtimePool.query(
      `insert into media_app.audit_events
         (event_id, actor_type, actor_service, event_type, entity_type)
       values ($1, 'system', 'grants-test', 'test.created', 'test')`,
      [randomUUID()],
    )

    await expect(runtimePool.query('delete from media_app.audit_events')).rejects.toMatchObject({
      code: '42501',
    })
    const result = await migrationPool.query<{ count: string }>(
      'select count(*) from media_app.audit_events',
    )
    expect(result.rows[0]?.count).toBe('1')
  })

  it('limits maintenance deletes to retention-owned tables', async () => {
    const grants = await migrationPool.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where table_schema = 'media_app'
          and grantee = 'wx_maintenance'
          and privilege_type = 'DELETE'
        order by table_name`,
    )

    expect(grants.rows).toEqual([
      { table_name: 'audit_events', privilege_type: 'DELETE' },
      { table_name: 'idempotency_records', privilege_type: 'DELETE' },
      { table_name: 'upload_parts', privilege_type: 'DELETE' },
      { table_name: 'user_sessions', privilege_type: 'DELETE' },
    ])

    await expect(
      maintenancePool.query('delete from media_app.audit_events where false'),
    ).resolves.toMatchObject({ rowCount: 0 })
    await expect(
      maintenancePool.query('delete from media_app.media_objects where false'),
    ).rejects.toMatchObject({ code: '42501' })

    await expect(
      maintenancePool.query('select count(*) from media_app.upload_sessions'),
    ).resolves.toMatchObject({ rowCount: 1 })
    await expect(
      maintenancePool.query('delete from media_app.upload_sessions where false'),
    ).rejects.toMatchObject({ code: '42501' })
  })

  it('revokes PUBLIC defaults from the database, schemas, tables, sequences, and functions', async () => {
    const publicDatabaseGrants = await migrationPool.query<{ count: string }>(
      `select count(*)
         from pg_database d
         cross join lateral aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
        where d.datname = current_database() and a.grantee = 0`,
    )
    const publicSchemaGrants = await migrationPool.query<{ count: string }>(
      `select count(*)
         from pg_namespace n
         cross join lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
        where n.nspname in ('public', 'media_app') and a.grantee = 0`,
    )
    const publicTableGrants = await migrationPool.query<{ count: string }>(
      `select count(*)
         from information_schema.role_table_grants
        where table_schema = 'media_app' and grantee = 'PUBLIC'`,
    )
    const publicSequenceGrants = await migrationPool.query<{ count: string }>(
      `select count(*)
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
         cross join lateral aclexplode(coalesce(c.relacl, acldefault('S', c.relowner))) a
        where n.nspname = 'media_app' and c.relkind = 'S' and a.grantee = 0`,
    )
    const publicFunctionGrants = await migrationPool.query<{ count: string }>(
      `select count(*)
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
         cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
        where n.nspname = 'media_app'
          and p.proname = 'touch_versioned_row'
          and a.grantee = 0`,
    )

    expect(publicDatabaseGrants.rows[0]?.count).toBe('0')
    expect(publicSchemaGrants.rows[0]?.count).toBe('0')
    expect(publicTableGrants.rows[0]?.count).toBe('0')
    expect(publicSequenceGrants.rows[0]?.count).toBe('0')
    expect(publicFunctionGrants.rows[0]?.count).toBe('0')
  })

  it('rejects assigning runtime and maintenance privileges to the same role', async () => {
    await expect(
      applyRoleGrants(migrationPool, {
        runtimeRole: 'wx_runtime',
        maintenanceRole: 'wx_runtime',
      }),
    ).rejects.toThrow(/roles/i)
  })

  it.each([
    'PUBLIC',
    'postgres',
    'pg_read_all_data',
    'PG_custom_role',
    'runtime"; drop role postgres; --',
  ])('rejects the dangerous database role name %s before issuing SQL', async (role) => {
    const poolThatMustNotConnect = {
      connect() {
        throw new Error('must not connect')
      },
    } as unknown as Pool

    await expect(
      applyRoleGrants(poolThatMustNotConnect, {
        runtimeRole: role,
        maintenanceRole: 'wx_maintenance',
      }),
    ).rejects.toThrow(/DATABASE_RUNTIME_ROLE/)
    await expect(
      applyRoleGrants(poolThatMustNotConnect, {
        runtimeRole: 'wx_runtime',
        maintenanceRole: role,
      }),
    ).rejects.toThrow(/DATABASE_MAINTENANCE_ROLE/)
  })
})
