import type { PublicUser } from '@wx-upload/contracts'
import { describe, expect, it, vi } from 'vitest'

import { ApiClient, type AuthorizedSession } from '../miniprogram/services/api-client.js'
import { createWechatRuntime } from '../miniprogram/runtime/wechat-runtime.js'
import type {
  HttpRequest,
  HttpResponse,
  WechatRuntime,
} from '../miniprogram/runtime/wechat-runtime.js'

const publicUser: PublicUser = {
  id: '01981d0c-ec80-7000-8000-000000000101',
  nickname: null,
  nicknameConfirmed: false,
  createdAt: '2026-07-15T04:00:00.000Z',
}

const meta = {
  requestId: '01981d0c-ec80-7000-8000-000000000102',
  serverTime: '2026-07-15T04:00:00.000Z',
}

function response<T>(statusCode: number, data: T): HttpResponse<T> {
  return { statusCode, data, headers: {} }
}

function tokenExpired() {
  return response(401, {
    error: {
      code: 'TOKEN_EXPIRED',
      message: '访问凭据已过期',
      retryable: true,
    },
    meta,
  })
}

interface ClientFixture {
  client: ApiClient
  request: ReturnType<typeof vi.fn<(request: HttpRequest) => Promise<HttpResponse<unknown>>>>
}

function fixture(): ClientFixture {
  const request = vi
    .fn<(request: HttpRequest) => Promise<HttpResponse<unknown>>>()
    .mockResolvedValue(response(200, { data: { value: 'ok' }, meta }))
  const runtime: WechatRuntime = {
    login: vi.fn<WechatRuntime['login']>(),
    async request<T>(input: HttpRequest, decode?: (value: unknown) => T) {
      const result = await request(input)
      return {
        ...result,
        data: decode === undefined ? (result.data as T) : decode(result.data),
      }
    },
    getStorage() {
      return undefined
    },
    setStorage: vi.fn<WechatRuntime['setStorage']>(),
    removeStorage: vi.fn<WechatRuntime['removeStorage']>(),
  }
  return {
    client: new ApiClient({ runtime, baseUrl: 'https://api.example.com' }),
    request,
  }
}

function fakeAuthorizedSession(): AuthorizedSession & {
  ensureSession: ReturnType<typeof vi.fn<AuthorizedSession['ensureSession']>>
  refreshOnce: ReturnType<typeof vi.fn<AuthorizedSession['refreshOnce']>>
} {
  const current = {
    accessToken: 'access-old',
    refreshToken: 'refresh-old',
    user: publicUser,
  }
  return {
    ensureSession: vi.fn<AuthorizedSession['ensureSession']>().mockResolvedValue(current),
    refreshOnce: vi.fn<AuthorizedSession['refreshOnce']>().mockResolvedValue({
      ...current,
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
    }),
  }
}

