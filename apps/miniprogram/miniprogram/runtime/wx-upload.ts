import {
  ERROR_CODES,
  MAX_PART_COUNT,
  PART_SIZE_BYTES,
  UUID_V7_PATTERN,
  type ErrorCode,
  type UploadPartResponse,
} from '@wx-upload/contracts'

import { ApiClientError, isApiClientError, type AuthorizedSession } from '../services/api-client.js'
import { normalizeHttpOrigin } from './http-origin.js'

const MAX_RESPONSE_CHARACTERS = 65_536
export const WECHAT_UPLOAD_TIMEOUT_MS = 180_000
const SHA256_PATTERN = /^[0-9a-f]{64}$/u
const UPLOAD_ID_PATTERN = new RegExp(UUID_V7_PATTERN, 'u')
const ERROR_CODE_SET = new Set<string>(ERROR_CODES)

export interface UploadProgressEvent {
  progress: number
  totalBytesSent: number
  totalBytesExpectedToSend: number
}

export interface UploadFileRequest {
  url: string
  filePath: string
  name: 'chunk'
  headers: Record<string, string>
  formData: { chunkSizeBytes: string }
  timeout?: number | undefined
  onProgress?: ((event: UploadProgressEvent) => void) | undefined
}

export interface UploadFileResponse {
  statusCode: number
  data: string
  headers: Record<string, string>
}

export interface WechatUploadRuntime {
  uploadFile(request: UploadFileRequest): Promise<UploadFileResponse>
}

export interface WxUploadTask {
  onProgressUpdate(callback: (event: UploadProgressEvent) => void): void
}

export interface WxUploadSource {
  uploadFile(options: {
    url: string
    filePath: string
    name: 'chunk'
    header: Record<string, string>
    formData: { chunkSizeBytes: string }
    timeout: number
    success(result: {
      statusCode: number
      data: string
      header?: Record<string, string | readonly string[]> | undefined
    }): void
    fail(reason: unknown): void
  }): WxUploadTask
}

export class WechatUploadNetworkError extends Error {
  readonly networkError = true

  constructor() {
    super('WeChat upload failed')
    this.name = 'WechatUploadNetworkError'
  }
}

function normalizeHeaders(
  headers: Record<string, string | readonly string[]> | undefined,
): Record<string, string> {
  if (headers === undefined) return {}
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value.toString()]),
  )
}

export function uploadFileWithWechatRuntime(
  source: WxUploadSource,
  request: UploadFileRequest,
): Promise<UploadFileResponse> {
  return new Promise((resolve, reject) => {
    try {
      const task = source.uploadFile({
        url: request.url,
        filePath: request.filePath,
        name: 'chunk',
        header: request.headers,
        formData: request.formData,
        timeout: request.timeout ?? WECHAT_UPLOAD_TIMEOUT_MS,
        success(result) {
          try {
            resolve({
              statusCode: result.statusCode,
              data: result.data,
              headers: normalizeHeaders(result.header),
            })
          } catch {
            reject(new WechatUploadNetworkError())
          }
        },
        fail() {
          reject(new WechatUploadNetworkError())
        },
      })
      if (request.onProgress !== undefined) {
        task.onProgressUpdate((event) => {
          request.onProgress?.({
            progress: event.progress,
            totalBytesSent: event.totalBytesSent,
            totalBytesExpectedToSend: event.totalBytesExpectedToSend,
          })
        })
      }
    } catch {
      reject(new WechatUploadNetworkError())
    }
  })
}

export interface UploadPartRequest {
  uploadId: string
  partNumber: number
  sha256: string
  chunkSizeBytes: number
  tempPath: string
  onProgress?: ((event: UploadProgressEvent) => void) | undefined
}

interface UploadPartSnapshot extends UploadPartRequest {
  onProgress: ((event: UploadProgressEvent) => void) | undefined
}

export interface AuthorizedUploadTransportOptions {
  runtime: WechatUploadRuntime
  session: AuthorizedSession
  baseUrl: string
}

function normalizeOrigin(baseUrl: string): string {
  return normalizeHttpOrigin(baseUrl, 'Upload API base URL')
}

function snapshotPart(input: UploadPartRequest): UploadPartSnapshot {
  if (!UPLOAD_ID_PATTERN.test(input.uploadId)) throw new TypeError('uploadId is invalid')
  if (
    !Number.isInteger(input.partNumber) ||
    input.partNumber < 1 ||
    input.partNumber > MAX_PART_COUNT
  ) {
    throw new TypeError('partNumber is invalid')
  }
  if (!SHA256_PATTERN.test(input.sha256)) throw new TypeError('chunk SHA-256 is invalid')
  if (
    !Number.isInteger(input.chunkSizeBytes) ||
    input.chunkSizeBytes < 1 ||
    input.chunkSizeBytes > PART_SIZE_BYTES
  ) {
    throw new TypeError('chunk size is invalid')
  }
  if (
    input.tempPath.length < 1 ||
    input.tempPath.length > 4096 ||
    input.tempPath.includes('\u0000')
  ) {
    throw new TypeError('temporary path is invalid')
  }
  return {
    uploadId: input.uploadId,
    partNumber: input.partNumber,
    sha256: input.sha256,
    chunkSizeBytes: input.chunkSizeBytes,
    tempPath: input.tempPath,
    onProgress: input.onProgress,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed)
  return Object.keys(value).every((key) => allowedKeys.has(key))
}

function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ERROR_CODE_SET.has(value)
}

