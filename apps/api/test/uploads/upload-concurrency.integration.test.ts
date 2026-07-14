import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { createPool } from '../../src/db/pool.js'
import { PostgresUploadConcurrency } from '../../src/uploads/upload-concurrency.js'
import { loadDestructiveDatabaseTestConfig } from '../support/destructive-database.js'

const databaseConfig = loadDestructiveDatabaseTestConfig(process.env)
const userId = '01981d7b-6c80-7000-8000-000000000101'

function uploadId(index: number): string {
  return `01981d7b-6c80-7000-8000-${String(index).padStart(12, '0')}`
}

let pool: Pool

beforeAll(() => {
  pool = createPool(databaseConfig.runtimeDatabaseUrl)
})

afterAll(async () => {
  await pool.end()
})

describe('PostgreSQL upload concurrency gates', () => {
  it('rejects a concurrent request for the same part and releases every lock', async () => {
    const concurrency = new PostgresUploadConcurrency({ pool })
    const first = await concurrency.acquirePart({
      uploadId: uploadId(1),
      partNumber: 1,
      userId,
    })

    await expect(
      concurrency.acquirePart({ uploadId: uploadId(1), partNumber: 1, userId }),
    ).rejects.toMatchObject({
      code: 'PART_UPLOAD_IN_PROGRESS',
      statusCode: 409,
      retryable: true,
    })
    await first.release()

    const reacquired = await concurrency.acquirePart({
      uploadId: uploadId(1),
      partNumber: 1,
      userId,
    })
    await reacquired.release()
  })

  it('allows two parts per upload and rejects the third', async () => {
    const concurrency = new PostgresUploadConcurrency({ pool })
    const first = await concurrency.acquirePart({
      uploadId: uploadId(2),
      partNumber: 1,
      userId,
    })
    const second = await concurrency.acquirePart({
      uploadId: uploadId(2),
      partNumber: 2,
      userId,
    })

    await expect(
      concurrency.acquirePart({ uploadId: uploadId(2), partNumber: 3, userId }),
    ).rejects.toMatchObject({
      code: 'UPLOAD_CONCURRENCY_LIMIT',
      statusCode: 429,
      retryable: true,
    })
    await Promise.all([second.release(), first.release()])
  })

  it('allows four parts per user across uploads and rejects the fifth', async () => {
    const concurrency = new PostgresUploadConcurrency({ pool })
    const leases = await Promise.all(
      [10, 11, 12, 13].map((index) =>
        concurrency.acquirePart({ uploadId: uploadId(index), partNumber: 1, userId }),
      ),
    )

    await expect(
      concurrency.acquirePart({ uploadId: uploadId(14), partNumber: 1, userId }),
    ).rejects.toMatchObject({
      code: 'UPLOAD_CONCURRENCY_LIMIT',
      statusCode: 429,
      retryable: true,
    })
    await Promise.all(leases.map((lease) => lease.release()))
  })

  it('grants the exclusive upload gate after every shared part lease releases', async () => {
    const concurrency = new PostgresUploadConcurrency({ pool, pollIntervalMs: 5 })
    const first = await concurrency.acquirePart({
      uploadId: uploadId(20),
      partNumber: 1,
      userId,
    })
    const second = await concurrency.acquirePart({
      uploadId: uploadId(20),
      partNumber: 2,
      userId,
    })
    let acquired = false
    const exclusivePromise = concurrency
      .acquireExclusiveUpload({ uploadId: uploadId(20), waitMs: 250 })
      .then((lease) => {
        acquired = true
        return lease
      })

    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(acquired).toBe(false)
    await first.release()
    expect(acquired).toBe(false)
    await second.release()
    const exclusive = await exclusivePromise
    expect(acquired).toBe(true)
    await exclusive.release()
  })

  it('times out exclusively with UPLOAD_BUSY and leaves no leaked lock', async () => {
    const concurrency = new PostgresUploadConcurrency({ pool, pollIntervalMs: 5 })
    const part = await concurrency.acquirePart({
      uploadId: uploadId(30),
      partNumber: 1,
      userId,
    })

    await expect(
      concurrency.acquireExclusiveUpload({ uploadId: uploadId(30), waitMs: 25 }),
    ).rejects.toMatchObject({
      code: 'UPLOAD_BUSY',
      statusCode: 409,
      retryable: true,
    })
    await part.release()

    const exclusive = await concurrency.acquireExclusiveUpload({
      uploadId: uploadId(30),
      waitMs: 25,
    })
    await exclusive.release()
  })

  it('maps dedicated lock-pool capacity exhaustion to public retryable errors', async () => {
    const boundedPool = new Pool({
      connectionString: databaseConfig.runtimeDatabaseUrl,
      max: 1,
      connectionTimeoutMillis: 50,
    })
    const concurrency = new PostgresUploadConcurrency({ pool: boundedPool })
    const held = await concurrency.acquirePart({
      uploadId: uploadId(40),
      partNumber: 1,
      userId,
    })
    try {
      await expect(
        concurrency.acquirePart({ uploadId: uploadId(41), partNumber: 1, userId }),
      ).rejects.toMatchObject({
        code: 'UPLOAD_CONCURRENCY_LIMIT',
        statusCode: 429,
        retryable: true,
      })
      await expect(
        concurrency.acquireExclusiveUpload({ uploadId: uploadId(40), waitMs: 25 }),
      ).rejects.toMatchObject({
        code: 'UPLOAD_BUSY',
        statusCode: 409,
        retryable: true,
      })
    } finally {
      await held.release()
      await boundedPool.end()
    }
  })

  it('counts connection acquisition against the exclusive wait budget', async () => {
    const release = vi.fn()
    const query = vi.fn().mockResolvedValue({ rows: [{ acquired: true }] })
    const delayedPool = {
      async connect() {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return { query, release }
      },
    } as unknown as Pool
    const concurrency = new PostgresUploadConcurrency({ pool: delayedPool, pollIntervalMs: 5 })

    await expect(
      concurrency.acquireExclusiveUpload({ uploadId: uploadId(45), waitMs: 5 }),
    ).rejects.toMatchObject({
      code: 'UPLOAD_BUSY',
      statusCode: 409,
      retryable: true,
    })
    expect(query).not.toHaveBeenCalled()
    expect(release).toHaveBeenCalledOnce()
  })

  it('does not disguise unexpected database connection failures as capacity pressure', async () => {
    const failure = new Error('database authentication failed')
    const brokenPool = {
      connect: vi.fn().mockRejectedValue(failure),
    } as unknown as Pool
    const concurrency = new PostgresUploadConcurrency({ pool: brokenPool })

    await expect(
      concurrency.acquirePart({ uploadId: uploadId(50), partNumber: 1, userId }),
    ).rejects.toBe(failure)
    await expect(
      concurrency.acquireExclusiveUpload({ uploadId: uploadId(50), waitMs: 25 }),
    ).rejects.toBe(failure)
  })
})
