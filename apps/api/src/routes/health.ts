import type { FastifyInstance } from 'fastify'

import type { AppDependencies } from '../app.js'
import { ApiError } from '../http/errors.js'
import { isMonitoringTokenValid } from '../http/security.js'

const READINESS_DEADLINE_MS = 2_000

function requireMonitoringToken(header: string | string[] | undefined, expected: string): void {
  if (!isMonitoringTokenValid(header, expected)) {
    throw new ApiError({
      code: 'UNAUTHORIZED',
      message: '监控凭据无效',
      statusCode: 401,
    })
  }
}

async function safeProbe(
  probe: (signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    return await probe(signal)
  } catch {
    return false
  }
}

async function readinessWithinDeadline(deps: AppDependencies): Promise<boolean> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<readonly [false, false]>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve([false, false])
    }, READINESS_DEADLINE_MS)
  })
  const probes = Promise.all([
    safeProbe((signal) => deps.readiness.database(signal), controller.signal),
    safeProbe((signal) => deps.readiness.objectStorage(signal), controller.signal),
  ])

  try {
    const [databaseReady, storageReady] = await Promise.race([probes, deadline])
    if (!databaseReady || !storageReady) controller.abort()
    return databaseReady && storageReady
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function registerHealthRoutes(app: FastifyInstance, deps: AppDependencies): void {
  app.get('/health/live', () => ({ status: 'ok' }))

  app.get('/health/ready', async (request, reply) => {
    requireMonitoringToken(request.headers['x-monitoring-token'], deps.monitoringToken)
    if (await readinessWithinDeadline(deps)) return { status: 'ready' }
    return reply.code(503).header('Retry-After', '1').send({ status: 'unavailable' })
  })

  app.get('/internal/metrics', async (request, reply) => {
    requireMonitoringToken(request.headers['x-monitoring-token'], deps.monitoringToken)
    const body = await deps.metrics.render()
    return reply.header('Content-Type', deps.metrics.contentType).send(body)
  })
}
