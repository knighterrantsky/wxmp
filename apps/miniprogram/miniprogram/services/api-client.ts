import {
  ErrorEnvelopeSchema,
  ProfileResponseDataSchema,
  ResponseMetaSchema,
  TokenPairSchema,
  WechatLoginResponseDataSchema,
  matchesSchema,
  type ApiError,
  type ErrorCode,
  type NicknameRequest,
  type PublicUser,
  type RefreshTokenResponse,
  type WechatLoginResponse,
} from '@wx-upload/contracts'

import type { HttpRequest, WechatRuntime } from '../runtime/wechat-runtime.js'

export interface ApiSessionSnapshot {
  accessToken: string
  refreshToken: string
  user: PublicUser
}

export interface AuthorizedSession {
  ensureSession(): Promise<ApiSessionSnapshot>
  refreshOnce(staleAccessToken?: string): Promise<ApiSessionSnapshot>
}

export interface AuthenticationApi {
  login(code: string, deviceId: string): Promise<WechatLoginResponse['data']>
  refresh(refreshToken: string): Promise<RefreshTokenResponse['data']>
}

export interface ApiClientOptions {
  runtime: Pick<WechatRuntime, 'request'>
  baseUrl: string
}

export interface AuthorizedRequest<T = unknown> {
  method: HttpRequest['method']
  path: string
  headers?: Record<string, string>
  data?: unknown
  decode?: (value: unknown) => T
}

export class ApiClientError extends Error {
  readonly statusCode: number
  readonly code: ErrorCode
  readonly retryable: boolean
  readonly details: ApiError['details'] | undefined

  constructor(input: {
    statusCode: number
    code: ErrorCode
    message: string
    retryable: boolean
    details?: ApiError['details']
  }) {
    super(input.message)
    this.name = 'ApiClientError'
    this.statusCode = input.statusCode
    this.code = input.code
    this.retryable = input.retryable
    this.details = input.details
  }
}

export function isApiClientError(error: unknown): error is ApiClientError {
  return error instanceof ApiClientError
}

function normalizeOrigin(baseUrl: string): string {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new TypeError('API base URL must be an absolute origin')
  }

  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new TypeError('API base URL must contain only an HTTP(S) origin')
  }
  return url.origin
}

function assertRequestPath(path: string): void {
  let hasControlCharacter = false
  for (let index = 0; index < path.length; index += 1) {
    const codeUnit = path.charCodeAt(index)
    if (codeUnit <= 0x1f || codeUnit === 0x7f) {
      hasControlCharacter = true
      break
    }
  }
  if (!path.startsWith('/') || path.startsWith('//') || hasControlCharacter) {
    throw new TypeError('API request path must be a same-origin absolute path')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponseError(): ApiClientError {
  return new ApiClientError({
    statusCode: 502,
    code: 'INTERNAL_ERROR',
    message: '服务响应格式无效',
    retryable: true,
  })
}

function decodeError(statusCode: number, body: unknown): ApiClientError {
  if (!matchesSchema(ErrorEnvelopeSchema, body)) return invalidResponseError()
  const { code, message, retryable, details } = body.error
  return new ApiClientError({
    statusCode,
    code,
    message,
    retryable,
    ...(details ? { details } : {}),
  })
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

function decodeSuccess<T>(body: unknown, decode?: (value: unknown) => T): T {
  if (
    !isRecord(body) ||
    !hasOnlyKeys(body, ['data', 'meta']) ||
    !Object.hasOwn(body, 'data') ||
    !matchesSchema(ResponseMetaSchema, body['meta'])
  ) {
    throw invalidResponseError()
  }
  try {
    return decode === undefined ? (body['data'] as T) : decode(body['data'])
  } catch (error) {
    if (error instanceof ApiClientError) throw error
    throw invalidResponseError()
  }
}

function decodeLoginData(value: unknown): WechatLoginResponse['data'] {
  if (!matchesSchema(WechatLoginResponseDataSchema, value)) throw invalidResponseError()
  return value
}

function decodeTokenPair(value: unknown): RefreshTokenResponse['data'] {
  if (!matchesSchema(TokenPairSchema, value)) throw invalidResponseError()
  return value
}

function decodeProfileData(value: unknown): { user: PublicUser } {
  if (!matchesSchema(ProfileResponseDataSchema, value)) throw invalidResponseError()
  return value
}

function jsonHeaders(data: unknown, headers?: Record<string, string>): Record<string, string> {
  return {
    ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  }
}

function authorizedHeaders(
  headers: Record<string, string> | undefined,
  accessToken: string,
): Record<string, string> {
  const sanitized = Object.fromEntries(
    Object.entries(headers ?? {}).filter(([name]) => name.toLowerCase() !== 'authorization'),
  )
  return { ...sanitized, authorization: `Bearer ${accessToken}` }
}

export class ApiClient implements AuthenticationApi {
  readonly #runtime: Pick<WechatRuntime, 'request'>
  readonly #baseUrl: string

  constructor(options: ApiClientOptions) {
    this.#runtime = options.runtime
    this.#baseUrl = normalizeOrigin(options.baseUrl)
  }

  login(code: string, deviceId: string): Promise<WechatLoginResponse['data']> {
    return this.#request({
      method: 'POST',
      path: '/v1/auth/wechat-login',
      data: { code, deviceId },
      decode: decodeLoginData,
    })
  }

  refresh(refreshToken: string): Promise<RefreshTokenResponse['data']> {
    return this.#request({
      method: 'POST',
      path: '/v1/auth/refresh',
      data: { refreshToken },
      decode: decodeTokenPair,
    })
  }

  authorizedRequest<T>(request: AuthorizedRequest<T>, session: AuthorizedSession): Promise<T> {
    assertRequestPath(request.path)
    return this.#authorizedRequest<T>(request, session)
  }

  getProfile(session: AuthorizedSession): Promise<PublicUser> {
    return this.authorizedRequest<{ user: PublicUser }>(
      { method: 'GET', path: '/v1/profile', decode: decodeProfileData },
      session,
    ).then(({ user }) => user)
  }

  updateNickname(request: NicknameRequest, session: AuthorizedSession): Promise<PublicUser> {
    return this.authorizedRequest<{ user: PublicUser }>(
      {
        method: 'PUT',
        path: '/v1/profile/nickname',
        data: request,
        decode: decodeProfileData,
      },
      session,
    ).then(({ user }) => user)
  }

  async #authorizedRequest<T>(
    request: AuthorizedRequest<T>,
    session: AuthorizedSession,
  ): Promise<T> {
    const current = await session.ensureSession()
    try {
      return await this.#request<T>({
        ...request,
        headers: authorizedHeaders(request.headers, current.accessToken),
      })
    } catch (error) {
      if (!isApiClientError(error) || error.statusCode !== 401 || error.code !== 'TOKEN_EXPIRED') {
        throw error
      }
    }

    const refreshed = await session.refreshOnce(current.accessToken)
    return this.#request<T>({
      ...request,
      headers: authorizedHeaders(request.headers, refreshed.accessToken),
    })
  }

  async #request<T>(request: AuthorizedRequest<T>): Promise<T> {
    assertRequestPath(request.path)
    const response = await this.#runtime.request<unknown>({
      method: request.method,
      url: `${this.#baseUrl}${request.path}`,
      headers: jsonHeaders(request.data, request.headers),
      ...(request.data === undefined ? {} : { data: request.data }),
    })
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw decodeError(response.statusCode, response.data)
    }
    return decodeSuccess(response.data, request.decode)
  }
}