describe('ApiClient', () => {
  it('posts a WeChat code and installation identifier to the login endpoint', async () => {
    const { client, request } = fixture()
    request.mockResolvedValueOnce(
      response(200, {
        data: {
          accessToken: 'access-one',
          accessTokenExpiresIn: 900,
          refreshToken: 'refresh-one',
          refreshTokenExpiresIn: 2_592_000,
          isNewUser: true,
          user: publicUser,
        },
        meta,
      }),
    )

    await expect(client.login('wx-code-one', 'installation-one')).resolves.toMatchObject({
      accessToken: 'access-one',
      user: publicUser,
    })
    expect(request).toHaveBeenCalledWith({
      method: 'POST',
      url: 'https://api.example.com/v1/auth/wechat-login',
      headers: { 'content-type': 'application/json' },
      data: { code: 'wx-code-one', deviceId: 'installation-one' },
    })
  })

  it('rejects a malformed login response before it can enter session storage', async () => {
    const { client, request } = fixture()
    request.mockResolvedValueOnce(
      response(200, {
        data: {
          accessToken: 'access-one',
          accessTokenExpiresIn: 900,
          refreshToken: 'refresh-one',
          refreshTokenExpiresIn: 2_592_000,
          isNewUser: true,
          user: { ...publicUser, openid: 'must-be-rejected' },
        },
        meta,
      }),
    )

    await expect(client.login('wx-code-one', 'installation-one')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      statusCode: 502,
    })
  })

  it('rotates a refresh token without attaching an access token', async () => {
    const { client, request } = fixture()
    request.mockResolvedValueOnce(
      response(200, {
        data: {
          accessToken: 'access-two',
          accessTokenExpiresIn: 900,
          refreshToken: 'refresh-two',
          refreshTokenExpiresIn: 2_592_000,
        },
        meta,
      }),
    )

    await client.refresh('refresh-one')

    expect(request.mock.calls[0]?.[0]).toEqual({
      method: 'POST',
      url: 'https://api.example.com/v1/auth/refresh',
      headers: { 'content-type': 'application/json' },
      data: { refreshToken: 'refresh-one' },
    })
  })

  it('rejects a malformed token rotation response', async () => {
    const { client, request } = fixture()
    request.mockResolvedValueOnce(
      response(200, {
        data: {
          accessToken: 'access-two',
          accessTokenExpiresIn: 900,
          refreshToken: '',
          refreshTokenExpiresIn: 2_592_000,
        },
        meta,
      }),
    )

    await expect(client.refresh('refresh-one')).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      statusCode: 502,
    })
  })

  it('adds the current access token to an authorized request', async () => {
    const { client, request } = fixture()
    const session = fakeAuthorizedSession()

    await expect(
      client.authorizedRequest<{ value: string }>({ method: 'GET', path: '/v1/profile' }, session),
    ).resolves.toEqual({ value: 'ok' })

    expect(request.mock.calls[0]?.[0].headers).toEqual({ authorization: 'Bearer access-old' })
    expect(session.refreshOnce).not.toHaveBeenCalled()
  })

  it('does not allow a caller-provided authorization header to replace the session token', async () => {
    const { client, request } = fixture()
    const session = fakeAuthorizedSession()

    await client.authorizedRequest(
      {
        method: 'GET',
        path: '/v1/profile',
        headers: {
          Authorization: 'Bearer caller-controlled-upper',
          authorization: 'Bearer caller-controlled-lower',
          'x-request-purpose': 'profile',
        },
      },
      session,
    )

    expect(request.mock.calls[0]?.[0].headers).toEqual({
      authorization: 'Bearer access-old',
      'x-request-purpose': 'profile',
    })
  })

  it('refreshes after 401 TOKEN_EXPIRED and retries the same request exactly once', async () => {
    const { client, request } = fixture()
    const session = fakeAuthorizedSession()
    request.mockResolvedValueOnce(tokenExpired()).mockResolvedValueOnce(
      response(200, {
        data: { saved: true },
        meta,
      }),
    )

    await expect(
      client.authorizedRequest<{ saved: boolean }>(
        {
          method: 'PUT',
          path: '/v1/profile/nickname',
          data: { nickname: '小晴', source: 'wechatNicknameInput', confirmed: true },
        },
        session,
      ),
    ).resolves.toEqual({ saved: true })

    expect(session.refreshOnce).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
    const firstCall = request.mock.calls[0]?.[0]
    const secondCall = request.mock.calls[1]?.[0]
    expect(firstCall).toMatchObject({
      method: 'PUT',
      data: { nickname: '小晴', source: 'wechatNicknameInput', confirmed: true },
      headers: {
        authorization: 'Bearer access-old',
        'content-type': 'application/json',
      },
    })
    expect(secondCall).toEqual({
      ...firstCall,
      headers: {
        authorization: 'Bearer access-new',
        'content-type': 'application/json',
      },
    })
  })

  it('relies on SessionStore refreshOnce to single-flight concurrent 401 responses', async () => {
    const { client, request } = fixture()
    let accessToken = 'access-old'
    let refreshPromise:
      | Promise<{
          accessToken: string
          refreshToken: string
          user: PublicUser
        }>
      | undefined
    const refreshOperation = vi.fn(async () => {
      await Promise.resolve()
      accessToken = 'access-new'
      return { accessToken, refreshToken: 'refresh-new', user: publicUser }
    })
    const session: AuthorizedSession = {
      ensureSession: () =>
        Promise.resolve({
          accessToken,
          refreshToken: 'refresh-old',
          user: publicUser,
        }),
      refreshOnce: () => {
        refreshPromise ??= refreshOperation().finally(() => {
          refreshPromise = undefined
        })
        return refreshPromise
      },
    }
    request.mockImplementation((input) => {
      return Promise.resolve(
        input.headers?.['authorization'] === 'Bearer access-old'
          ? tokenExpired()
          : response(200, { data: { ok: true }, meta }),
      )
    })

    await Promise.all([
      client.authorizedRequest({ method: 'GET', path: '/v1/profile' }, session),
      client.authorizedRequest({ method: 'GET', path: '/v1/profile' }, session),
    ])

    expect(refreshOperation).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(4)
  })

  it('does not retry when the retry after refresh is still TOKEN_EXPIRED', async () => {
    const { client, request } = fixture()
    const session = fakeAuthorizedSession()
    request.mockResolvedValueOnce(tokenExpired()).mockResolvedValueOnce(tokenExpired())

    await expect(
      client.authorizedRequest({ method: 'GET', path: '/v1/profile' }, session),
    ).rejects.toMatchObject({ code: 'TOKEN_EXPIRED', statusCode: 401 })

    expect(session.refreshOnce).toHaveBeenCalledOnce()
    expect(request).toHaveBeenCalledTimes(2)
  })

  it.each([
    [401, 'UNAUTHORIZED'],
    [403, 'USER_DISABLED'],
    [422, 'NICKNAME_INVALID'],
    [429, 'RATE_LIMITED'],
  ] as const)('does not refresh or retry a business %s %s response', async (statusCode, code) => {
    const { client, request } = fixture()
    const session = fakeAuthorizedSession()
    request.mockResolvedValueOnce(
      response(statusCode, {
        error: { code, message: 'safe public message', retryable: false },
        meta,
      }),
    )

    await expect(
      client.authorizedRequest({ method: 'GET', path: '/v1/profile' }, session),
    ).rejects.toMatchObject({ statusCode, code })

    expect(session.refreshOnce).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not trust an unknown error code as a contract error', async () => {
    const { client, request } = fixture()
    const session = fakeAuthorizedSession()
    request.mockResolvedValueOnce(
      response(401, {
        error: {
          code: 'TOKEN_EXPIRED_BUT_NOT_A_REAL_CODE',
          message: 'untrusted response',
          retryable: true,
        },
        meta,
      }),
    )

    await expect(
      client.authorizedRequest({ method: 'GET', path: '/v1/profile' }, session),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR', statusCode: 502 })
    expect(session.refreshOnce).not.toHaveBeenCalled()
  })

  it('does not retry a transport failure', async () => {
    const { client, request } = fixture()
    const session = fakeAuthorizedSession()
    const offline = new Error('offline')
    request.mockRejectedValueOnce(offline)

    await expect(
      client.authorizedRequest({ method: 'GET', path: '/v1/profile' }, session),
    ).rejects.toBe(offline)
    expect(session.refreshOnce).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledOnce()
  })

  it('updates a nickname through the typed profile endpoint', async () => {
    const { client, request } = fixture()
    const session = fakeAuthorizedSession()
    const confirmed = {
      ...publicUser,
      nickname: '小晴',
      nicknameConfirmed: true,
      nicknameConfirmedAt: '2026-07-15T05:00:00.000Z',
    }
    request.mockResolvedValueOnce(response(200, { data: { user: confirmed }, meta }))

    await expect(
      client.updateNickname(
        { nickname: '小晴', source: 'wechatNicknameInput', confirmed: true },
        session,
      ),
    ).resolves.toEqual(confirmed)

    expect(request.mock.calls[0]?.[0]).toMatchObject({
      method: 'PUT',
      url: 'https://api.example.com/v1/profile/nickname',
      data: { nickname: '小晴', source: 'wechatNicknameInput', confirmed: true },
    })
  })

  it('strictly validates the public profile response', async () => {
    const { client, request } = fixture()
    const session = fakeAuthorizedSession()
    request.mockResolvedValueOnce(
      response(200, {
        data: { user: { ...publicUser, session_key: 'must-be-rejected' } },
        meta,
      }),
    )

    await expect(client.getProfile(session)).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      statusCode: 502,
    })
  })

  it('rejects non-origin base URLs and cross-origin request paths', () => {
    expect(
      () => new ApiClient({ ...fixtureRuntime(), baseUrl: 'https://api.example.com/v1' }),
    ).toThrow(/origin/i)
    expect(
      () => new ApiClient({ ...fixtureRuntime(), baseUrl: 'https://user@api.example.com' }),
    ).toThrow(/origin/i)

    const { client } = fixture()
    const session = fakeAuthorizedSession()
    expect(() =>
      client.authorizedRequest({ method: 'GET', path: '//evil.example/v1/profile' }, session),
    ).toThrow(/path/i)
  })
})

