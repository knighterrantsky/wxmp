import type { PublicUser, RefreshTokenResponse, WechatLoginResponse } from '@wx-upload/contracts'
import { describe, expect, it, vi } from 'vitest'

import { ApiClientError, type AuthenticationApi } from '../miniprogram/services/api-client.js'
import {
  API_SESSION_STORAGE_KEY,
  SessionStore,
  type ApiSession,
} from '../miniprogram/services/session-store.js'
import type { WechatRuntime } from '../miniprogram/runtime/wechat-runtime.js'

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

const loginData: WechatLoginResponse['data'] = {
  accessToken: 'access-one',
  accessTokenExpiresIn: 900,
  refreshToken: 'refresh-one',
  refreshTokenExpiresIn: 2_592_000,
  isNewUser: true,
  user: publicUser,
}

const refreshData: RefreshTokenResponse['data'] = {
  accessToken: 'access-two',
  accessTokenExpiresIn: 900,
  refreshToken: 'refresh-two',
  refreshTokenExpiresIn: 2_592_000,
}

interface RuntimeFixture {
  runtime: WechatRuntime
  runtimeLogin: ReturnType<typeof vi.fn<WechatRuntime['login']>>
  getStorage: ReturnType<typeof vi.fn<(key: string) => unknown>>
  setStorage: ReturnType<typeof vi.fn<(key: string, value: unknown) => void>>
  removeStorage: ReturnType<typeof vi.fn<(key: string) => void>>
  savedValues: Map<string, unknown>
}

function fakeRuntime(initial?: unknown): RuntimeFixture {
  const savedValues = new Map<string, unknown>()
  if (initial !== undefined) savedValues.set(API_SESSION_STORAGE_KEY, initial)

  const runtimeLogin = vi.fn<WechatRuntime['login']>().mockResolvedValue({ code: 'wx-code-one' })
  const getStorage = vi.fn((key: string) => savedValues.get(key))
  const setStorage = vi.fn((key: string, value: unknown) => {
    savedValues.set(key, value)
  })
  const removeStorage = vi.fn((key: string) => {
    savedValues.delete(key)
  })

  return {
    runtime: {
      login: runtimeLogin,
      request() {
        return Promise.reject(new Error('unused request'))
      },
      getStorage<T>(key: string, decode?: (value: unknown) => T) {
        const value = getStorage(key)
        if (value === undefined) return undefined
        return decode === undefined ? (value as T) : decode(value)
      },
      setStorage,
      removeStorage,
    },
    runtimeLogin,
    getStorage,
    setStorage,
    removeStorage,
    savedValues,
  }
}

interface ApiFixture {
  api: AuthenticationApi
  apiLogin: ReturnType<typeof vi.fn<AuthenticationApi['login']>>
  apiRefresh: ReturnType<typeof vi.fn<AuthenticationApi['refresh']>>
}

function fakeApi(): ApiFixture {
  const apiLogin = vi.fn<AuthenticationApi['login']>().mockResolvedValue(loginData)
  const apiRefresh = vi.fn<AuthenticationApi['refresh']>().mockResolvedValue(refreshData)
  return { api: { login: apiLogin, refresh: apiRefresh }, apiLogin, apiRefresh }
}

function fixture(initial?: unknown) {
  const runtimeFixture = fakeRuntime(initial)
  const apiFixture = fakeApi()
  const store = new SessionStore({
    runtime: runtimeFixture.runtime,
    api: apiFixture.api,
    deviceId: 'installation-one',
  })
  return { store, ...runtimeFixture, ...apiFixture }
}

