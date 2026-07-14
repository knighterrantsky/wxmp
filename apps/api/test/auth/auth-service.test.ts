import { createHash } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { AuthService, type AuthRepository } from '../../src/auth/auth-service.js'
import type { TokenService } from '../../src/auth/token-service.js'
import type { WechatGateway } from '../../src/auth/wechat-gateway.js'
import { ApiError } from '../../src/http/errors.js'

const now = new Date('2026-07-15T03:00:00.000Z')
const user = {
  id: '01981c9e-6c80-7000-8000-000000000001',
  nickname: null,
  nicknameConfirmed: false,
  nicknameConfirmedAt: null,
  createdAt: '2026-07-15T03:00:00.000Z',
  updatedAt: '2026-07-15T03:00:00.000Z',
} as const

function fakeTokens(): TokenService {
  let refreshIndex = 0
  return {
    issueAccessToken: vi.fn<TokenService['issueAccessToken']>(({ sessionId }) =>
      Promise.resolve(`access-${sessionId}`),
    ),
    verifyAccessToken: vi.fn<TokenService['verifyAccessToken']>((token) => {
      if (!token.startsWith('access-')) {
        return Promise.reject(
          new ApiError({ code: 'UNAUTHORIZED', message: 'private', statusCode: 401 }),
        )
      }
      return Promise.resolve({
        sub: user.id,
        sid: token.slice('access-'.length),
      })
    }),
    createRefreshToken: vi.fn<TokenService['createRefreshToken']>(() => {
      refreshIndex += 1
      const token = `rft_test_${String(refreshIndex)}`
      return { token, hash: createHash('sha256').update(token).digest() }
    }),
    hashRefreshToken: vi.fn<TokenService['hashRefreshToken']>((token) =>
      createHash('sha256').update(token).digest(),
    ),
  }
}

function requestContext() {
  return {
    requestId: '01981c9e-6c80-7000-8000-000000000010',
    sourceIp: '198.51.100.20',
    userAgent: 'wechat-devtools',
  }
}

describe('AuthService', () => {
  it('rejects a database-incompatible device identifier before identity exchange', async () => {
    const exchangeCode = vi.fn<WechatGateway['exchangeCode']>()
    const gateway: WechatGateway = { exchangeCode }
    const repository = {
      loginWithIdentity: vi.fn(),
      rotateRefresh: vi.fn(),
      logout: vi.fn(),
      getProfile: vi.fn(),
      updateNickname: vi.fn(),
    } as unknown as AuthRepository
    const service = new AuthService({
      appId: 'wx-test-app',
      clock: { now: () => now },
      gateway,
      repository,
      tokens: fakeTokens(),
    })

    await expect(
      service.loginWithWechat('valid-code', 'device\u0000id', requestContext()),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR', statusCode: 422 })
    expect(exchangeCode).not.toHaveBeenCalled()
  })

  it('maps repeated codes resolving to one openid onto one internal user without returning identifiers', async () => {
    const identities = new Map<string, typeof user>()
    const gateway: WechatGateway = {
      exchangeCode: vi.fn(() =>
        Promise.resolve({ openid: 'openid-private-value', unionid: 'unionid-private-value' }),
      ),
    }
    let sessionIndex = 0
    const loginWithIdentity = vi.fn((input: { openid: string }) => {
      const existing = identities.get(input.openid)
      const mapped = existing ?? user
      identities.set(input.openid, mapped)
      sessionIndex += 1
      return Promise.resolve({
        user: mapped,
        sessionId: `01981c9e-6c80-7000-8000-${String(sessionIndex).padStart(12, '0')}`,
        isNewUser: existing === undefined,
      })
    })
    const repository = {
      loginWithIdentity,
      rotateRefresh: vi.fn(),
      logout: vi.fn(),
      getProfile: vi.fn(),
      updateNickname: vi.fn(),
    } as unknown as AuthRepository
    const service = new AuthService({
      appId: 'wx-test-app',
      clock: { now: () => now },
      gateway,
      repository,
      tokens: fakeTokens(),
    })

    const first = await service.loginWithWechat('code-1', 'device-a', requestContext())
    const second = await service.loginWithWechat('code-2', 'device-b', requestContext())

    expect(second.user.id).toBe(first.user.id)
    expect(first.isNewUser).toBe(true)
    expect(second.isNewUser).toBe(false)
    expect(JSON.stringify([first, second])).not.toMatch(/openid|unionid|session_key/i)
    expect(loginWithIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: 'wx-test-app',
        openid: 'openid-private-value',
        unionid: 'unionid-private-value',
        deviceId: 'device-a',
      }),
    )
  })

  it('rotates a refresh token and maps replay to family-reuse failure', async () => {
    const repository = {
      loginWithIdentity: vi.fn(),
      rotateRefresh: vi
        .fn()
        .mockResolvedValueOnce({
          kind: 'rotated',
          user,
          sessionId: '01981c9e-6c80-7000-8000-000000000020',
        })
        .mockResolvedValueOnce({ kind: 'reused' }),
      logout: vi.fn(),
      getProfile: vi.fn(),
      updateNickname: vi.fn(),
    } as unknown as AuthRepository
    const service = new AuthService({
      appId: 'wx-test-app',
      clock: { now: () => now },
      gateway: { exchangeCode: vi.fn() },
      repository,
      tokens: fakeTokens(),
    })

    const rotated = await service.refresh('rft_old', requestContext())
    expect(rotated).toMatchObject({
      accessToken: 'access-01981c9e-6c80-7000-8000-000000000020',
      accessTokenExpiresIn: 900,
      refreshTokenExpiresIn: 2_592_000,
    })
    await expect(service.refresh('rft_old', requestContext())).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_REUSED',
      statusCode: 401,
    })
  })

  it('maps an unknown or expired refresh token to the same public error', async () => {
    const repository = {
      loginWithIdentity: vi.fn(),
      rotateRefresh: vi.fn(() => Promise.resolve({ kind: 'invalid' as const })),
      logout: vi.fn(),
      getProfile: vi.fn(),
      updateNickname: vi.fn(),
    } as unknown as AuthRepository
    const service = new AuthService({
      appId: 'wx-test-app',
      clock: { now: () => now },
      gateway: { exchangeCode: vi.fn() },
      repository,
      tokens: fakeTokens(),
    })

    await expect(service.refresh('rft_unknown', requestContext())).rejects.toMatchObject({
      code: 'REFRESH_TOKEN_INVALID',
      statusCode: 401,
    })
  })
})