function fixtureRuntime(): { runtime: WechatRuntime } {
  return {
    runtime: {
      login: vi.fn<WechatRuntime['login']>(),
      request() {
        return Promise.reject(new Error('unused request'))
      },
      getStorage() {
        return undefined
      },
      setStorage: vi.fn<WechatRuntime['setStorage']>(),
      removeStorage: vi.fn<WechatRuntime['removeStorage']>(),
    },
  }
}

describe('createWechatRuntime', () => {
  it('promisifies login, request, and synchronous storage without changing public data', async () => {
    const storage = new Map<string, unknown>()
    const source = {
      login: vi.fn((options: { success(result: { code: string }): void }) => {
        options.success({ code: 'wx-code' })
      }),
      request: vi.fn(
        (options: {
          success(result: {
            statusCode: number
            data: unknown
            header: Record<string, string>
          }): void
        }) => {
          options.success({ statusCode: 200, data: { ok: true }, header: { trace: 'safe' } })
        },
      ),
      getStorageSync: vi.fn((key: string) => storage.get(key)),
      setStorageSync: vi.fn((key: string, value: unknown) => storage.set(key, value)),
      removeStorageSync: vi.fn((key: string) => storage.delete(key)),
    }
    const runtime = createWechatRuntime(source)

    await expect(runtime.login()).resolves.toEqual({ code: 'wx-code' })
    await expect(
      runtime.request({ method: 'GET', url: 'https://api.example.com/health/live' }),
    ).resolves.toEqual({ statusCode: 200, data: { ok: true }, headers: { trace: 'safe' } })
    runtime.setStorage('key', { public: true })
    expect(runtime.getStorage('key')).toEqual({ public: true })
    runtime.removeStorage('key')
    expect(runtime.getStorage('key')).toBeUndefined()
  })

  it('rejects failed WeChat callbacks with a sanitized runtime error', async () => {
    const source = {
      login: (options: { fail(reason: unknown): void }) => {
        options.fail({ errMsg: 'login:fail secret-runtime-details' })
      },
      request: (options: { fail(reason: unknown): void }) => {
        options.fail({ errMsg: 'request:fail https://secret.internal' })
      },
      getStorageSync: vi.fn(),
      setStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
    }
    const runtime = createWechatRuntime(source)

    await expect(runtime.login()).rejects.toThrow('WeChat login failed')
    await expect(
      runtime.request({ method: 'GET', url: 'https://api.example.com/health/live' }),
    ).rejects.toMatchObject({
      message: 'WeChat request failed',
      networkError: true,
    })
    await expect(runtime.login()).rejects.not.toThrow(/secret-runtime-details/)
  })

  it('rejects an empty wx.login code instead of sending it to the backend', async () => {
    const source = {
      login: (options: { success(result: { code: string }): void }) => {
        options.success({ code: '' })
      },
      request: vi.fn(),
      getStorageSync: vi.fn(),
      setStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
    }
    const runtime = createWechatRuntime(source)

    await expect(runtime.login()).rejects.toThrow('WeChat login failed')
  })

  it('rejects instead of leaving the request pending when an asynchronous decoder throws', async () => {
    let succeed:
      | ((result: { statusCode: number; data: unknown; header: Record<string, string> }) => void)
      | undefined
    const source = {
      login: vi.fn(),
      request: (options: {
        success(result: { statusCode: number; data: unknown; header: Record<string, string> }): void
      }) => {
        succeed = (result) => {
          options.success(result)
        }
      },
      getStorageSync: vi.fn(),
      setStorageSync: vi.fn(),
      removeStorageSync: vi.fn(),
    }
    const runtime = createWechatRuntime(source)
    const decoderFailure = new Error('decoder rejected malformed response')

    const pending = runtime.request(
      { method: 'GET', url: 'https://api.example.com/health/live' },
      () => {
        throw decoderFailure
      },
    )
    expect(() =>
      succeed?.({ statusCode: 200, data: { malformed: true }, header: {} }),
    ).not.toThrow()
    await expect(pending).rejects.toBe(decoderFailure)
  })
})
