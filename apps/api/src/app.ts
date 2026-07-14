import { UUID_V7_PATTERN } from '@wx-upload/contracts'
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify'
import type { Pool } from 'pg'

import { PostgresAuthRepository, type AuthRepository } from './auth/auth-repository.js'
import { registerAuthRoutes } from './auth/auth-routes.js'
import { AuthService } from './auth/auth-service.js'
import type { TokenService } from './auth/token-service.js'
import type { WechatGateway } from './auth/wechat-gateway.js'
import { toApiErrorEnvelope, ApiError } from './http/errors.js'
import { initializeRequestContext } from './http/request-context.js'
import { installSecurity } from './http/security.js'
import type { Clock } from './lib/clock.js'
import type { IdGenerator } from './lib/id.js'
import type { Metrics } from './observability/metrics.js'
import { registerProfileRoutes } from './profile/profile-routes.js'
import { registerHealthRoutes } from './routes/health.js'
import type { ObjectStorage } from './uploads/object-storage.js'
import { SignedHistoryCursorCodec } from './uploads/cursor.js'
import { PostgresUploadHistoryRepository } from './uploads/history-repository.js'
import { UploadHistoryService } from './uploads/history-service.js'
import { PostgresUploadRepository, type UploadRepository } from './uploads/upload-repository.js'
import { registerUploadRoutes } from './uploads/upload-routes.js'
import { PostgresUploadConcurrency } from './uploads/upload-concurrency.js'
import {
  UploadService,
  type ExclusiveUploadConcurrency,
  type PartUploadConcurrency,
} from './uploads/upload-service.js'

const UUID_V7 = new RegExp(UUID_V7_PATTERN)
const REQUEST_TIMEOUT_MS = 180_000
const CONNECTION_IDLE_TIMEOUT_MS = 30_000
const ORDINARY_REQUEST_TIMEOUT_MS = 10_000

export interface AppShellDependencies {
  pool: Pool
  readiness: {
    database(signal: AbortSignal): Promise<boolean>
    objectStorage(signal: AbortSignal): Promise<boolean>
  }
  clock: Clock
  ids: IdGenerator
  logger: false | FastifyBaseLogger
  metrics: Metrics
  monitoringToken: string
  trustProxy: Exclude<FastifyServerOptions['trustProxy'], undefined>
  ordinaryRequestTimeoutMs?: number
}

export interface AppDependencies extends AppShellDependencies {
  wechatAppId: string
  wechatGateway: WechatGateway
  tokenService: TokenService
  authRepository?: AuthRepository
  objectStorage: ObjectStorage
  objectStorageBucket: string
  cursorSigningSecret: Buffer
  uploadRepository?: UploadRepository
  uploadConcurrency?: PartUploadConcurrency & ExclusiveUploadConcurrency
  uploadLockPool?: Pool
}

function clientRequestId(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && UUID_V7.test(value) ? value : undefined
}

function isUploadPartRequest(
  method: string,
  url: string | undefined,
  contentType: string | string[] | undefined,
): boolean {
  return (
    method === 'POST' &&
    url !== undefined &&
    /^\/v1\/uploads\/[^/?]+\/parts\/[^/?]+(?:\?|$)/u.test(url) &&
    typeof contentType === 'string' &&
    /^multipart\/form-data(?:;|$)/iu.test(contentType.trim())
  )
}

export function buildAppShell(deps: AppShellDependencies): FastifyInstance {
  const ordinaryRequestTimeoutMs = deps.ordinaryRequestTimeoutMs ?? ORDINARY_REQUEST_TIMEOUT_MS
  if (
    !Number.isSafeInteger(ordinaryRequestTimeoutMs) ||
    ordinaryRequestTimeoutMs < 1 ||
    ordinaryRequestTimeoutMs > REQUEST_TIMEOUT_MS
  ) {
    throw new RangeError('ordinary request timeout must be between 1 and 180000 milliseconds')
  }
  const commonOptions: FastifyServerOptions = {
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
    bodyLimit: 65_536,
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_IDLE_TIMEOUT_MS,
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: deps.trustProxy,
    requestIdHeader: false,
    genReqId: (request) => clientRequestId(request.headers['x-request-id']) ?? deps.ids.next(),
  }
  const app =
    deps.logger === false
      ? Fastify({ ...commonOptions, logger: false })
      : Fastify({ ...commonOptions, loggerInstance: deps.logger })

  app.addHook('onRequest', async (request, reply) => {
    initializeRequestContext(request, deps.clock)
    reply.header('X-Request-Id', request.id)
    if (!isUploadPartRequest(request.method, request.raw.url, request.headers['content-type'])) {
      const timeout = setTimeout(() => {
        if (!reply.raw.destroyed) reply.raw.destroy()
      }, ordinaryRequestTimeoutMs)
      timeout.unref()
      const clearDeadline = () => {
        clearTimeout(timeout)
      }
      reply.raw.once('finish', clearDeadline)
      reply.raw.once('close', clearDeadline)
    }
  })
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        requestId: request.id,
        route: request.routeOptions.url,
        method: request.method,
        statusCode: reply.statusCode,
        durationMs: reply.elapsedTime,
      },
      'request completed',
    )
  })
  app.addHook('onError', async (request, reply, error) => {
    request.log.error(
      {
        requestId: request.id,
        route: request.routeOptions.url,
        method: request.method,
        statusCode: reply.statusCode,
        errorCode: error instanceof ApiError ? error.code : 'INTERNAL_ERROR',
        retryable: error instanceof ApiError && error.retryable,
      },
      'request failed',
    )
  })
  installSecurity(app)
  app.setErrorHandler(toApiErrorEnvelope)
  app.setNotFoundHandler(() => {
    throw new ApiError({
      code: 'ROUTE_NOT_FOUND',
      message: '请求的接口不存在',
      statusCode: 404,
    })
  })
  registerHealthRoutes(app, deps)

  return app
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = buildAppShell(deps)
  const repository =
    deps.authRepository ??
    new PostgresAuthRepository({ pool: deps.pool, clock: deps.clock, ids: deps.ids })
  const auth = new AuthService({
    appId: deps.wechatAppId,
    clock: deps.clock,
    gateway: deps.wechatGateway,
    repository,
    tokens: deps.tokenService,
    metrics: deps.metrics,
  })
  registerAuthRoutes(app, { auth, tokens: deps.tokenService })
  registerProfileRoutes(app, { auth, tokens: deps.tokenService })
  const uploadRepository =
    deps.uploadRepository ??
    new PostgresUploadRepository({ pool: deps.pool, clock: deps.clock, ids: deps.ids })
  const uploadConcurrency =
    deps.uploadConcurrency ??
    new PostgresUploadConcurrency({ pool: deps.uploadLockPool ?? deps.pool })
  const uploads = new UploadService({
    bucket: deps.objectStorageBucket,
    clock: deps.clock,
    ids: deps.ids,
    repository: uploadRepository,
    storage: deps.objectStorage,
    concurrency: uploadConcurrency,
    exclusiveConcurrency: uploadConcurrency,
  })
  const history = new UploadHistoryService({
    repository: new PostgresUploadHistoryRepository({ pool: deps.pool }),
    cursor: new SignedHistoryCursorCodec({ secret: deps.cursorSigningSecret, clock: deps.clock }),
  })
  registerUploadRoutes(app, { uploads, history, tokens: deps.tokenService })
  return app
}
