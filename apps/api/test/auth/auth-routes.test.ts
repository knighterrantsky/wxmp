import type { PublicUser } from '@wx-upload/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildAppShell } from '../../src/app.js'
import {
  createAccessTokenPreHandler,
  registerAuthRoutes,
  type AccessTokenVerifier,
  type AuthRouteService,
} from '../../src/auth/auth-routes.js'
import { ApiError } from '../../src/http/errors.js'
import { fakeDependencies } from '../support/fakes.js'

const user: PublicUser = {
  id: '01981c31-4c80-7000-8000-000000000111',
  nickname: null,
  nicknameConfirmed: false,
  nicknameConfirmedAt: null,
  createdAt: '2026-07-15T01:00:00.000Z',
  updatedAt: '2026-07-15T01:00:00.000Z',
}

const tokenPair = {
  accessToken: 'access-token-new',
  accessTokenExpiresIn: 900,
  refreshToken: 'refresh-token-new',
  refreshTokenExpiresIn: 2_592_000,
} as const

const apps: ReturnType<typeof buildAppShell>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function fakeAuth(overrides: Partial<AuthRouteService> = {}): AuthRouteService {
  const auth: AuthRouteService = {
    loginWithWechat: vi
      .fn<AuthRouteService['loginWithWechat']>()
      .mockResolvedValue({ ...tokenPair, isNewUser: true, user }),
    refresh: vi.fn<AuthRouteService['refresh']>().mockResolvedValue(tokenPair),
    logout: vi.fn<AuthRouteService['logout']>().mockResolvedValue(undefined),
  }
  return { ...auth, ...overrides }
}

function fakeTokens(overrides: Partial<AccessTokenVerifier> = {}): AccessTokenVerifier {
  const tokens: AccessTokenVerifier = {
    verifyAccessToken: vi
      .fn<AccessTokenVerifier['verifyAccessToken']>()
      .mockResolvedValue({ sub: user.id, sid: '01981c31-4c80-7000-8000-000000000222' }),
  }
  return { ...tokens, ...overrides }
}

function authApp(
  input: {
    auth?: AuthRouteService
    tokens?: AccessTokenVerifier
  } = {},
): {
  app: ReturnType<typeof buildAppShell>
  auth: AuthRouteService
  tokens: AccessTokenVerifier
} {
  const app = buildAppShell(fakeDependencies())
  const auth = input.auth ?? fakeAuth()
  const tokens = input.tokens ?? fakeTokens()
  registerAuthRoutes(app, { auth, tokens })
  apps.push(app)
  return { app, auth, tokens }
}

