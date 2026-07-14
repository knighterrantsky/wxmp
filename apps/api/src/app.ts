import { UUID_V7_PATTERN } from '@wx-upload/contracts'
import Fastify, {
  LogController,
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyServerOptions,
} from 'fastify'
import type { Pool } from 'pg'

import { toApiErrorEnvelope, ApiError } from './http/errors.js'
import { initializeRequestContext } from './http/request-context.js'
import { installSecurity } from './http/security.js'
import type { Clock } from './lib/clock.js'
import type { IdGenerator } from './lib/id.js'
import type { Metrics } from './observability/metrics.js'
import { registerHealthRoutes } from './routes/health.js'

const UUID_V7 = new RegExp(UUID_V7_PATTERN)

export interface AppDependencies {
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
}

function clientRequestId(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && UUID_V7.test(value) ? value : undefined
}

export function buildApp(deps: AppDependencies): FastifyInstance {
  const commonOptions: FastifyServerOptions = {
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
    bodyLimit: 65_536,
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
