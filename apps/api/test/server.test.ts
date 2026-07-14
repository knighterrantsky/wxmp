import { describe, expect, it, vi } from 'vitest'

import type { RuntimeConfig } from '../src/config.js'
import {
  createConfiguredTokenService,
  createConfiguredWechatGateway,
  createResourceCloser,
  databaseIsReady,
  startPreparedServer,
} from '../src/server.js'

function runtimeConfig(
  override: Partial<Pick<RuntimeConfig, 'nodeEnv' | 'jwt'>> = {},
): RuntimeConfig {
  return {
    nodeEnv: override.nodeEnv ?? 'development',
    databaseUrl: 'postgresql://runtime:private@127.0.0.1/database',
    wechat: {
      authMode: 'stub',
      appId: 'wx-development-app',
      appSecret: 'development-secret',
      endpoint: 'https://api.weixin.qq.com/sns/jscode2session',
      connectTimeoutMs: 2_000,
      totalTimeoutMs: 5_000,
    },
    jwt: override.jwt ?? {
      privateKey: 'temporary-development-key',
      publicKey: 'temporary-development-key',
    },
    r2: {
      endpoint: 'http://127.0.0.1:59000',
      bucket: 'wx-private-media',
      accessKeyId: 'development',
      secretAccessKey: 'development-secret',
      forcePathStyle: true,
    },
    server: {
      host: '127.0.0.1',
      port: 3_000,
      monitoringToken: 'development-monitoring-token',
      trustProxy: false,
    },
  }
}

describe('server resource lifecycle', () => {
  it('boots the local stub and ephemeral Ed25519 signer without development secrets', async () => {
    const ids = { next: () => '01981c31-4c80-7000-8000-000000000001' }
    const config = runtimeConfig()
    const gateway = createConfiguredWechatGateway(config.wechat)
    const tokens = createConfiguredTokenService(config, ids)

    const identity = await gateway.exchangeCode('dev:alice')
    expect(identity.openid).toMatch(/^stub_[0-9a-f]{48}$/)
    const accessToken = await tokens.issueAccessToken({
      userId: '01981c31-4c80-7000-8000-000000000011',
      sessionId: '01981c31-4c80-7000-8000-000000000012',
    })
    await expect(tokens.verifyAccessToken(accessToken)).resolves.toEqual({
      sub: '01981c31-4c80-7000-8000-000000000011',
      sid: '01981c31-4c80-7000-8000-000000000012',
    })
  })

  it('never accepts temporary signing material in a production runtime', () => {
    const config = runtimeConfig({ nodeEnv: 'production' })
    expect(() =>
      createConfiguredTokenService(config, {
        next: () => '01981c31-4c80-7000-8000-000000000001',
      }),
    ).toThrow(/Ed25519 signing keys/i)
  })

  it('destroys the dedicated readiness connection when the shared deadline aborts', async () => {
    let queryStarted!: () => void
    const started = new Promise<void>((resolve) => {
      queryStarted = resolve
    })
    const release = vi.fn()
    const client = {
      query: vi.fn(() => {
        queryStarted()
        return new Promise<never>(() => undefined)
      }),
      release,
    }
    const pool = { connect: vi.fn(() => Promise.resolve(client)) }
    const controller = new AbortController()

    const readiness = databaseIsReady(pool, controller.signal)
    await started
    controller.abort()

    await expect(readiness).resolves.toBe(false)
    expect(release).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith(true)
  })

  it('releases a successful readiness connection back to the pool', async () => {
    const release = vi.fn()
    const client = {
      query: vi.fn(() => Promise.resolve({ rows: [{ '?column?': 1 }] })),
      release,
    }
    const pool = { connect: vi.fn(() => Promise.resolve(client)) }

    await expect(databaseIsReady(pool, new AbortController().signal)).resolves.toBe(true)
    expect(client.query).toHaveBeenCalledWith('select 1')
    expect(release).toHaveBeenCalledOnce()
    expect(release).toHaveBeenCalledWith()
  })

  it('always ends the pool when app close fails and closes only once', async () => {
    const closeFailure = new Error('fastify close failure')
    const app = { close: vi.fn(() => Promise.reject(closeFailure)) }
    const pool = { end: vi.fn(() => Promise.resolve()) }
    const close = createResourceCloser(app, pool)

    await expect(close()).rejects.toBe(closeFailure)
    await expect(close()).rejects.toBe(closeFailure)
    expect(app.close).toHaveBeenCalledOnce()
    expect(pool.end).toHaveBeenCalledOnce()
  })

  it('cleans both resources after listen fails without replacing the listen error', async () => {
    const listenFailure = new Error('listen failed')
    const app = {
      listen: vi.fn(() => Promise.reject(listenFailure)),
      close: vi.fn(() => Promise.reject(new Error('close failed'))),
    }
    const pool = { end: vi.fn(() => Promise.resolve()) }

    await expect(
      startPreparedServer({ host: '127.0.0.1', port: 3000 }, { app, pool }),
    ).rejects.toBe(listenFailure)
    expect(app.close).toHaveBeenCalledOnce()
    expect(pool.end).toHaveBeenCalledOnce()
  })
})
