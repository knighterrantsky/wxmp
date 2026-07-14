import type { NicknameRequest, PublicUser } from '@wx-upload/contracts'

import { ApiError } from '../http/errors.js'
import type { Clock } from '../lib/clock.js'
import type { Metrics } from '../observability/metrics.js'
import { validateNickname } from '../profile/nickname.js'
import type {
  AuthRepository,
  AuthRequestContext,
  LoginWithIdentityInput,
} from './auth-repository.js'
import {
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  type TokenService,
} from './token-service.js'
import type { WechatGateway } from './wechat-gateway.js'

export type { AuthRepository, AuthRequestContext } from './auth-repository.js'

export interface AuthTokenPair {
  accessToken: string
  accessTokenExpiresIn: number
  refreshToken: string
  refreshTokenExpiresIn: number
}

export interface LoginResult extends AuthTokenPair {
  isNewUser: boolean
  user: PublicUser
}

export interface AuthServiceDependencies {
  appId: string
  clock: Clock
  gateway: WechatGateway
  repository: AuthRepository
  tokens: TokenService
  metrics?: Metrics
}

function expiresAt(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1_000)
}

function assertOpaqueInput(value: string, name: string): void {
  if (value.length < 1 || value.length > 128 || value.includes('\u0000')) {
    throw new ApiError({
      code: 'VALIDATION_ERROR',
      message: `${name} is invalid`,
      statusCode: 422,
    })
  }
}

export class AuthService {
  readonly #appId: string
  readonly #clock: Clock
  readonly #gateway: WechatGateway
  readonly #repository: AuthRepository
  readonly #tokens: TokenService
  readonly #metrics: Metrics | undefined

  constructor(deps: AuthServiceDependencies) {
    this.#appId = deps.appId
    this.#clock = deps.clock
    this.#gateway = deps.gateway
    this.#repository = deps.repository
    this.#tokens = deps.tokens
    this.#metrics = deps.metrics
  }

  async loginWithWechat(
    code: string,
    deviceId: string,
    context: AuthRequestContext,
  ): Promise<LoginResult> {
    assertOpaqueInput(code, 'code')
    assertOpaqueInput(deviceId, 'deviceId')
    const startedAt = process.hrtime.bigint()
    try {
      const identity = await this.#gateway.exchangeCode(code)
      const refresh = this.#tokens.createRefreshToken()
      const now = this.#clock.now()
      const input: LoginWithIdentityInput = {
        appId: this.#appId,
        openid: identity.openid,
        deviceId,
        refreshTokenHash: refresh.hash,
        refreshExpiresAt: expiresAt(now, REFRESH_TOKEN_TTL_SECONDS),
        context,
        ...(identity.unionid === undefined ? {} : { unionid: identity.unionid }),
      }
      const login = await this.#repository.loginWithIdentity(input)
      const accessToken = await this.#tokens.issueAccessToken({
        userId: login.user.id,
        sessionId: login.sessionId,
      })
      this.#recordLogin('success', startedAt)
      return {
        accessToken,
        accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
        refreshToken: refresh.token,
        refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
        isNewUser: login.isNewUser,
        user: login.user,
      }
    } catch (error) {
      this.#recordLogin('error', startedAt)
      throw error
    }
  }

  async refresh(refreshToken: string, context: AuthRequestContext): Promise<AuthTokenPair> {
    const oldHash = this.#tokens.hashRefreshToken(refreshToken)
    const nextRefresh = this.#tokens.createRefreshToken()
    const result = await this.#repository.rotateRefresh({
      refreshTokenHash: oldHash,
      nextRefreshTokenHash: nextRefresh.hash,
      refreshExpiresAt: expiresAt(this.#clock.now(), REFRESH_TOKEN_TTL_SECONDS),
      context,
    })
    if (result.kind === 'reused') {
      throw new ApiError({
        code: 'REFRESH_TOKEN_REUSED',
        message: '检测到刷新凭据重复使用',
        statusCode: 401,
      })
    }
    if (result.kind === 'disabled') {
      throw new ApiError({
        code: 'USER_DISABLED',
        message: '用户已被禁用',
        statusCode: 403,
      })
    }
    if (result.kind === 'invalid') {
      throw new ApiError({
        code: 'REFRESH_TOKEN_INVALID',
        message: '刷新凭据无效或已过期',
        statusCode: 401,
      })
    }
    const accessToken = await this.#tokens.issueAccessToken({
      userId: result.user.id,
      sessionId: result.sessionId,
    })
    return {
      accessToken,
      accessTokenExpiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshToken: nextRefresh.token,
      refreshTokenExpiresIn: REFRESH_TOKEN_TTL_SECONDS,
    }
  }

  async logout(input: {
    userId: string
    sessionId: string
    refreshToken: string
    context: AuthRequestContext
  }): Promise<void> {
    let refreshTokenHash: Buffer
    try {
      refreshTokenHash = this.#tokens.hashRefreshToken(input.refreshToken)
    } catch (error) {
      if (error instanceof ApiError && error.code === 'REFRESH_TOKEN_INVALID') return
      throw error
    }
    await this.#repository.logout({
      userId: input.userId,
      accessSessionId: input.sessionId,
      refreshTokenHash,
      context: input.context,
    })
  }

  getProfile(userId: string): Promise<PublicUser> {
    return this.#repository.getProfile(userId)
  }

  updateNickname(input: {
    userId: string
    sessionId: string
    request: NicknameRequest
    context: AuthRequestContext
  }): Promise<PublicUser> {
    const nickname = validateNickname(input.request)
    return this.#repository.updateNickname({
      userId: input.userId,
      sessionId: input.sessionId,
      nickname,
      context: input.context,
    })
  }

  #recordLogin(outcome: 'success' | 'error', startedAt: bigint): void {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000
    this.#metrics?.recordLogin({ outcome, durationSeconds })
  }
}
