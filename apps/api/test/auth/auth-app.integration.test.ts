import { createHash, generateKeyPairSync } from 'node:crypto'

import type { PublicUser } from '@wx-upload/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildApp } from '../../src/app.js'
import type { AuthRepository } from '../../src/auth/auth-repository.js'
import { Ed25519TokenService, type TokenService } from '../../src/auth/token-service.js'
import type { WechatGateway } from '../../src/auth/wechat-gateway.js'
import { fakeDependencies } from '../support/fakes.js'

const user: PublicUser = {
  id: '01981c31-4c80-7000-8000-000000000111',
  nickname: null,
  nicknameConfirmed: false,
  nicknameConfirmedAt: null,
  createdAt: '2026-07-15T01:00:00.000Z',
  updatedAt: '2026-07-15T01:00:00.000Z',
}
const sessionId = '01981c31-4c80-7000-8000-000000000222'
const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function hash(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest()
}

describe('application auth composition', () => {
  it('registers login and profile routes against the injected identity dependencies', async () => {
    const verifyAccessToken = vi
      .fn<TokenService['verifyAccessToken']>()
      .mockResolvedValue({ sub: user.id, sid: sessionId })
    const loginWithIdentity = vi
      .fn<AuthRepository['loginWithIdentity']>()
      .mockResolvedValue({ user, sessionId, isNewUser: true })
    const getProfile = vi.fn<AuthRepository['getProfile']>().mockResolvedValue(user)
    const gateway: WechatGateway = {
      exchangeCode: vi.fn().mockResolvedValue({ openid: 'private-openid' }),
    }
    const tokens: TokenService = {
      issueAccessToken: vi.fn().mockResolvedValue('access-token'),
      verifyAccessToken,
      createRefreshToken: vi.fn(() => ({ token: 'rft_refresh', hash: hash('rft_refresh') })),
      hashRefreshToken: vi.fn(hash),
    }
    const repository: AuthRepository = {
      loginWithIdentity,
      rotateRefresh: vi.fn().mockResolvedValue({ kind: 'invalid' }),
      logout: vi.fn().mockResolvedValue(undefined),
      getProfile,
      updateNickname: vi.fn().mockResolvedValue(user),
    }
    const app = buildApp({
      ...fakeDependencies(),
      wechatAppId: 'wx-test-app',
      wechatGateway: gateway,
      tokenService: tokens,
      authRepository: repository,
    })
    apps.push(app)

    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/wechat-login',
      payload: { code: 'valid-code', deviceId: 'device-a' },
    })
    const profile = await app.inject({
      method: 'GET',
      url: '/v1/profile',
      headers: { authorization: 'Bearer access-token' },
    })

    expect(login.statusCode).toBe(200)
    expect(profile.statusCode).toBe(200)
    expect(login.body).not.toContain('private-openid')
    expect(loginWithIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'wx-test-app', openid: 'private-openid' }),
    )
    expect(verifyAccessToken).toHaveBeenCalledWith('access-token')
    expect(getProfile).toHaveBeenCalledWith(user.id)
  })

  it('keeps logout idempotent when the supplied refresh token is malformed', async () => {
    const pair = generateKeyPairSync('ed25519')
    const tokens = new Ed25519TokenService({
      privateKey: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(),
      publicKey: pair.publicKey.export({ format: 'pem', type: 'spki' }).toString(),
      clock: { now: () => new Date('2026-07-15T01:00:00.000Z') },
      ids: { next: () => '01981c31-4c80-7000-8000-000000000333' },
    })
    const logout = vi.fn<AuthRepository['logout']>().mockResolvedValue(undefined)
    const repository: AuthRepository = {
      loginWithIdentity: vi.fn(),
      rotateRefresh: vi.fn(),
      logout,
      getProfile: vi.fn(),
      updateNickname: vi.fn(),
    }
    const app = buildApp({
      ...fakeDependencies(),
      wechatAppId: 'wx-test-app',
      wechatGateway: { exchangeCode: vi.fn() },
      tokenService: tokens,
      authRepository: repository,
    })
    apps.push(app)
    const accessToken = await tokens.issueAccessToken({ userId: user.id, sessionId })

    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { refreshToken: 'malformed-refresh-token' },
    })

    expect(response.statusCode).toBe(204)
    expect(response.body).toBe('')
    expect(logout).not.toHaveBeenCalled()
  })
})
