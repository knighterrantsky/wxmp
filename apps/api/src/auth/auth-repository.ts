import type { PublicUser } from '@wx-upload/contracts'
import type { Pool, PoolClient } from 'pg'

import { ApiError } from '../http/errors.js'
import type { Clock } from '../lib/clock.js'
import type { IdGenerator } from '../lib/id.js'

export interface AuthRequestContext {
  requestId: string
  sourceIp?: string
  userAgent?: string
}

export interface LoginWithIdentityInput {
  appId: string
  openid: string
  unionid?: string
  deviceId: string
  refreshTokenHash: Buffer
  refreshExpiresAt: Date
  context: AuthRequestContext
}

export interface LoginWithIdentityResult {
  user: PublicUser
  sessionId: string
  isNewUser: boolean
}

export interface RotateRefreshInput {
  refreshTokenHash: Buffer
  nextRefreshTokenHash: Buffer
  refreshExpiresAt: Date
  context: AuthRequestContext
}

export type RotateRefreshResult =
  | { kind: 'rotated'; user: PublicUser; sessionId: string }
  | { kind: 'invalid' }
  | { kind: 'reused' }
  | { kind: 'disabled' }

export interface LogoutInput {
  userId: string
  accessSessionId: string
  refreshTokenHash: Buffer
  context: AuthRequestContext
}

export interface UpdateNicknameInput {
  userId: string
  sessionId: string
  nickname: string
  context: AuthRequestContext
}

export interface AuthRepository {
  loginWithIdentity(input: LoginWithIdentityInput): Promise<LoginWithIdentityResult>
  rotateRefresh(input: RotateRefreshInput): Promise<RotateRefreshResult>
  logout(input: LogoutInput): Promise<void>
  getProfile(userId: string): Promise<PublicUser>
  updateNickname(input: UpdateNicknameInput): Promise<PublicUser>
}

type UserStatus = 'active' | 'disabled' | 'deleted'

interface UserRow {
  id: string
  status: UserStatus
  nickname: string | null
  nickname_confirmed_at: Date | string | null
  created_at: Date | string
  updated_at: Date | string
}

interface RefreshSessionRow extends UserRow {
  session_id: string
  token_family_id: string
  device_id: string | null
  expires_at: Date | string
  revoked_at: Date | string | null
  revoke_reason: string | null
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error('database returned an invalid timestamp')
  return date.toISOString()
}

function publicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    nickname: row.nickname,
    nicknameConfirmed: row.nickname_confirmed_at !== null,
    nicknameConfirmedAt: row.nickname_confirmed_at === null ? null : iso(row.nickname_confirmed_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

function rejectInactiveUser(status: UserStatus | undefined): void {
  if (status === 'disabled') {
    throw new ApiError({
      code: 'USER_DISABLED',
      message: '用户已被禁用',
      statusCode: 403,
    })
  }
  if (status !== 'active') {
    throw new ApiError({
      code: 'UNAUTHORIZED',
      message: '请先登录',
      statusCode: 401,
    })
  }
}

async function rollback(client: PoolClient): Promise<void> {
  await client.query('rollback').catch(() => undefined)
}

export class PostgresAuthRepository implements AuthRepository {
  readonly #pool: Pool
  readonly #clock: Clock
  readonly #ids: IdGenerator

  constructor(deps: { pool: Pool; clock: Clock; ids: IdGenerator }) {
    this.#pool = deps.pool
    this.#clock = deps.clock
    this.#ids = deps.ids
  }

  async loginWithIdentity(input: LoginWithIdentityInput): Promise<LoginWithIdentityResult> {
    const client = await this.#pool.connect()
    const now = this.#clock.now()
    try {
      await client.query('begin')
      let userResult = await client.query<UserRow>(
        `select u.id, u.status, u.nickname, u.nickname_confirmed_at, u.created_at, u.updated_at
           from media_app.user_identities i
           join media_app.users u on u.id = i.user_id
          where i.provider = 'wechat_miniprogram'
            and i.app_id = $1
            and i.openid = $2
          for update of i, u`,
        [input.appId, input.openid],
      )
      let row = userResult.rows[0]
      let isNewUser = false

      if (row === undefined) {
        const speculativeUserId = this.#ids.next()
        const identityId = this.#ids.next()
        await client.query('savepoint create_identity')
        await client.query(
          `insert into media_app.users(id, last_seen_at, created_at, updated_at)
           values ($1, $2, $2, $2)`,
          [speculativeUserId, now],
        )
        const inserted = await client.query<{ user_id: string }>(
          `insert into media_app.user_identities(
             id, user_id, provider, app_id, openid, unionid, last_login_at, created_at
           ) values ($1, $2, 'wechat_miniprogram', $3, $4, $5, $6, $6)
           on conflict (provider, app_id, openid) do nothing
           returning user_id`,
          [identityId, speculativeUserId, input.appId, input.openid, input.unionid ?? null, now],
        )

        if (inserted.rowCount === 1) {
          await client.query('release savepoint create_identity')
          userResult = await client.query<UserRow>(
            `select id, status, nickname, nickname_confirmed_at, created_at, updated_at
               from media_app.users where id = $1 for update`,
            [speculativeUserId],
          )
          row = userResult.rows[0]
          isNewUser = true
        } else {
          await client.query('rollback to savepoint create_identity')
          await client.query('release savepoint create_identity')
          userResult = await client.query<UserRow>(
            `select u.id, u.status, u.nickname, u.nickname_confirmed_at, u.created_at, u.updated_at
               from media_app.user_identities i
               join media_app.users u on u.id = i.user_id
              where i.provider = 'wechat_miniprogram'
                and i.app_id = $1
                and i.openid = $2
              for update of i, u`,
            [input.appId, input.openid],
          )
          row = userResult.rows[0]
        }
      }

      if (row === undefined) throw new Error('identity mapping could not be loaded')
      rejectInactiveUser(row.status)

      await client.query(
        `update media_app.user_identities
            set unionid = coalesce($3, unionid), last_login_at = $4
          where provider = 'wechat_miniprogram' and app_id = $1 and openid = $2`,
        [input.appId, input.openid, input.unionid ?? null, now],
      )
      const touchedUser = await client.query<UserRow>(
        `update media_app.users set last_seen_at = $2 where id = $1
         returning id, status, nickname, nickname_confirmed_at, created_at, updated_at`,
        [row.id, now],
      )
      row = touchedUser.rows[0] ?? row

      const sessionId = this.#ids.next()
      const familyId = this.#ids.next()
      await client.query(
        `insert into media_app.user_sessions(
           id, user_id, token_family_id, refresh_token_hash, device_id,
           issued_at, expires_at, source_ip, user_agent
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          sessionId,
          row.id,
          familyId,
          input.refreshTokenHash,
          input.deviceId,
          now,
          input.refreshExpiresAt,
          input.context.sourceIp ?? null,
          input.context.userAgent ?? null,
        ],
      )
      await this.#insertAudit(client, {
        eventType: 'auth.login',
        userId: row.id,
        sessionId,
        context: input.context,
        metadata: { isNewUser },
      })
      await client.query('commit')
      return { user: publicUser(row), sessionId, isNewUser }
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async rotateRefresh(input: RotateRefreshInput): Promise<RotateRefreshResult> {
    const client = await this.#pool.connect()
    const now = this.#clock.now()
    try {
      await client.query('begin')
      const family = await client.query<{ token_family_id: string }>(
        `select token_family_id
           from media_app.user_sessions
          where refresh_token_hash = $1`,
        [input.refreshTokenHash],
      )
      const familyId = family.rows[0]?.token_family_id
      if (familyId === undefined) {
        await client.query('commit')
        return { kind: 'invalid' }
      }
      await client.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0::bigint))`, [
        familyId,
      ])

      const selected = await client.query<RefreshSessionRow>(
        `select s.id as session_id, s.token_family_id, s.device_id, s.expires_at,
                s.revoked_at, s.revoke_reason,
                u.id, u.status, u.nickname, u.nickname_confirmed_at, u.created_at, u.updated_at
           from media_app.user_sessions s
           join media_app.users u on u.id = s.user_id
          where s.refresh_token_hash = $1
          for update of s, u`,
        [input.refreshTokenHash],
      )
      const row = selected.rows[0]
      if (row === undefined) {
        await client.query('commit')
        return { kind: 'invalid' }
      }

      if (row.revoked_at !== null) {
        if (row.revoke_reason === 'rotated' || row.revoke_reason === 'refresh_reuse') {
          await client.query(
            `update media_app.user_sessions
                set revoked_at = coalesce(revoked_at, $2),
                    revoke_reason = case when revoked_at is null then 'refresh_reuse' else revoke_reason end,
                    reuse_detected_at = coalesce(reuse_detected_at, $2)
              where token_family_id = $1`,
            [row.token_family_id, now],
          )
          await this.#insertAudit(client, {
            eventType: 'auth.refresh_reuse',
            userId: row.id,
            sessionId: row.session_id,
            context: input.context,
            metadata: {},
          })
          await client.query('commit')
          return { kind: 'reused' }
        }
        await client.query('commit')
        return { kind: 'invalid' }
      }

      if (new Date(row.expires_at).getTime() <= now.getTime()) {
        await client.query(
          `update media_app.user_sessions
              set revoked_at = $2, revoke_reason = 'expired', last_used_at = $2
            where id = $1`,
          [row.session_id, now],
        )
        await client.query('commit')
        return { kind: 'invalid' }
      }

      if (row.status !== 'active') {
        await client.query(
          `update media_app.user_sessions
              set revoked_at = coalesce(revoked_at, $2),
                  revoke_reason = case when revoked_at is null then 'user_disabled' else revoke_reason end
            where token_family_id = $1`,
          [row.token_family_id, now],
        )
        await client.query('commit')
        return { kind: 'disabled' }
      }

      await client.query(
        `update media_app.user_sessions
            set revoked_at = $2, revoke_reason = 'rotated', last_used_at = $2
          where id = $1`,
        [row.session_id, now],
      )
      const nextSessionId = this.#ids.next()
      await client.query(
        `insert into media_app.user_sessions(
           id, user_id, token_family_id, rotated_from_session_id,
           refresh_token_hash, device_id, issued_at, expires_at, source_ip, user_agent
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          nextSessionId,
          row.id,
          row.token_family_id,
          row.session_id,
          input.nextRefreshTokenHash,
          row.device_id,
          now,
          input.refreshExpiresAt,
          input.context.sourceIp ?? null,
          input.context.userAgent ?? null,
        ],
      )
      await this.#insertAudit(client, {
        eventType: 'auth.refresh',
        userId: row.id,
        sessionId: nextSessionId,
        context: input.context,
        metadata: {},
      })
      await client.query('commit')
      return { kind: 'rotated', user: publicUser(row), sessionId: nextSessionId }
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async logout(input: LogoutInput): Promise<void> {
    const client = await this.#pool.connect()
    const now = this.#clock.now()
    try {
      await client.query('begin')
      const revoked = await client.query<{ id: string }>(
        `update media_app.user_sessions
            set revoked_at = $3, revoke_reason = 'logout', last_used_at = $3
          where user_id = $1 and refresh_token_hash = $2 and revoked_at is null
        returning id`,
        [input.userId, input.refreshTokenHash, now],
      )
      if (revoked.rowCount === 1) {
        await this.#insertAudit(client, {
          eventType: 'auth.logout',
          userId: input.userId,
          sessionId: input.accessSessionId,
          context: input.context,
          metadata: {},
        })
      }
      await client.query('commit')
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async getProfile(userId: string): Promise<PublicUser> {
    const result = await this.#pool.query<UserRow>(
      `select id, status, nickname, nickname_confirmed_at, created_at, updated_at
         from media_app.users where id = $1`,
      [userId],
    )
    const row = result.rows[0]
    rejectInactiveUser(row?.status)
    if (row === undefined) throw new Error('active user unexpectedly missing')
    return publicUser(row)
  }

  async updateNickname(input: UpdateNicknameInput): Promise<PublicUser> {
    const client = await this.#pool.connect()
    const now = this.#clock.now()
    try {
      await client.query('begin')
      const current = await client.query<UserRow>(
        `select id, status, nickname, nickname_confirmed_at, created_at, updated_at
           from media_app.users where id = $1 for update`,
        [input.userId],
      )
      const row = current.rows[0]
      rejectInactiveUser(row?.status)
      if (row === undefined) throw new Error('active user unexpectedly missing')

      const updated = await client.query<UserRow>(
        `update media_app.users set nickname = $2, nickname_confirmed_at = $3
          where id = $1
        returning id, status, nickname, nickname_confirmed_at, created_at, updated_at`,
        [input.userId, input.nickname, now],
      )
      const updatedRow = updated.rows[0]
      if (updatedRow === undefined) throw new Error('nickname update returned no user')
      await this.#insertAudit(client, {
        eventType: 'profile.nickname_confirmed',
        userId: input.userId,
        sessionId: input.sessionId,
        context: input.context,
        metadata: { source: 'wechatNicknameInput' },
      })
      await client.query('commit')
      return publicUser(updatedRow)
    } catch (error) {
      await rollback(client)
      throw error
    } finally {
      client.release()
    }
  }

  async #insertAudit(
    client: PoolClient,
    input: {
      eventType: string
      userId: string
      sessionId: string
      context: AuthRequestContext
      metadata: Record<string, unknown>
    },
  ): Promise<void> {
    await client.query(
      `insert into media_app.audit_events(
         event_id, actor_type, actor_user_id, actor_session_id, request_id,
         event_type, entity_type, entity_id, source_ip, metadata
       ) values ($1, 'user', $2, $3, $4, $5, 'user', $2, $6, $7::jsonb)`,
      [
        this.#ids.next(),
        input.userId,
        input.sessionId,
        input.context.requestId,
        input.eventType,
        input.context.sourceIp ?? null,
        JSON.stringify(input.metadata),
      ],
    )
  }
}
