import { afterEach, describe, expect, it, vi } from 'vitest'

import { createPool } from '../../src/db/pool.js'

const pools: ReturnType<typeof createPool>[] = []

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.end()))
})

describe('runtime PostgreSQL pool', () => {
  it('sets finite connection, query, and statement deadlines', () => {
    const pool = createPool('postgresql://runtime:password@127.0.0.1:55432/wx_upload')
    pools.push(pool)

    expect(pool.options.connectionTimeoutMillis).toBeGreaterThan(0)
    expect(pool.options.query_timeout).toBeGreaterThan(0)
    expect(pool.options.statement_timeout).toBeGreaterThan(0)
    expect(pool.options.max).toBe(20)
  })

  it('supports bounded dedicated pools with distinct application names', () => {
    const pool = createPool('postgresql://runtime:password@127.0.0.1:55432/wx_upload', undefined, {
      max: 12,
      applicationName: 'wx-private-upload-locks',
    })
    pools.push(pool)

    expect(pool.options.max).toBe(12)
    expect(pool.options.application_name).toBe('wx-private-upload-locks')
  })

  it('handles idle-client errors instead of leaving an unhandled error event', () => {
    const onIdleClientError = vi.fn()
    const pool = createPool(
      'postgresql://runtime:password@127.0.0.1:55432/wx_upload',
      onIdleClientError,
    )
    pools.push(pool)
    const failure = new Error('idle socket failed with a private host')

    expect(() => pool.emit('error', failure)).not.toThrow()
    expect(onIdleClientError).toHaveBeenCalledWith(failure)
  })
})