function protocolError(): ApiClientError {
  return new ApiClientError({
    statusCode: 502,
    code: 'INTERNAL_ERROR',
    message: '上传服务响应无效',
    retryable: true,
  })
}

function parseJson(data: string): unknown {
  if (data.length < 1 || data.length > MAX_RESPONSE_CHARACTERS) throw protocolError()
  try {
    return JSON.parse(data) as unknown
  } catch {
    throw protocolError()
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function hasValidMeta(envelope: Record<string, unknown>): boolean {
  const meta = envelope['meta']
  return (
    isRecord(meta) &&
    hasOnlyKeys(meta, ['requestId', 'serverTime']) &&
    typeof meta['requestId'] === 'string' &&
    typeof meta['serverTime'] === 'string'
  )
}

function hasValidProgress(value: unknown): boolean {
  if (!isRecord(value)) return false
  return (
    hasOnlyKeys(value, [
      'confirmedBytes',
      'totalBytes',
      'uploadedParts',
      'totalParts',
      'percent',
    ]) &&
    Number.isInteger(value['confirmedBytes']) &&
    Number.isInteger(value['totalBytes']) &&
    Number.isInteger(value['uploadedParts']) &&
    Number.isInteger(value['totalParts']) &&
    isFiniteNumber(value['percent']) &&
    (value['confirmedBytes'] as number) >= 0 &&
    (value['totalBytes'] as number) >= 1 &&
    (value['uploadedParts'] as number) >= 0 &&
    (value['totalParts'] as number) >= 1 &&
    value['percent'] >= 0 &&
    value['percent'] <= 100
  )
}

function hasValidPart(value: unknown, expected: UploadPartSnapshot): boolean {
  if (!isRecord(value)) return false
  return (
    hasOnlyKeys(value, ['partNumber', 'sizeBytes', 'sha256', 'status', 'uploadedAt']) &&
    value['partNumber'] === expected.partNumber &&
    value['sizeBytes'] === expected.chunkSizeBytes &&
    value['sha256'] === expected.sha256 &&
    value['status'] === 'uploaded' &&
    typeof value['uploadedAt'] === 'string'
  )
}

function parseSuccess(envelope: unknown, expected: UploadPartSnapshot): UploadPartResponse['data'] {
  if (!isRecord(envelope) || !hasOnlyKeys(envelope, ['data', 'meta']) || !hasValidMeta(envelope)) {
    throw protocolError()
  }
  const data = envelope['data']
  if (
    !isRecord(data) ||
    !hasOnlyKeys(data, ['part', 'progress', 'replayed']) ||
    !hasValidPart(data['part'], expected) ||
    !hasValidProgress(data['progress']) ||
    typeof data['replayed'] !== 'boolean'
  ) {
    throw protocolError()
  }
  return data as UploadPartResponse['data']
}

function parseFailure(statusCode: number, envelope: unknown): ApiClientError {
  if (!isRecord(envelope) || !hasOnlyKeys(envelope, ['error', 'meta']) || !hasValidMeta(envelope)) {
    throw protocolError()
  }
  const error = envelope['error']
  if (
    !isRecord(error) ||
    !hasOnlyKeys(error, ['code', 'message', 'retryable', 'details']) ||
    !isErrorCode(error['code']) ||
    typeof error['message'] !== 'string' ||
    typeof error['retryable'] !== 'boolean'
  ) {
    throw protocolError()
  }
  return new ApiClientError({
    statusCode,
    code: error['code'],
    message: error['code'] === 'TOKEN_EXPIRED' ? '登录状态已过期' : '分片上传失败',
    retryable: error['retryable'],
  })
}

function parseUploadResponse(
  response: UploadFileResponse,
  expected: UploadPartSnapshot,
): UploadPartResponse['data'] {
  const envelope = parseJson(response.data)
  if (response.statusCode === 200) return parseSuccess(envelope, expected)
  throw parseFailure(response.statusCode, envelope)
}

export class AuthorizedUploadTransport {
  readonly #runtime: WechatUploadRuntime
  readonly #session: AuthorizedSession
  readonly #baseUrl: string

  constructor(options: AuthorizedUploadTransportOptions) {
    this.#runtime = options.runtime
    this.#session = options.session
    this.#baseUrl = normalizeOrigin(options.baseUrl)
  }

  async uploadPart(input: UploadPartRequest): Promise<UploadPartResponse['data']> {
    const part = snapshotPart(input)
    const current = await this.#session.ensureSession()
    try {
      return await this.#upload(part, current.accessToken)
    } catch (error) {
      if (!isApiClientError(error) || error.statusCode !== 401 || error.code !== 'TOKEN_EXPIRED') {
        throw error
      }
    }

    const refreshed = await this.#session.refreshOnce(current.accessToken)
    return this.#upload(part, refreshed.accessToken)
  }

  async #upload(
    part: UploadPartSnapshot,
    accessToken: string,
  ): Promise<UploadPartResponse['data']> {
    const response = await this.#runtime.uploadFile({
      url: `${this.#baseUrl}/v1/uploads/${encodeURIComponent(part.uploadId)}/parts/${String(part.partNumber)}`,
      filePath: part.tempPath,
      name: 'chunk',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'X-Chunk-SHA256': part.sha256,
      },
      formData: { chunkSizeBytes: String(part.chunkSizeBytes) },
      timeout: WECHAT_UPLOAD_TIMEOUT_MS,
      onProgress: part.onProgress,
    })
    return parseUploadResponse(response, part)
  }
}