describe('authentication routes', () => {
  it('returns the strict login envelope without WeChat or session identifiers', async () => {
    const privateLoginResult = {
      ...tokenPair,
      isNewUser: true,
      user: {
        ...user,
        openid: 'openid-must-not-leak',
        unionid: 'unionid-must-not-leak',
      },
      session_key: 'session-key-must-not-leak',
    }
    const auth = fakeAuth({
      loginWithWechat: vi
        .fn<AuthRouteService['loginWithWechat']>()
        .mockResolvedValue(privateLoginResult),
    })
    const { app } = authApp({ auth })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/wechat-login',
      headers: { 'user-agent': 'route-test-agent' },
      payload: { code: 'wx-login-code', deviceId: 'installation-device-id' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toMatchObject({
      data: { ...tokenPair, isNewUser: true, user },
      meta: { requestId: response.headers['x-request-id'], serverTime: '2026-07-15T01:00:00.000Z' },
    })
    expect(response.body).not.toMatch(/openid|unionid|session[_-]?key/i)
    expect(auth.loginWithWechat).toHaveBeenCalledWith(
      'wx-login-code',
      'installation-device-id',
      expect.objectContaining({
        requestId: response.headers['x-request-id'],
        sourceIp: '127.0.0.1',
        userAgent: 'route-test-agent',
      }),
    )
  })

  it('rejects unknown login fields before invoking the service', async () => {
    const { app, auth } = authApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/wechat-login',
      payload: { code: 'wx-login-code', deviceId: 'device-id', userId: user.id },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(auth.loginWithWechat).not.toHaveBeenCalled()
  })

  it('enforces the login policy at ten requests per IP per minute', async () => {
    const { app, auth } = authApp()

    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/wechat-login',
        payload: { code: `wx-code-${String(index)}`, deviceId: 'device-id' },
      })
      expect(response.statusCode, `login ${String(index + 1)}`).toBe(200)
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/v1/auth/wechat-login',
      payload: { code: 'wx-code-limited', deviceId: 'device-id' },
    })

    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED', retryable: true } })
    expect(auth.loginWithWechat).toHaveBeenCalledTimes(10)
  })

  it('returns a freshly rotated token pair from refresh', async () => {
    const { app, auth } = authApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'refresh-token-old' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: tokenPair })
    expect(auth.refresh).toHaveBeenCalledWith(
      'refresh-token-old',
      expect.objectContaining({ requestId: response.headers['x-request-id'] }),
    )
  })

  it('limits refresh attempts independently to thirty requests per IP per minute', async () => {
    const { app, auth } = authApp()

    for (let index = 0; index < 30; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken: `refresh-token-${String(index)}` },
      })
      expect(response.statusCode, `refresh ${String(index + 1)}`).toBe(200)
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'refresh-token-limited' },
    })

    expect(limited.statusCode).toBe(429)
    expect(limited.json()).toMatchObject({ error: { code: 'RATE_LIMITED', retryable: true } })
    expect(auth.refresh).toHaveBeenCalledTimes(30)
  })

  it('maps refresh-token reuse without exposing the submitted token', async () => {
    const auth = fakeAuth({
      refresh: vi.fn<AuthRouteService['refresh']>().mockRejectedValue(
        new ApiError({
          code: 'REFRESH_TOKEN_REUSED',
          message: 'private refresh-token-old',
          statusCode: 401,
        }),
      ),
    })
    const { app } = authApp({ auth })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'refresh-token-old' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'REFRESH_TOKEN_REUSED' } })
    expect(response.body).not.toContain('refresh-token-old')
  })

  it('performs idempotent authenticated logout and returns an empty 204 twice', async () => {
    const { app, auth, tokens } = authApp()

    const responses = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { authorization: 'Bearer access-token-valid' },
        payload: { refreshToken: 'refresh-token-current' },
      }),
      app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { authorization: 'Bearer access-token-valid' },
        payload: { refreshToken: 'refresh-token-current' },
      }),
    ])

    expect(responses.map((response) => response.statusCode)).toEqual([204, 204])
    expect(responses.map((response) => response.body)).toEqual(['', ''])
    expect(tokens.verifyAccessToken).toHaveBeenCalledTimes(2)
    expect(auth.logout).toHaveBeenCalledTimes(2)
    expect(auth.logout).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: user.id,
        sessionId: '01981c31-4c80-7000-8000-000000000222',
        refreshToken: 'refresh-token-current',
      }),
    )
  })

  it.each([
    [undefined, 'missing'],
    ['Basic access-token-valid', 'wrong scheme'],
    ['Bearer', 'missing token'],
    ['Bearer  access-token-valid', 'extra whitespace'],
    ['Bearer access-token-valid, Bearer second-token', 'multiple tokens'],
    ['bearer access-token-valid', 'wrong scheme casing'],
  ])('rejects a %s authorization header (%s)', async (authorization, _description) => {
    void _description
    const { app, auth, tokens } = authApp()

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: authorization === undefined ? {} : { authorization },
      payload: { refreshToken: 'refresh-token-current' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } })
    expect(tokens.verifyAccessToken).not.toHaveBeenCalled()
    expect(auth.logout).not.toHaveBeenCalled()
  })

  it('preserves the expired-token error from access verification', async () => {
    const tokens = fakeTokens({
      verifyAccessToken: vi.fn<AccessTokenVerifier['verifyAccessToken']>().mockRejectedValue(
        new ApiError({
          code: 'TOKEN_EXPIRED',
          message: 'private JWT details',
          statusCode: 401,
        }),
      ),
    })
    const { app, auth } = authApp({ tokens })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: 'Bearer expired-access-token' },
      payload: { refreshToken: 'refresh-token-current' },
    })

    expect(response.statusCode).toBe(401)
    expect(response.json()).toMatchObject({ error: { code: 'TOKEN_EXPIRED' } })
    expect(response.body).not.toContain('private JWT details')
    expect(auth.logout).not.toHaveBeenCalled()
  })

  it('applies the authenticated ordinary-user policy to logout', async () => {
    const { app, auth } = authApp()

    for (let index = 0; index < 120; index += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        headers: { authorization: 'Bearer access-token-valid' },
        payload: { refreshToken: 'refresh-token-current' },
      })
      expect(response.statusCode, `logout ${String(index + 1)}`).toBe(204)
    }
    const limited = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: 'Bearer access-token-valid' },
      payload: { refreshToken: 'refresh-token-current' },
    })

    expect(limited.statusCode).toBe(429)
    expect(auth.logout).toHaveBeenCalledTimes(120)
  })

  it.each([
    ['USER_DISABLED', 403],
    ['WECHAT_CODE_INVALID', 401],
    ['WECHAT_SERVICE_UNAVAILABLE', 503],
    ['UPSTREAM_TIMEOUT', 504],
  ] as const)('maps the %s login failure to HTTP %i', async (code, statusCode) => {
    const auth = fakeAuth({
      loginWithWechat: vi.fn<AuthRouteService['loginWithWechat']>().mockRejectedValue(
        new ApiError({
          code,
          message: 'private upstream response',
          statusCode,
          retryable: statusCode >= 500,
        }),
      ),
    })
    const { app } = authApp({ auth })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/wechat-login',
      payload: { code: 'wx-login-code', deviceId: 'device-id' },
    })

    expect(response.statusCode).toBe(statusCode)
    expect(response.json()).toMatchObject({ error: { code } })
    expect(response.body).not.toContain('private upstream response')
  })

  it('exports a reusable access-token preHandler', async () => {
    const tokens = fakeTokens()
    const app = buildAppShell(fakeDependencies())
    apps.push(app)
    app.get('/__test/protected', { preHandler: createAccessTokenPreHandler(tokens) }, () => ({
      protected: true,
    }))

    const response = await app.inject({
      method: 'GET',
      url: '/__test/protected',
      headers: { authorization: 'Bearer reusable-access-token' },
    })

    expect(response.statusCode).toBe(200)
    expect(tokens.verifyAccessToken).toHaveBeenCalledWith('reusable-access-token')
  })
})
