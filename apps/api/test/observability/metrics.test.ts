import { afterEach, describe, expect, it } from 'vitest'

import { buildApp } from '../../src/app.js'
import { Metrics } from '../../src/observability/metrics.js'
import { fakeDependencies } from '../support/fakes.js'

const apps: ReturnType<typeof buildApp>[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()))
})

describe('metrics', () => {
  it('uses a private per-instance registry with bounded labels', async () => {
    const sentinel = 'private-user-openid-file-object-token-sentinel'
    const metrics = new Metrics()
    const secondMetrics = new Metrics()

    metrics.recordLogin({ outcome: 'success', durationSeconds: 0.01, userId: sentinel } as never)
    metrics.recordUploadInitialization({ outcome: 'accepted' })
    metrics.recordPart({ outcome: 'uploaded', durationSeconds: 0.1, bytes: 1024 })
    metrics.recordR2Operation({ operation: 'uploadPart', outcome: 'success', durationSeconds: 0.1 })
    metrics.setFinalizerBacklog(2)
    metrics.recordFinalizerRetry({ outcome: 'scheduled' })
    metrics.recordReconciliation({ outcome: 'repaired' })

    const exposition = await metrics.render()
    expect(exposition).toMatch(/wx_upload_login_total/)
    expect(exposition).toMatch(/wx_upload_part_duration_seconds/)
    expect(exposition).toMatch(/wx_upload_r2_operation_duration_seconds/)
    expect(exposition).toMatch(/wx_upload_finalizer_backlog/)
    expect(exposition).toMatch(/wx_upload_reconciliation_total/)
    expect(exposition).not.toContain(sentinel)
    await expect(secondMetrics.render()).resolves.toContain('wx_upload_login_total')
  })

  it('rejects values outside the metric label whitelist', async () => {
    const metrics = new Metrics()
    const sentinel = 'user-controlled-object-key-sentinel'

    expect(() => {
      metrics.recordR2Operation({
        operation: sentinel,
        outcome: 'success',
        durationSeconds: 0.1,
      } as never)
    }).toThrow(/metric label/i)
    await expect(metrics.render()).resolves.not.toContain(sentinel)
  })

  it('keeps the metrics endpoint private', async () => {
    const deps = fakeDependencies({ monitoringToken: 'metrics-monitor-token' })
    const app = buildApp(deps)
    apps.push(app)

    const missing = await app.inject({ method: 'GET', url: '/internal/metrics' })
    const wrong = await app.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { 'x-monitoring-token': 'wrong' },
    })
    const accepted = await app.inject({
      method: 'GET',
      url: '/internal/metrics',
      headers: { 'x-monitoring-token': 'metrics-monitor-token' },
    })

    expect(missing.statusCode).toBe(401)
    expect(wrong.statusCode).toBe(401)
    expect(missing.body).not.toContain('wx_upload_')
    expect(accepted.statusCode).toBe(200)
    expect(accepted.headers['content-type']).toMatch(/text\/plain|openmetrics/i)
    expect(accepted.body).toContain('wx_upload_login_total')
  })
})
