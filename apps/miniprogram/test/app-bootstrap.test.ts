import type { NicknameRequest, PublicUser } from '@wx-upload/contracts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApplicationGlobalData } from '../miniprogram/app.js'
import { API_BASE_URL } from '../miniprogram/config.generated.js'

const publicUser: PublicUser = {
  id: '01981d0c-ec80-7000-8000-000000000101',
  nickname: null,
  nicknameConfirmed: false,
  createdAt: '2026-07-15T04:00:00.000Z',
}

const confirmedUser: PublicUser = {
  ...publicUser,
  nickname: '小晴',
  nicknameConfirmed: true,
  nicknameConfirmedAt: '2026-07-15T05:00:00.000Z',
  updatedAt: '2026-07-15T05:00:00.000Z',
}

interface RegisteredApplication {
  globalData: ApplicationGlobalData
  onLaunch?: (this: RegisteredApplication) => void
}

interface WxRequestOptions {
  readonly url: string
  readonly method: string
  readonly header?: Record<string, string>
  readonly data?: unknown
  success(result: { statusCode: number; data: unknown; header: Record<string, string> }): void
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('real mini-program application bootstrap', () => {
  it('logs in on launch, stores only sanitized API state, and wires nickname confirmation', async () => {
    const storage = new Map<string, unknown>()
    const requests: WxRequestOptions[] = []
    let application: RegisteredApplication | undefined

    const login = vi.fn((options: { success(result: { code: string }): void }): void => {
      options.success({ code: 'wx-code-one' })
    })
    const request = vi.fn((options: WxRequestOptions): void => {
      requests.push(options)
      const data = options.url.endsWith('/v1/auth/wechat-login')
        ? {
            accessToken: 'access-one',
            accessTokenExpiresIn: 900,
            refreshToken: 'refresh-one',
            refreshTokenExpiresIn: 2_592_000,
            isNewUser: true,
            user: publicUser,
          }
        : { user: confirmedUser }
      options.success({
        statusCode: 200,
        data: {
          data,
          meta: {
            requestId: '01981d0c-ec80-7000-8000-000000000102',
            serverTime: '2026-07-15T04:00:00.000Z',
          },
        },
        header: {},
      })
    })

    vi.stubGlobal('wx', {
      getRandomValues: vi.fn(() =>
        Promise.resolve({
          randomValues: Uint8Array.from({ length: 16 }, (_value, index) => index).buffer,
          errMsg: 'getRandomValues:ok',
        }),
      ),
      getStorageSync: (key: string) => storage.get(key),
      login,
      removeStorageSync: (key: string) => storage.delete(key),
      request,
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    })
    vi.stubGlobal('App', (definition: RegisteredApplication) => {
      application = definition
    })

    await import('../miniprogram/app.js')
    if (application === undefined) throw new Error('App was not registered')

    application.onLaunch?.call(application)
    await expect(application.globalData.ensureSession()).resolves.toEqual(publicUser)

    expect(login).toHaveBeenCalledOnce()
    expect(requests[0]).toMatchObject({
      method: 'POST',
      url: `${API_BASE_URL}/v1/auth/wechat-login`,
      data: { code: 'wx-code-one', deviceId: 'installation-000102030405060708090a0b0c0d0e0f' },
    })
    expect([...storage.keys()].sort()).toEqual(['apiSession', 'installationId'])
    expect(JSON.stringify(storage.get('apiSession'))).not.toMatch(
      /openid|unionid|session_key|isNewUser|ExpiresIn/i,
    )

    const nicknameRequest: NicknameRequest = {
      nickname: '小晴',
      source: 'wechatNicknameInput',
      confirmed: true,
    }
    await expect(
      application.globalData.profileApi.updateNickname(nicknameRequest),
    ).resolves.toEqual(confirmedUser)
    expect(requests[1]).toMatchObject({
      method: 'PUT',
      url: `${API_BASE_URL}/v1/profile/nickname`,
      header: { authorization: 'Bearer access-one', 'content-type': 'application/json' },
      data: nicknameRequest,
    })
    expect(application.globalData.publicUser).toEqual(confirmedUser)
    expect(storage.get('apiSession')).toMatchObject({ user: confirmedUser })
  })

  it('allows a later bootstrap retry after random installation-id generation fails once', async () => {
    const storage = new Map<string, unknown>()
    let application: RegisteredApplication | undefined
    const getRandomValues = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary random source failure'))
      .mockResolvedValueOnce({
        randomValues: new Uint8Array(16).buffer,
        errMsg: 'getRandomValues:ok',
      })

    vi.stubGlobal('wx', {
      getRandomValues,
      getStorageSync: (key: string) => storage.get(key),
      login: (options: { success(result: { code: string }): void }) => {
        options.success({ code: 'wx-code-retry' })
      },
      removeStorageSync: (key: string) => storage.delete(key),
      request: (options: WxRequestOptions) => {
        options.success({
          statusCode: 200,
          data: {
            data: {
              accessToken: 'access-retry',
              accessTokenExpiresIn: 900,
              refreshToken: 'refresh-retry',
              refreshTokenExpiresIn: 2_592_000,
              isNewUser: false,
              user: publicUser,
            },
            meta: {
              requestId: '01981d0c-ec80-7000-8000-000000000103',
              serverTime: '2026-07-15T04:00:00.000Z',
            },
          },
          header: {},
        })
      },
      setStorageSync: (key: string, value: unknown) => storage.set(key, value),
    })
    vi.stubGlobal('App', (definition: RegisteredApplication) => {
      application = definition
    })

    await import('../miniprogram/app.js')
    if (application === undefined) throw new Error('App was not registered')

    await expect(application.globalData.ensureSession()).rejects.toThrow(
      'temporary random source failure',
    )
    await expect(application.globalData.ensureSession()).resolves.toEqual(publicUser)
    expect(getRandomValues).toHaveBeenCalledTimes(2)
  })
})
