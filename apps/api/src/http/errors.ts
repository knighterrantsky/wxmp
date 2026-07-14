import type { ErrorCode } from '@wx-upload/contracts'
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify'

import { requestClock } from './request-context.js'

export const PUBLIC_ERROR_MESSAGES = {
  INVALID_JSON: 'JSON 请求格式无效',
  PAYLOAD_TOO_LARGE: '请求内容超过允许大小',
  ROUTE_NOT_FOUND: '请求的接口不存在',
  INVALID_CURSOR: '游标无效或查询条件已改变',
  IDEMPOTENCY_KEY_REQUIRED: '缺少幂等 Key',
  UNAUTHORIZED: '请先登录',
  TOKEN_EXPIRED: '登录凭据已过期',
  REFRESH_TOKEN_INVALID: '刷新凭据无效或已过期',
  REFRESH_TOKEN_REUSED: '检测到刷新凭据重复使用',
  WECHAT_CODE_INVALID: '微信登录凭据无效或已使用',
  USER_DISABLED: '用户已被禁用',
  UPLOAD_NOT_FOUND: '上传记录不存在',
  IDEMPOTENCY_KEY_REUSED: '幂等 Key 已用于其他请求',
  IDEMPOTENCY_IN_PROGRESS: '原请求仍在处理中',
  FIRST_PART_REQUIRED: '请先上传并验证首个分片',
  PART_UPLOAD_IN_PROGRESS: '当前分片正在上传',
  PARTS_INCOMPLETE: '上传分片不完整',
  UPLOAD_NOT_WRITABLE: '当前上传状态不允许写入',
  UPLOAD_NOT_ABORTABLE: '当前上传状态不允许取消',
  UPLOAD_BUSY: '上传任务正忙，请稍后重试',
  UPLOAD_EXPIRED: '上传会话已过期',
  FILE_TOO_LARGE: '文件超过 200 MiB 上限',
  PART_TOO_LARGE: '上传分片超过允许大小',
  FILE_TYPE_NOT_ALLOWED: '不支持该文件类型',
  MIME_MISMATCH: '文件类型与内容不匹配',
  VALIDATION_ERROR: '请求参数无效',
  FILE_TOO_SMALL: '文件过小，无法验证格式',
  NICKNAME_INVALID: '微信昵称不符合要求',
  PART_NUMBER_INVALID: '分片编号无效',
  PART_LENGTH_MISMATCH: '分片长度与上传计划不一致',
  PART_CHECKSUM_MISMATCH: '分片校验失败',
  NICKNAME_REQUIRED: '请先确认微信昵称',
  UPLOAD_SESSION_LIMIT: '未完成的上传任务过多',
  UPLOAD_CONCURRENCY_LIMIT: '同时上传的分片过多',
  RATE_LIMITED: '请求过于频繁，请稍后重试',
  INTERNAL_ERROR: '服务器暂时无法处理请求',
  WECHAT_SERVICE_UNAVAILABLE: '微信服务暂时不可用',
  STORAGE_UNAVAILABLE: '存储服务暂时不可用',
  STORAGE_OBJECT_SIZE_MISMATCH: '存储对象大小与预期不一致',
  UPSTREAM_TIMEOUT: '上游服务请求超时',
} as const satisfies Readonly<Record<ErrorCode, string>>

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly statusCode: number
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(options: {
    code: ErrorCode
    message: string
    statusCode: number
    retryable?: boolean
    details?: Record<string, unknown>
  }) {
    super(PUBLIC_ERROR_MESSAGES[options.code])
    this.name = 'ApiError'
    this.code = options.code
    this.statusCode = options.statusCode
    this.retryable = options.retryable ?? false
    if (options.details !== undefined) this.details = options.details
  }
}

interface SafeError {
  code: ErrorCode
  message: string
  retryable: boolean
  statusCode: number
  details?: Record<string, unknown>
}

function safeDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (details === undefined) return undefined
  const keys = Object.keys(details).sort()
  if (keys.join(',') === 'actualSizeBytes,maxSizeBytes') {
    const actual = details['actualSizeBytes']
    const maximum = details['maxSizeBytes']
    if (
      Number.isSafeInteger(actual) &&
      Number(actual) >= 0 &&
      Number.isSafeInteger(maximum) &&
      Number(maximum) >= 0
    ) {
      return { maxSizeBytes: maximum, actualSizeBytes: actual }
    }
  }
  if (keys.join(',') === 'missingPartNumbers') {
    const missing = details['missingPartNumbers']
    if (
      Array.isArray(missing) &&
      missing.length >= 1 &&
      missing.length <= 25 &&
      missing.every((part) => Number.isInteger(part) && part >= 1 && part <= 25)
    ) {
      const parts: unknown[] = missing
      return { missingPartNumbers: [...parts] }
    }
  }
  return undefined
}

function classifyError(error: FastifyError | Error): SafeError {
  if (error instanceof ApiError) {
    const details = safeDetails(error.details)
    return {
      code: error.code,
      message: PUBLIC_ERROR_MESSAGES[error.code],
      retryable: error.retryable,
      statusCode: error.statusCode,
      ...(details === undefined ? {} : { details }),
    }
  }

  const fastifyError = error as FastifyError
  if (fastifyError.statusCode === 429 || fastifyError.code === 'FST_ERR_RATE_LIMIT') {
    return {
      code: 'RATE_LIMITED',
      message: PUBLIC_ERROR_MESSAGES.RATE_LIMITED,
      retryable: true,
      statusCode: 429,
    }
  }
  if (fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return {
      code: 'PAYLOAD_TOO_LARGE',
      message: PUBLIC_ERROR_MESSAGES.PAYLOAD_TOO_LARGE,
      retryable: false,
      statusCode: 413,
    }
  }
  if (fastifyError.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return {
      code: 'INVALID_JSON',
      message: PUBLIC_ERROR_MESSAGES.INVALID_JSON,
      retryable: false,
      statusCode: 400,
    }
  }
  if (fastifyError.validation !== undefined) {
    return {
      code: 'VALIDATION_ERROR',
      message: PUBLIC_ERROR_MESSAGES.VALIDATION_ERROR,
      retryable: false,
      statusCode: 422,
    }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: PUBLIC_ERROR_MESSAGES.INTERNAL_ERROR,
    retryable: true,
    statusCode: 500,
  }
}

export function toApiErrorEnvelope(
  error: FastifyError | Error,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply {
  const safe = classifyError(error)
  const publicError = {
    code: safe.code,
    message: safe.message,
    retryable: safe.retryable,
    ...(safe.details === undefined ? {} : { details: safe.details }),
  }
  return reply.code(safe.statusCode).send({
    error: publicError,
    meta: {
      requestId: request.id,
      serverTime: requestClock(request).now().toISOString(),
    },
  })
}
