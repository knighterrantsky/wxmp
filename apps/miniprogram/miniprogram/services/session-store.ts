import type { PublicUser, RefreshTokenResponse, WechatLoginResponse } from '@wx-upload/contracts'

import {
  ApiClientError,
  type ApiSessionSnapshot,
  type AuthenticationApi,
  type AuthorizedSession,
} from './api-client.js'
import type { WechatRuntime } from '../runtime/wechat-runtime.js'

export const API_SESSION_STORAGE_KEY = 'apiSession'

export type ApiSession = ApiSessionSnapshot

export interface SessionStoreOptions {
  runtime: Pick<WechatRuntime, 'login' | 'getStorage' | 'setStorage' | 'removeStorage'>
  api: AuthenticationApi
  deviceId: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

function sanitizePublicUser(value: unknown): PublicUser {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'id',
      'nickname',
      'nicknameConfirmed',
      'nicknameConfirmedAt',
      'createdAt',
      'updatedAt',
    ])
  ) {
    throw new TypeError('Public user is invalid')
  }
  const id = value['id']
  const nickname = value['nickname']
  const nicknameConfirmed = value['nicknameConfirmed']
  const createdAt = value['createdAt']
  const nicknameConfirmedAt = value['nicknameConfirmedAt']
  const updatedAt = value['updatedAt']
  if (
    typeof id !== 'string' ||
    (typeof nickname !== 'string' && nickname !== null) ||
    typeof nicknameConfirmed !== 'boolean' ||
    typeof createdAt !== 'string' ||
    (nicknameConfirmedAt !== undefined &&
      nicknameConfirmedAt !== null &&
      typeof nicknameConfirmedAt !== 'string') ||
    (updatedAt !== undefined && typeof updatedAt !== 'string')
  ) {
    throw new TypeError('Public user is invalid')
  }

  return {
    id,
    nickname,
    nicknameConfirmed,
    createdAt,
    ...(nicknameConfirmedAt === undefined ? {} : { nicknameConfirmedAt }),
    ...(updatedAt === undefined ? {} : { updatedAt }),
  }
}

function readStoredSession(value: unknown): ApiSession | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ['accessToken', 'refreshToken', 'user'])) {
    return undefined
  }
  const accessToken = value['accessToken']
  const refreshToken = value['refreshToken']
  if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined
  if (typeof refreshToken !== 'string' || refreshToken.length === 0) return undefined
  try {
    return { accessToken, refreshToken, user: sanitizePublicUser(value['user']) }
  } catch {
    return undefined
  }
}

function loginSession(data: WechatLoginResponse['data']): ApiSession {
  if (
    typeof data.accessToken !== 'string' ||
    data.accessToken.length === 0 ||
    typeof data.refreshToken !== 'string' ||
    data.refreshToken.length === 0
  ) {
    throw new TypeError('API login response is invalid')
  }
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    user: sanitizePublicUser(data.user),
  }
}

function rotatedSession(current: ApiSession, data: RefreshTokenResponse['data']): ApiSession {
  if (
    typeof data.accessToken !== 'string' ||
    data.accessToken.length === 0 ||
    typeof data.refreshToken !== 'string' ||
    data.refreshToken.length === 0
  ) {
    throw new TypeError('API refresh response is invalid')
  }
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    user: current.user,
  }
}

function assertDeviceId(deviceId: string): void {
  if (deviceId.length < 1 || deviceId.length > 128 || deviceId.includes('\u0000')) {
    throw new TypeError('deviceId is invalid')
  }
}

function shouldStartFreshLogin(error: unknown): boolean {
  if (!(error instanceof ApiClientError)) return true
  return error.code === 'REFRESH_TOKEN_INVALID' || error.code === 'REFRESH_TOKEN_REUSED'
}

export class SessionStore implements AuthorizedSession {
  readonly #runtime: SessionStoreOptions['runtime']
  readonly #api: AuthenticationApi
  readonly #deviceId: string
  #current: ApiSession | undefined
  #storageRead = false
  #loginPromise: Promise<ApiSession> | undefined
  #refreshPromise: Promise<ApiSession> | undefined

  constructor(options: SessionStoreOptions) {
    assertDeviceId(options.deviceId)
    this.#runtime = options.runtime
    this.#api = options.api
    this.#deviceId = options.deviceId
  }

  ensureSession(): Promise<ApiSession> {
    if (this.#current !== undefined) return Promise.resolve(this.#current)
    if (!this.#storageRead) {
      this.#storageRead = true
      const stored = this.#runtime.getStorage<unknown>(API_SESSION_STORAGE_KEY)
      if (stored !== undefined) {
        const session = readStoredSession(stored)
        if (session !== undefined) {
          this.#current = session
          return Promise.resolve(session)
        }
        this.#runtime.removeStorage(API_SESSION_STORAGE_KEY)
      }
    }
    return this.#freshLoginOnce()
  }

  async refreshOnce(staleAccessToken?: string): Promise<ApiSession> {
    const current = await this.ensureSession()
    if (staleAccessToken !== undefined && current.accessToken !== staleAccessToken) return current
    if (this.#refreshPromise !== undefined) return this.#refreshPromise

    const refresh = this.#rotateOrRecover(current)
    this.#refreshPromise = refresh
    try {
      return await refresh
    } finally {
      if (this.#refreshPromise === refresh) this.#refreshPromise = undefined
    }
  }

  async replaceUser(user: PublicUser): Promise<ApiSession> {
    await this.ensureSession()
    const inFlightRefresh = this.#refreshPromise
    if (inFlightRefresh !== undefined) await inFlightRefresh
    const current = await this.ensureSession()
    const next = { ...current, user: sanitizePublicUser(user) }
    this.#save(next)
    return next
  }

  clear(): void {
    this.#current = undefined
    this.#storageRead = true
    this.#runtime.removeStorage(API_SESSION_STORAGE_KEY)
  }

  async #rotateOrRecover(current: ApiSession): Promise<ApiSession> {
    try {
      const tokens = await this.#api.refresh(current.refreshToken)
      const liveUser = this.#current?.user ?? current.user
      const next = rotatedSession({ ...current, user: liveUser }, tokens)
      this.#save(next)
      return next
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'USER_DISABLED') {
        this.clear()
        throw error
      }
      if (!shouldStartFreshLogin(error)) throw error
      this.clear()
      return this.#freshLoginOnce()
    }
  }

  #freshLoginOnce(): Promise<ApiSession> {
    if (this.#loginPromise !== undefined) return this.#loginPromise
    const login = this.#freshLogin()
    this.#loginPromise = login
    void login
      .finally(() => {
        if (this.#loginPromise === login) this.#loginPromise = undefined
      })
      .catch(() => undefined)
    return login
  }

  async #freshLogin(): Promise<ApiSession> {
    const { code } = await this.#runtime.login()
    const result = await this.#api.login(code, this.#deviceId)
    const session = loginSession(result)
    this.#save(session)
    return session
  }

  #save(session: ApiSession): void {
    this.#current = session
    this.#runtime.setStorage(API_SESSION_STORAGE_KEY, session)
  }
}
