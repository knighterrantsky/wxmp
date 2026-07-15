import {
  AbortUploadResponseDataSchema,
  CompleteUploadResponseDataSchema,
  ErrorEnvelopeSchema,
  InitializeUploadResponseDataSchema,
  ListResponseMetaSchema,
  ProfileResponseDataSchema,
  ResponseMetaSchema,
  TokenPairSchema,
  UUID_V7_PATTERN,
  WechatLoginResponseDataSchema,
  UploadDetailResponseDataSchema,
  UploadHistoryQuerySchema,
  UploadHistoryResponseDataSchema,
  matchesSchema,
  type AbortUploadRequest,
  type AbortUploadResponse,
  type ApiError,
  type CompleteUploadResponse,
  type ErrorCode,
  type InitializeUploadRequest,
  type InitializeUploadResponse,
  type NicknameRequest,
  type Pagination,
  type PublicUser,
  type RefreshTokenResponse,
  type UploadDetailResponse,
  type UploadHistoryQuery,
  type UploadHistoryResponse,
  type WechatLoginResponse,
} from '@wx-upload/contracts'

import type { HttpRequest, WechatRuntime } from '../runtime/wechat-runtime.js'
import { normalizeHttpOrigin } from '../runtime/http-origin.js'

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

interface InternalAuthorizedRequest<T = unknown> extends AuthorizedRequest<T> {
  decodeEnvelope?: (value: unknown) => T
}

export interface UploadHistoryPage {
  readonly items: UploadHistoryResponse['data']['items']
  readonly pagination: Pagination
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
  return normalizeHttpOrigin(baseUrl, 'API base URL')
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

function decodeEnvelopeSuccess<T>(body: unknown, decode: (value: unknown) => T): T {
  try {
    return decode(body)
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

function decodeInitializeUploadData(value: unknown): InitializeUploadResponse['data'] {
  if (!matchesSchema(InitializeUploadResponseDataSchema, value)) throw invalidResponseError()
  return value
}

function decodeUploadDetailData(value: unknown, uploadId: string): UploadDetailResponse['data'] {
  if (!matchesSchema(UploadDetailResponseDataSchema, value) || value.upload.id !== uploadId) {
    throw invalidResponseError()
  }
  return value
}

function decodeCompleteUploadData(
  value: unknown,
  uploadId: string,
): CompleteUploadResponse['data'] {
  if (!matchesSchema(CompleteUploadResponseDataSchema, value) || value.upload.id !== uploadId) {
    throw invalidResponseError()
  }
  return value
}

function decodeAbortUploadData(value: unknown, uploadId: string): AbortUploadResponse['data'] {
  if (!matchesSchema(AbortUploadResponseDataSchema, value) || value.upload.id !== uploadId) {
    throw invalidResponseError()
  }
  return value
}

function decodeUploadHistoryEnvelope(value: unknown): UploadHistoryPage {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['data', 'meta']) ||
    !matchesSchema(UploadHistoryResponseDataSchema, value['data']) ||
    !matchesSchema(ListResponseMetaSchema, value['meta'])
  ) {
    throw invalidResponseError()
  }
  return {
    items: value['data'].items,
    pagination: value['meta'].pagination,
  }
}

const UUID_V7 = new RegExp(UUID_V7_PATTERN, 'u')

function assertUuidV7(value: string, name: 'uploadId' | 'idempotency key'): void {
  if (!UUID_V7.test(value)) throw new TypeError(`${name} must be a UUIDv7`)
}

function uploadHistoryPath(query: UploadHistoryQuery): string {
  if (!matchesSchema(UploadHistoryQuerySchema, query)) {
    throw new TypeError('Upload history query is invalid')
  }

  const parameters: string[] = []
  if (query.limit !== undefined) parameters.push(`limit=${String(query.limit)}`)
  if (query.status !== undefined) parameters.push(`status=${encodeURIComponent(query.status)}`)
  if (query.cursor !== undefined) {
    try {
      parameters.push(`cursor=${encodeURIComponent(query.cursor)}`)
    } catch {
      throw new TypeError('Upload history query is invalid')
    }
  }
  return parameters.length === 0 ? '/v1/uploads' : `/v1/uploads?${parameters.join('&')}`
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

  initializeUpload(
    request: InitializeUploadRequest,
    idempotencyKey: string,
    session: AuthorizedSession,
  ): Promise<InitializeUploadResponse['data']> {
    assertUuidV7(idempotencyKey, 'idempotency key')
    return this.authorizedRequest<InitializeUploadResponse['data']>(
      {
        method: 'POST',
        path: '/v1/uploads',
        headers: { 'Idempotency-Key': idempotencyKey },
        data: request,
        decode: decodeInitializeUploadData,
      },
      session,
    )
  }

  getUpload(uploadId: string, session: AuthorizedSession): Promise<UploadDetailResponse['data']> {
    assertUuidV7(uploadId, 'uploadId')
    return this.authorizedRequest<UploadDetailResponse['data']>(
      {
        method: 'GET',
        path: `/v1/uploads/${uploadId}`,
        decode: (value) => decodeUploadDetailData(value, uploadId),
      },
      session,
    )
  }

  getUploadHistory(
    query: UploadHistoryQuery,
    session: AuthorizedSession,
  ): Promise<UploadHistoryPage> {
    return this.#authorizedRequest<UploadHistoryPage>(
      {
        method: 'GET',
        path: uploadHistoryPath(query),
        decodeEnvelope: decodeUploadHistoryEnvelope,
      },
      session,
    )
  }

  completeUpload(
    uploadId: string,
    idempotencyKey: string,
    session: AuthorizedSession,
  ): Promise<CompleteUploadResponse['data']> {
    assertUuidV7(uploadId, 'uploadId')
    assertUuidV7(idempotencyKey, 'idempotency key')
    return this.authorizedRequest<CompleteUploadResponse['data']>(
      {
        method: 'POST',
        path: `/v1/uploads/${uploadId}/complete`,
        headers: { 'Idempotency-Key': idempotencyKey },
        data: {},
        decode: (value) => decodeCompleteUploadData(value, uploadId),
      },
      session,
    )
  }

  abortUpload(
    uploadId: string,
    reason: AbortUploadRequest['reason'],
    idempotencyKey: string,
    session: AuthorizedSession,
  ): Promise<AbortUploadResponse['data']> {
    assertUuidV7(uploadId, 'uploadId')
    assertUuidV7(idempotencyKey, 'idempotency key')
    return this.authorizedRequest<AbortUploadResponse['data']>(
      {
        method: 'POST',
        path: `/v1/uploads/${uploadId}/abort`,
        headers: { 'Idempotency-Key': idempotencyKey },
        data: { reason },
        decode: (value) => decodeAbortUploadData(value, uploadId),
      },
      session,
    )
  }

  async #authorizedRequest<T>(
    request: InternalAuthorizedRequest<T>,
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

  async #request<T>(request: InternalAuthorizedRequest<T>): Promise<T> {
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
    return request.decodeEnvelope === undefined
      ? decodeSuccess(response.data, request.decode)
      : decodeEnvelopeSuccess(response.data, request.decodeEnvelope)
  }
}
