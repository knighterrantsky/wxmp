import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Pool } from 'pg'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PostgresAuthRepository } from '../../src/auth/auth-repository.js'
import { runMigrations } from '../../src/db/migrate.js'
import { createPool } from '../../src/db/pool.js'
import { applyRoleGrants } from '../../src/db/grants.js'
import { createSecureIdGenerator } from '../../src/lib/id.js'
import { loadDestructiveDatabaseTestConfig } from '../support/destructive-database.js'

const config = loadDestructiveDatabaseTestConfig(process.env)
const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '../../src/db/migrations')
const clock = { now: () => new Date('2026-07-15T03:00:00.000Z') }
const context = {
  requestId: '01981c9e-6c80-7000-8000-000000000099',
  sourceIp: '198.51.100.20',
  userAgent: 'repository-integration-test',
}

let migrationPool: Pool
let runtimePool: Pool

beforeAll(async () => {
  migrationPool = createPool(config.migrationDatabaseUrl)
  await runMigrations(migrationPool, migrationsDirectory)
  await applyRoleGrants(migrationPool, {
    runtimeRole: 'wx_runtime',
    maintenanceRole: 'wx_maintenance',
  })
  runtimePool = createPool(config.runtimeDatabaseUrl)
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

function repository(): PostgresAuthRepository {
  return new PostgresAuthRepository({
    pool: runtimePool,
    clock,
    ids: createSecureIdGenerator(clock),
  })
}

function loginInput(index: number) {
  return {
    appId: 'wx-concurrent-test',
    openid: 'same-private-openid',
    unionid: 'same-private-unionid',
    deviceId: `device-${String(index)}`,
    refreshTokenHash: Buffer.alloc(32, index),
    refreshExpiresAt: new Date('2026-08-14T03:00:00.000Z'),
    context,
  }
}

describe('PostgresAuthRepository', () => {
  it('concurrent first login creates one user mapping and two independent sessions', async () => {
    const [first, second] = await Promise.all([
      repository().loginWithIdentity(loginInput(1)),
      repository().loginWithIdentity(loginInput(2)),
    ])

    expect(first.user.id).toBe(second.user.id)
    expect([first.isNewUser, second.isNewUser].sort()).toEqual([false, true])
    expect(first.sessionId).not.toBe(second.sessionId)

    const counts = await migrationPool.query<{
      users: string
      identities: string
      sessions: string
      audits: string
    }>(`select
      (select count(*) from media_app.users)::text as users,
      (select count(*) from media_app.user_identities)::text as identities,
      (select count(*) from media_app.user_sessions)::text as sessions,
      (select count(*) from media_app.audit_events)::text as audits`)
    expect(counts.rows[0]).toEqual({ users: '1', identities: '1', sessions: '2', audits: '2' })
  })

  it('rotates once, detects replay, and revokes every session in the family', async () => {
    const repo = repository()
    const login = await repo.loginWithIdentity(loginInput(3))
    const oldHash = Buffer.alloc(32, 3)
    const newHash = Buffer.alloc(32, 4)

    await expect(
      repo.rotateRefresh({
        refreshTokenHash: oldHash,
        nextRefreshTokenHash: newHash,
        refreshExpiresAt: new Date('2026-08-14T03:01:00.000Z'),
        context,
      }),
    ).resolves.toMatchObject({ kind: 'rotated', user: { id: login.user.id } })
    await expect(
      repo.rotateRefresh({
        refreshTokenHash: oldHash,
        nextRefreshTokenHash: Buffer.alloc(32, 5),
        refreshExpiresAt: new Date('2026-08-14T03:02:00.000Z'),
        context,
      }),
    ).resolves.toEqual({ kind: 'reused' })

    const sessions = await migrationPool.query<{ active: string; reused: string }>(
      `select count(*) filter (where revoked_at is null)::text as active,
              count(*) filter (where reuse_detected_at is not null)::text as reused
         from media_app.user_sessions`,
    )
    expect(sessions.rows[0]).toEqual({ active: '0', reused: '2' })
  })

  it('serializes a current rotation against an old-token replay and always revokes the family', async () => {
    const repo = repository()
    const oldHash = Buffer.alloc(32, 20)
    const currentHash = Buffer.alloc(32, 21)
    await repo.loginWithIdentity({
      ...loginInput(20),
      refreshTokenHash: oldHash,
    })
    await repo.rotateRefresh({
      refreshTokenHash: oldHash,
      nextRefreshTokenHash: currentHash,
      refreshExpiresAt: new Date('2026-08-14T03:01:00.000Z'),
      context,
    })

    await migrationPool.query(`
      create or replace function media_app.test_delay_refresh_replay()
      returns trigger language plpgsql as $function$
      begin
        if old.revoke_reason = 'rotated'
           and old.reuse_detected_at is null
           and new.reuse_detected_at is not null then
          perform pg_sleep(0.3);
        end if;
        return new;
      end
      $function$;
      create trigger test_delay_refresh_replay
      before update on media_app.user_sessions
      for each row execute function media_app.test_delay_refresh_replay();
    `)

    try {
      const replay = repo.rotateRefresh({
        refreshTokenHash: oldHash,
        nextRefreshTokenHash: Buffer.alloc(32, 22),
        refreshExpiresAt: new Date('2026-08-14T03:02:00.000Z'),
        context,
      })
      await new Promise((resolve) => setTimeout(resolve, 30))
      const rotateCurrent = repo.rotateRefresh({
        refreshTokenHash: currentHash,
        nextRefreshTokenHash: Buffer.alloc(32, 23),
        refreshExpiresAt: new Date('2026-08-14T03:03:00.000Z'),
        context,
      })

      const results = await Promise.all([replay, rotateCurrent])
      expect(results[0]).toEqual({ kind: 'reused' })
      expect(['reused', 'rotated']).toContain(results[1].kind)
    } finally {
      await migrationPool.query(`
        drop trigger if exists test_delay_refresh_replay on media_app.user_sessions;
        drop function if exists media_app.test_delay_refresh_replay();
      `)
    }

    const family = await migrationPool.query<{ active: string; reused: string; total: string }>(
      `select count(*) filter (where revoked_at is null)::text as active,
              count(*) filter (where reuse_detected_at is not null)::text as reused,
              count(*)::text as total
         from media_app.user_sessions`,
    )
    expect(family.rows[0]?.active).toBe('0')
    expect(family.rows[0]?.reused).toBe(family.rows[0]?.total)
  })

  it('logs out only an owned refresh session and remains idempotent', async () => {
    const repo = repository()
    const first = await repo.loginWithIdentity(loginInput(6))
    const other = await repo.loginWithIdentity({
      ...loginInput(7),
      openid: 'different-private-openid',
      unionid: 'different-private-unionid',
    })

    await repo.logout({
      userId: first.user.id,
      accessSessionId: first.sessionId,
      refreshTokenHash: Buffer.alloc(32, 7),
      context,
    })
    await repo.logout({
      userId: first.user.id,
      accessSessionId: first.sessionId,
      refreshTokenHash: Buffer.alloc(32, 6),
      context,
    })
    await repo.logout({
      userId: first.user.id,
      accessSessionId: first.sessionId,
      refreshTokenHash: Buffer.alloc(32, 6),
      context,
    })

    const sessions = await migrationPool.query<{
      id: string
      revoked: boolean
    }>(
      `select id::text, revoked_at is not null as revoked
         from media_app.user_sessions order by id`,
    )
    expect(sessions.rows.find((row) => row.id === first.sessionId)?.revoked).toBe(true)
    expect(sessions.rows.find((row) => row.id === other.sessionId)?.revoked).toBe(false)
    const logoutAudits = await migrationPool.query<{ count: string }>(
      `select count(*)::text as count from media_app.audit_events
        where event_type = 'auth.logout'`,
    )
    expect(logoutAudits.rows[0]?.count).toBe('1')
  })

  it('persists confirmed profile state without placing the nickname in audit metadata', async () => {
    const repo = repository()
    const login = await repo.loginWithIdentity(loginInput(8))

    const updated = await repo.updateNickname({
      userId: login.user.id,
      sessionId: login.sessionId,
      nickname: '小晴😀',
      context,
    })

    expect(updated).toMatchObject({
      id: login.user.id,
      nickname: '小晴😀',
      nicknameConfirmed: true,
      nicknameConfirmedAt: '2026-07-15T03:00:00.000Z',
    })
    await expect(repo.getProfile(login.user.id)).resolves.toMatchObject(updated)
    const audit = await migrationPool.query<{ metadata: unknown }>(
      `select metadata from media_app.audit_events
        where event_type = 'profile.nickname_confirmed'`,
    )
    expect(audit.rows[0]?.metadata).toEqual({ source: 'wechatNicknameInput' })
    expect(JSON.stringify(audit.rows)).not.toContain('小晴')
  })

  it('blocks a disabled mapped user without creating another session', async () => {
    const repo = repository()
    const login = await repo.loginWithIdentity(loginInput(9))
    await migrationPool.query(`update media_app.users set status = 'disabled' where id = $1`, [
      login.user.id,
    ])

    await expect(repo.getProfile(login.user.id)).rejects.toMatchObject({
      code: 'USER_DISABLED',
      statusCode: 403,
    })
    await expect(
      repo.loginWithIdentity({ ...loginInput(10), refreshTokenHash: Buffer.alloc(32, 10) }),
    ).rejects.toMatchObject({ code: 'USER_DISABLED', statusCode: 403 })
    const count = await migrationPool.query<{ count: string }>(
      'select count(*)::text as count from media_app.user_sessions',
    )
    expect(count.rows[0]?.count).toBe('1')
  })
})
