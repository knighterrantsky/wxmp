import { describe, expect, it, vi } from 'vitest'

import { createResourceCloser, databaseIsReady, startPreparedServer } from '../src/server.js'

describe('server resource lifecycle', () => {
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