describe('SessionStore', () => {
  it('uses wx.login when needed and persists only API tokens and public user data', async () => {
    const { store, runtimeLogin, apiLogin, setStorage, savedValues } = fixture()

    const session = await store.ensureSession()

    expect(runtimeLogin).toHaveBeenCalledOnce()
    expect(apiLogin).toHaveBeenCalledWith('wx-code-one', 'installation-one')
    expect(session).toEqual({
      accessToken: 'access-one',
      refreshToken: 'refresh-one',
      user: publicUser,
    })
    expect(setStorage).toHaveBeenCalledWith(API_SESSION_STORAGE_KEY, session)
    expect([...savedValues.keys()]).toEqual([API_SESSION_STORAGE_KEY])
    expect(JSON.stringify([...savedValues.values()])).not.toMatch(
      /openid|unionid|session_key|isNewUser|ExpiresIn/i,
    )
  })

  it('hydrates a valid API session without calling wx.login', async () => {
    const persisted: ApiSession = {
      accessToken: 'persisted-access',
      refreshToken: 'persisted-refresh',
      user: confirmedUser,
    }
    const { store, runtimeLogin, apiLogin, setStorage } = fixture(persisted)

    await expect(store.ensureSession()).resolves.toEqual(persisted)
    expect(runtimeLogin).not.toHaveBeenCalled()
    expect(apiLogin).not.toHaveBeenCalled()
    expect(setStorage).not.toHaveBeenCalled()
  })

  it('single-flights concurrent first-login attempts', async () => {
    const { store, runtimeLogin, apiLogin } = fixture()

    const [first, second, third] = await Promise.all([
      store.ensureSession(),
      store.ensureSession(),
      store.ensureSession(),
    ])

    expect(first).toBe(second)
    expect(second).toBe(third)
    expect(runtimeLogin).toHaveBeenCalledOnce()
    expect(apiLogin).toHaveBeenCalledOnce()
  })

  it('removes malformed storage before a fresh login', async () => {
    const { store, runtimeLogin, removeStorage } = fixture({
      accessToken: 'leaked-access',
      refreshToken: 'leaked-refresh',
      user: { ...publicUser, openid: 'must-not-survive' },
    })

    await store.ensureSession()

    expect(removeStorage).toHaveBeenCalledWith(API_SESSION_STORAGE_KEY)
    expect(runtimeLogin).toHaveBeenCalledOnce()
  })

  it('rotates both API tokens while preserving the public user', async () => {
    const persisted: ApiSession = {
      accessToken: 'access-one',
      refreshToken: 'refresh-one',
      user: publicUser,
    }
    const { store, apiRefresh, runtimeLogin, savedValues } = fixture(persisted)

    const session = await store.refreshOnce()

    expect(apiRefresh).toHaveBeenCalledWith('refresh-one')
    expect(runtimeLogin).not.toHaveBeenCalled()
    expect(session).toEqual({
      accessToken: 'access-two',
      refreshToken: 'refresh-two',
      user: publicUser,
    })
    expect(savedValues.get(API_SESSION_STORAGE_KEY)).toEqual(session)
  })

  it('single-flights concurrent token refreshes', async () => {
    const persisted: ApiSession = {
      accessToken: 'access-one',
      refreshToken: 'refresh-one',
      user: publicUser,
    }
    const { store, apiRefresh } = fixture(persisted)

    const [first, second] = await Promise.all([store.refreshOnce(), store.refreshOnce()])

    expect(first).toBe(second)
    expect(apiRefresh).toHaveBeenCalledOnce()
  })

  it('atomically merges a nickname update with an in-flight token rotation', async () => {
    const persisted: ApiSession = {
      accessToken: 'access-one',
      refreshToken: 'refresh-one',
      user: publicUser,
    }
    const { store, apiRefresh, savedValues } = fixture(persisted)
    let resolveRefresh: ((value: RefreshTokenResponse['data']) => void) | undefined
    apiRefresh.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        }),
    )

    const refreshing = store.refreshOnce()
    await vi.waitFor(() => {
      expect(apiRefresh).toHaveBeenCalledOnce()
    })
    const replacingUser = store.replaceUser(confirmedUser)
    await Promise.resolve()
    resolveRefresh?.(refreshData)

    await Promise.all([refreshing, replacingUser])
    const current = await store.ensureSession()
    expect(current).toEqual({
      accessToken: 'access-two',
      refreshToken: 'refresh-two',
      user: confirmedUser,
    })
    expect(savedValues.get(API_SESSION_STORAGE_KEY)).toEqual(current)
  })

  it.each([
    new ApiClientError({
      statusCode: 401,
      code: 'REFRESH_TOKEN_INVALID',
      message: '刷新凭据无效',
      retryable: false,
    }),
    new ApiClientError({
      statusCode: 401,
      code: 'REFRESH_TOKEN_REUSED',
      message: '检测到重放',
      retryable: false,
    }),
    new Error('refresh response was lost'),
  ])('clears a lost refresh rotation and performs a fresh wx.login', async (failure) => {
    const persisted: ApiSession = {
      accessToken: 'access-one',
      refreshToken: 'refresh-one',
      user: publicUser,
    }
    const { store, apiRefresh, removeStorage, runtimeLogin, apiLogin } = fixture(persisted)
    apiRefresh.mockRejectedValueOnce(failure)

    await expect(store.refreshOnce()).resolves.toMatchObject({ accessToken: 'access-one' })

    expect(removeStorage).toHaveBeenCalledWith(API_SESSION_STORAGE_KEY)
    expect(runtimeLogin).toHaveBeenCalledOnce()
    expect(apiLogin).toHaveBeenCalledWith('wx-code-one', 'installation-one')
  })

  it('does not mask a disabled user by attempting a fresh login', async () => {
    const persisted: ApiSession = {
      accessToken: 'access-one',
      refreshToken: 'refresh-one',
      user: publicUser,
    }
    const { store, apiRefresh, removeStorage, runtimeLogin } = fixture(persisted)
    const disabled = new ApiClientError({
      statusCode: 403,
      code: 'USER_DISABLED',
      message: '用户已禁用',
      retryable: false,
    })
    apiRefresh.mockRejectedValueOnce(disabled)

    await expect(store.refreshOnce()).rejects.toBe(disabled)

    expect(removeStorage).toHaveBeenCalledWith(API_SESSION_STORAGE_KEY)
    expect(runtimeLogin).not.toHaveBeenCalled()
  })

  it('retries a failed fresh login only on a later ensureSession call', async () => {
    const { store, apiLogin, runtimeLogin, savedValues } = fixture()
    apiLogin.mockRejectedValueOnce(new Error('offline'))

    await expect(store.ensureSession()).rejects.toThrow('offline')
    expect(savedValues.has(API_SESSION_STORAGE_KEY)).toBe(false)

    await expect(store.ensureSession()).resolves.toMatchObject({ accessToken: 'access-one' })
    expect(runtimeLogin).toHaveBeenCalledTimes(2)
  })

  it('persists a replaced public user after nickname confirmation', async () => {
    const persisted: ApiSession = {
      accessToken: 'access-one',
      refreshToken: 'refresh-one',
      user: publicUser,
    }
    const { store, savedValues } = fixture(persisted)

    const session = await store.replaceUser(confirmedUser)

    expect(session.user).toEqual(confirmedUser)
    expect(savedValues.get(API_SESSION_STORAGE_KEY)).toEqual(session)
  })

  it('clears memory and storage explicitly', async () => {
    const persisted: ApiSession = {
      accessToken: 'access-one',
      refreshToken: 'refresh-one',
      user: publicUser,
    }
    const { store, removeStorage, runtimeLogin } = fixture(persisted)
    await store.ensureSession()

    store.clear()

    expect(removeStorage).toHaveBeenCalledWith(API_SESSION_STORAGE_KEY)
    await store.ensureSession()
    expect(runtimeLogin).toHaveBeenCalledOnce()
  })
})
