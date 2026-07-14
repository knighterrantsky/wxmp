import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Pool } from 'pg'
import { loadMigrationConfig } from '../config.js'
import { applyRoleGrants } from './grants.js'
import { createPool } from './pool.js'

const MIGRATION_FILE_PATTERN = /^\d{4}_[a-z0-9_]+\.sql$/
const MIGRATION_LOCK_ID = 1_977_071_401

export async function runMigrations(pool: Pool, directory: string): Promise<void> {
  const client = await pool.connect()
  let locked = false

  try {
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_ID])
    locked = true
    await client.query(`create table if not exists public.schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default clock_timestamp()
    )`)

    const files = (await readdir(directory))
      .filter((name) => MIGRATION_FILE_PATTERN.test(name))
      .sort()

    for (const version of files) {
      const sqlBytes = await readFile(join(directory, version))
      const checksum = createHash('sha256').update(sqlBytes).digest('hex')
      const existing = await client.query<{ checksum: string }>(
        'select checksum from public.schema_migrations where version = $1',
        [version],
      )

      if (existing.rowCount === 1) {
        if (existing.rows[0]?.checksum !== checksum) {
          throw new Error(`applied migration changed: ${version}`)
        }
        continue
      }

      await client.query('begin')
      try {
        await client.query(sqlBytes.toString('utf8'))
        await client.query(
          'insert into public.schema_migrations(version, checksum) values ($1, $2)',
          [version, checksum],
        )
        await client.query('commit')
      } catch (error) {
        await client.query('rollback').catch(() => undefined)
        throw error
      }
    }
  } finally {
    if (locked) {
      await client
        .query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_ID])
        .catch(() => undefined)
    }
    client.release()
  }
}

async function main(): Promise<void> {
  const config = loadMigrationConfig(process.env)
  const pool = createPool(config.databaseUrl)
  try {
    await runMigrations(pool, resolve(process.cwd(), 'src/db/migrations'))
    await applyRoleGrants(pool, config)
  } finally {
    await pool.end()
  }
}

const entrypoint = process.argv[1]
if (entrypoint !== undefined && fileURLToPath(import.meta.url) === resolve(entrypoint)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'migration failed'
    console.error(message)
    process.exitCode = 1
  })
}
