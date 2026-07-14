import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { fakeDependencies } from '../support/fakes.js'

const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('health routes', () => {
  it('does not touch dependencies for liveness', async () => {
    const deps = fakeDependencies({ databaseReady: false, objectStorageReady: false })
    const app = buildApp(deps)
    apps.push(app)

    expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200)
    expect(deps.probes.databaseCalls).toBe(0)
    expect(deps.probes.objectStorageCalls).toBe(0)
  })

  it('authenticates readiness before touching either dependency', async () => {
    const deps = fakeDependencies({ monitoringToken: 'monitor-test' })
    const app = buildApp(deps)
    apps.push(app)

    expect((await app.inject({ method: 'GET', url: '/health/ready' })).statusCode).toBe(401)
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/health/ready',
          headers: { 'x-monitoring-token': 'wrong-token-with-different-length' },
        })
      ).statusCode,
    ).toBe(401)
    expect(deps.probes.databaseCalls).toBe(0)
    expect(deps.probes.objectStorageCalls).toBe(0)
  })

  it('checks database and object storage and reports ready', async () => {
    const deps = fakeDependencies({ monitoringToken: 'monitor-test' })
    const app = buildApp(deps)
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
      headers: { 'x-monitoring-token': 'monitor-test' },
    })

    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ status: 'ready' })
    expect(deps.probes.databaseCalls).toBe(1)
    expect(deps.probes.objectStorageCalls).toBe(1)
  })

  it('does not leak dependency details when readiness fails', async () => {
    const deps = fakeDependencies({
      databaseProbe: () =>
        Promise.reject(new Error('postgresql://admin:secret@db.internal/wx_upload')),
      objectStorageReady: false,
      monitoringToken: 'monitor-test',
    })
    const app = buildApp(deps)
    apps.push(app)

    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
      headers: { 'x-monitoring-token': 'monitor-test' },
    })

    expect(response.statusCode).toBe(503)
    expect(response.headers['retry-after']).toBe('1')
    expect(response.body).not.toMatch(/postgresql|secret|db\.internal|bucket|exception/i)
  })

  it('aborts probes at one shared two-second deadline', async () => {
    const never = (signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        signal.addEventListener(
          'abort',
          () => {
            resolve(false)
          },
          { once: true },
        )
      })
    const deps = fakeDependencies({
      databaseProbe: never,
      objectStorageProbe: never,
      monitoringToken: 'monitor-test',
    })
    const app = buildApp(deps)
    apps.push(app)
    const startedAt = Date.now()

    const response = await app.inject({
      method: 'GET',
      url: '/health/ready',
      headers: { 'x-monitoring-token': 'monitor-test' },
    })

    expect(response.statusCode).toBe(503)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_900)
    expect(Date.now() - startedAt).toBeLessThan(2_500)
    expect(deps.probes.databaseSignals[0]?.aborted).toBe(true)
    expect(deps.probes.objectStorageSignals[0]?.aborted).toBe(true)
  }, 4_000)
})
