import type { PublicUser } from '@wx-upload/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildAppShell } from '../../src/app.js'
import type { AccessTokenVerifier } from '../../src/auth/auth-routes.js'
import { ApiError } from '../../src/http/errors.js'
import {
  registerProfileRoutes,
  type ProfileRouteService,
} from '../../src/profile/profile-routes.js'
import { fakeDependencies } from '../support/fakes.js'

const user: PublicUser = {
  id: '01981c31-4c80-7000-8000-000000000311',
  nickname: '小晴',
  nicknameConfirmed: true,
  nicknameConfirmedAt: '2026-07-15T01:00:00.000Z',
  createdAt: '2026-07-14T01:00:00.000Z',
  updatedAt: '2026-07-15T01:00:00.000Z',
}

const sessionId = '01981c31-4c80-7000-8000-000000000322'
const apps: ReturnType<typeof buildAppShell>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

function fakeProfile(overrides: Partial<ProfileRouteService> = {}): ProfileRouteService {
  const profile: ProfileRouteService = {
    getProfile: vi.fn<ProfileRouteService['getProfile']>().mockResolvedValue(user),
    updateNickname: vi.fn<ProfileRouteService['updateNickname']>().mockResolvedValue(user),
  }
  return { ...profile, ...overrides }
}

function fakeTokens(): AccessTokenVerifier {
  return {
    verifyAccessToken: vi
      .fn<AccessTokenVerifier['verifyAccessToken']>()
      .mockResolvedValue({ sub: user.id, sid: sessionId }),
  }
}

function profileApp(
  input: {
    profile?: ProfileRouteService
    tokens?: AccessTokenVerifier
  } = {},
): {
  app: ReturnType<typeof buildAppShell>
  profile: ProfileRouteService
  tokens: AccessTokenVerifier
} {
  const app = buildAppShell(fakeDependencies())
  const profile = input.profile ?? fakeProfile()
  const tokens = input.tokens ?? fakeTokens()
  registerProfileRoutes(app, { auth: profile, tokens })
  apps.push(app)
  return { app, profile, tokens }
}

describe('profile routes', () => {
  it('returns the authenticated public profile without identity-provider fields', async () => {
    const privateUser = {
      ...user,
      openid: 'openid-must-not-leak',
      unionid: 'unionid-must-not-leak',
      session_key: 'session-key-must-not-leak',
    }
    const profile = fakeProfile({
      getProfile: vi.fn<ProfileRouteService['getProfile']>().mockResolvedValue(privateUser),
    })
    const { app } = profileApp({ profile })

    const response = await app.inject({
      method: 'GET',
      url: '/v1/profile',
      headers: { authorization: 'Bearer access-token-valid' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.json()).toMatchObject({
      data: { user },
      meta: { requestId: response.headers['x-request-id'], serverTime: '2026-07-15T01:00:00.000Z' },
    })
    expect(response.body).not.toMatch(/openid|unionid|session[_-]?key/i)
    expect(profile.getProfile).toHaveBeenCalledWith(user.id)
  })

  it('updates only a separately confirmed WeChat nickname', async () => {
    const { app, profile } = profileApp()

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/profile/nickname',
      headers: {
        authorization: 'Bearer access-token-valid',
        'user-agent': 'nickname-route-test',
      },
      payload: {
        nickname: '  小晴  ',
        source: 'wechatNicknameInput',
        confirmed: true,
      },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toMatchObject({ data: { user } })
    expect(profile.updateNickname).toHaveBeenCalledWith({
      userId: user.id,
      sessionId,
      request: {
        nickname: '  小晴  ',
        source: 'wechatNicknameInput',
        confirmed: true,
      },
      context: {
        requestId: response.headers['x-request-id'],
        sourceIp: '127.0.0.1',
        userAgent: 'nickname-route-test',
      },
    })
  })

  it.each([
    [
      { nickname: '小晴', source: 'wechatNicknameInput', confirmed: true, userId: user.id },
      'unknown field',
    ],
    [{ nickname: '小晴', source: 'manual', confirmed: true }, 'wrong source'],
    [{ nickname: '小晴', source: 'wechatNicknameInput', confirmed: false }, 'missing confirmation'],
  ])('rejects an invalid nickname body (%s)', async (payload, _description) => {
    void _description
    const { app, profile } = profileApp()

    const response = await app.inject({
      method: 'PUT',
      url: '/v1/profile/nickname',
      headers: { authorization: 'Bearer access-token-valid' },
      payload,
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
    expect(profile.updateNickname).not.toHaveBeenCalled()
  })

  it('returns USER_DISABLED from profile access without leaking repository details', async () => {
    const profile = fakeProfile({
      getProfile: vi.fn<ProfileRouteService['getProfile']>().mockRejectedValue(
        new ApiError({
          code: 'USER_DISABLED',
          message: 'private database status row',
          statusCode: 403,
        }),
      ),
    })
    const { app } = profileApp({ profile })

    const response = await app.inject({
      method: 'GET',
      url: '/v1/profile',
      headers: { authorization: 'Bearer access-token-valid' },
    })

    expect(response.statusCode).toBe(403)
    expect(response.json()).toMatchObject({ error: { code: 'USER_DISABLED' } })
    expect(response.body).not.toContain('private database status row')
  })

  it('shares the authenticated ordinary-user quota across profile routes', async () => {
    const { app, profile } = profileApp()

    for (let index = 0; index < 120; index += 1) {
      const response = await app.inject({
        method: 'GET',
        url: '/v1/profile',
        headers: { authorization: 'Bearer access-token-valid' },
      })
      expect(response.statusCode, `profile read ${String(index + 1)}`).toBe(200)
    }
    const limited = await app.inject({
      method: 'PUT',
      url: '/v1/profile/nickname',
      headers: { authorization: 'Bearer access-token-valid' },
      payload: { nickname: '小晴', source: 'wechatNicknameInput', confirmed: true },
    })

    expect(limited.statusCode).toBe(429)
    expect(profile.getProfile).toHaveBeenCalledTimes(120)
    expect(profile.updateNickname).not.toHaveBeenCalled()
  })
})
