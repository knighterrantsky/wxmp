import type { Pool, PoolClient } from 'pg'

export interface DatabaseRoleNames {
  runtimeRole: string
  maintenanceRole: string
}

const ROLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]{0,62}$/

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`
}

function assertSafeRoleName(identifier: string, field: string): void {
  const normalized = identifier.toLowerCase()
  if (
    !ROLE_PATTERN.test(identifier) ||
    normalized === 'public' ||
    normalized === 'postgres' ||
    normalized.startsWith('pg_')
  ) {
    throw new Error(`Invalid configuration: ${field}`)
  }
}

interface RoleSafetyRow {
  rolname: string
  is_safe: boolean
}

async function assertLeastPrivilegeRoles(
  client: PoolClient,
  roleNames: DatabaseRoleNames,
): Promise<void> {
  const result = await client.query<RoleSafetyRow>(
    `select r.rolname,
            (
              r.rolcanlogin
              and not r.rolinherit
              and not r.rolsuper
              and not r.rolcreatedb
              and not r.rolcreaterole
              and not r.rolreplication
              and not r.rolbypassrls
              and r.rolname <> current_user
              and not exists (
                select 1 from pg_auth_members m where m.member = r.oid
              )
              and not exists (
                select 1
                  from pg_database d
                 where d.datname = current_database() and d.datdba = r.oid
              )
              and not exists (
                select 1
                  from pg_namespace n
                 where n.nspname in ('public', 'media_app') and n.nspowner = r.oid
              )
              and not exists (
                select 1
                  from pg_class c
                  join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'media_app' and c.relowner = r.oid
              )
              and not exists (
                select 1
                  from pg_proc p
                  join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'media_app' and p.proowner = r.oid
              )
              and not exists (
                select 1
                  from pg_type t
                  join pg_namespace n on n.oid = t.typnamespace
                 where n.nspname = 'media_app' and t.typowner = r.oid
              )
            ) as is_safe
       from pg_roles r
      where r.rolname = any($1::text[])`,
    [[roleNames.runtimeRole, roleNames.maintenanceRole]],
  )

  const safetyByRole = new Map(result.rows.map((row) => [row.rolname, row.is_safe]))
  if (safetyByRole.get(roleNames.runtimeRole) !== true) {
    throw new Error('Invalid configuration: DATABASE_RUNTIME_ROLE')
  }
  if (safetyByRole.get(roleNames.maintenanceRole) !== true) {
    throw new Error('Invalid configuration: DATABASE_MAINTENANCE_ROLE')
  }
}

export async function applyRoleGrants(pool: Pool, roleNames: DatabaseRoleNames): Promise<void> {
  assertSafeRoleName(roleNames.runtimeRole, 'DATABASE_RUNTIME_ROLE')
  assertSafeRoleName(roleNames.maintenanceRole, 'DATABASE_MAINTENANCE_ROLE')
  if (roleNames.runtimeRole === roleNames.maintenanceRole) {
    throw new Error('database roles must be distinct')
  }

  const runtimeRole = quoteIdentifier(roleNames.runtimeRole)
  const maintenanceRole = quoteIdentifier(roleNames.maintenanceRole)
  const client = await pool.connect()

  try {
    await client.query('begin')
    await assertLeastPrivilegeRoles(client, roleNames)

    const database = await client.query<{ name: string }>('select current_database() as name')
    const databaseName = database.rows[0]?.name
    if (databaseName === undefined) {
      throw new Error('could not determine current database')
    }
    const quotedDatabase = quoteIdentifier(databaseName)

    await client.query(`revoke all on database ${quotedDatabase} from public`)
    await client.query(`revoke all on database ${quotedDatabase} from ${runtimeRole}`)
    await client.query(`revoke all on database ${quotedDatabase} from ${maintenanceRole}`)
    await client.query(
      `grant connect on database ${quotedDatabase} to ${runtimeRole}, ${maintenanceRole}`,
    )

    await client.query('revoke all on schema public from public')
    await client.query('revoke all on schema media_app from public')
    await client.query('revoke all on all tables in schema media_app from public')
    await client.query('revoke all on all sequences in schema media_app from public')
    await client.query('revoke execute on function media_app.touch_versioned_row() from public')

    for (const role of [runtimeRole, maintenanceRole]) {
      await client.query(`revoke all on schema media_app from ${role}`)
      await client.query(`revoke all on all tables in schema media_app from ${role}`)
      await client.query(`revoke all on all sequences in schema media_app from ${role}`)
      await client.query(`revoke execute on function media_app.touch_versioned_row() from ${role}`)
      await client.query(`grant usage on schema media_app to ${role}`)
    }

    await client.query(
      `grant select, insert, update on table
         media_app.users,
         media_app.user_identities,
         media_app.user_sessions,
         media_app.media_objects,
         media_app.upload_sessions,
         media_app.upload_parts,
         media_app.idempotency_records
       to ${runtimeRole}`,
    )
    await client.query(`grant select, insert on table media_app.audit_events to ${runtimeRole}`)
    await client.query(
      `grant usage, select on sequence media_app.audit_events_id_seq to ${runtimeRole}`,
    )
    await client.query(
      `grant execute on function media_app.touch_versioned_row() to ${runtimeRole}`,
    )

    await client.query(
      `grant delete on table
         media_app.audit_events,
         media_app.idempotency_records,
         media_app.upload_parts,
         media_app.user_sessions
       to ${maintenanceRole}`,
    )
    await client.query(
      `grant select (id, occurred_at)
         on table media_app.audit_events to ${maintenanceRole}`,
    )
    await client.query(
      `grant select (id, status, expires_at)
         on table media_app.idempotency_records to ${maintenanceRole}`,
    )
    await client.query(
      `grant select (upload_session_id)
         on table media_app.upload_parts to ${maintenanceRole}`,
    )
    await client.query(
      `grant select (id, status, completed_at, aborted_at, expired_at, failed_at)
         on table media_app.upload_sessions to ${maintenanceRole}`,
    )
    await client.query(
      `grant select (id, expires_at, revoked_at)
         on table media_app.user_sessions to ${maintenanceRole}`,
    )

    await client.query('commit')
  } catch (error) {
    await client.query('rollback').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
