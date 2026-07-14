import { setTimeout as delay } from 'node:timers/promises'

import type { Pool, PoolClient } from 'pg'

import { ApiError } from '../http/errors.js'

const DEFAULT_EXCLUSIVE_WAIT_MS = 8_000
const DEFAULT_POLL_INTERVAL_MS = 25
const UPLOAD_SLOT_COUNT = 2
const USER_SLOT_COUNT = 4

export interface AdvisoryLockLease {
  release(): Promise<void>
}

interface HeldPartLocks {
  uploadGate: string
  part: string
  uploadSlot: string | undefined
  userSlot: string | undefined
}

function concurrencyError(
  code: 'PART_UPLOAD_IN_PROGRESS' | 'UPLOAD_BUSY' | 'UPLOAD_CONCURRENCY_LIMIT',
  statusCode: 409 | 429,
): ApiError {
  return new ApiError({ code, message: code, retryable: true, statusCode })
}

function isPoolCapacityTimeout(error: unknown): boolean {
  return error instanceof Error && error.message === 'timeout exceeded when trying to connect'
}

function uploadGateKey(uploadId: string): string {
  return `wx-upload:gate:${uploadId}`
}

function partKey(uploadId: string, partNumber: number): string {
  return `wx-upload:part:${uploadId}:${String(partNumber)}`
}

function uploadSlotKey(uploadId: string, slot: number): string {
  return `wx-upload:upload-slot:${uploadId}:${String(slot)}`
}

function userSlotKey(userId: string, slot: number): string {
  return `wx-upload:user-slot:${userId}:${String(slot)}`
}

async function tryLock(
  client: PoolClient,
  key: string,
  mode: 'exclusive' | 'shared' = 'exclusive',
): Promise<boolean> {
  const result = await client.query<{ acquired: boolean }>(
    mode === 'shared'
      ? `select pg_try_advisory_lock_shared(hashtextextended($1, 0)) as acquired`
      : `select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired`,
    [key],
  )
  return result.rows[0]?.acquired === true
}

async function unlock(
  client: PoolClient,
  key: string,
  mode: 'exclusive' | 'shared' = 'exclusive',
): Promise<void> {
  await client.query(
    mode === 'shared'
      ? `select pg_advisory_unlock_shared(hashtextextended($1, 0))`
      : `select pg_advisory_unlock(hashtextextended($1, 0))`,
    [key],
  )
}

async function firstAvailableSlot(
  client: PoolClient,
  count: number,
  key: (slot: number) => string,
): Promise<string | undefined> {
  for (let slot = 0; slot < count; slot += 1) {
    const candidate = key(slot)
    if (await tryLock(client, candidate)) return candidate
  }
  return undefined
}

async function releasePartLocks(client: PoolClient, locks: HeldPartLocks): Promise<void> {
  if (locks.userSlot !== undefined) await unlock(client, locks.userSlot)
  if (locks.uploadSlot !== undefined) await unlock(client, locks.uploadSlot)
  await unlock(client, locks.part)
  await unlock(client, locks.uploadGate, 'shared')
}

function lease(client: PoolClient, releaseLocks: () => Promise<void>): AdvisoryLockLease {
  let released = false
  return {
    async release() {
      if (released) return
      released = true
      try {
        await releaseLocks()
      } catch (error) {
        client.release(error instanceof Error ? error : true)
        throw error
      }
      client.release()
    },
  }
}

export class PostgresUploadConcurrency {
  readonly #pool: Pool
  readonly #pollIntervalMs: number

  constructor(input: { pool: Pool; pollIntervalMs?: number }) {
    this.#pool = input.pool
    this.#pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
    if (
      !Number.isSafeInteger(this.#pollIntervalMs) ||
      this.#pollIntervalMs < 1 ||
      this.#pollIntervalMs > 1_000
    ) {
      throw new RangeError('poll interval must be between 1 and 1000 milliseconds')
    }
  }

  async acquirePart(input: {
    uploadId: string
    partNumber: number
    userId: string
  }): Promise<AdvisoryLockLease> {
    let client: PoolClient
    try {
      client = await this.#pool.connect()
    } catch (error) {
      if (isPoolCapacityTimeout(error)) {
        throw concurrencyError('UPLOAD_CONCURRENCY_LIMIT', 429)
      }
      throw error
    }
    const locks: HeldPartLocks = {
      uploadGate: uploadGateKey(input.uploadId),
      part: partKey(input.uploadId, input.partNumber),
      uploadSlot: undefined,
      userSlot: undefined,
    }
    let hasGate = false
    let hasPart = false
    try {
      hasGate = await tryLock(client, locks.uploadGate, 'shared')
      if (!hasGate) throw concurrencyError('UPLOAD_BUSY', 409)

      hasPart = await tryLock(client, locks.part)
      if (!hasPart) throw concurrencyError('PART_UPLOAD_IN_PROGRESS', 409)

      locks.uploadSlot = await firstAvailableSlot(client, UPLOAD_SLOT_COUNT, (slot) =>
        uploadSlotKey(input.uploadId, slot),
      )
      if (locks.uploadSlot === undefined) {
        throw concurrencyError('UPLOAD_CONCURRENCY_LIMIT', 429)
      }

      locks.userSlot = await firstAvailableSlot(client, USER_SLOT_COUNT, (slot) =>
        userSlotKey(input.userId, slot),
      )
      if (locks.userSlot === undefined) {
        throw concurrencyError('UPLOAD_CONCURRENCY_LIMIT', 429)
      }

      return lease(client, () => releasePartLocks(client, locks))
    } catch (error) {
      try {
        if (locks.userSlot !== undefined) await unlock(client, locks.userSlot)
        if (locks.uploadSlot !== undefined) await unlock(client, locks.uploadSlot)
        if (hasPart) await unlock(client, locks.part)
        if (hasGate) await unlock(client, locks.uploadGate, 'shared')
      } catch (cleanupError) {
        client.release(cleanupError instanceof Error ? cleanupError : true)
        throw error
      }
      client.release(error instanceof Error && !(error instanceof ApiError) ? error : undefined)
      throw error
    }
  }

  async acquireExclusiveUpload(input: {
    uploadId: string
    waitMs?: number
  }): Promise<AdvisoryLockLease> {
    const waitMs = input.waitMs ?? DEFAULT_EXCLUSIVE_WAIT_MS
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 60_000) {
      throw new RangeError('exclusive wait must be between 0 and 60000 milliseconds')
    }
    const deadline = performance.now() + waitMs
    let client: PoolClient
    try {
      client = await this.#pool.connect()
    } catch (error) {
      if (isPoolCapacityTimeout(error)) throw concurrencyError('UPLOAD_BUSY', 409)
      throw error
    }
    const key = uploadGateKey(input.uploadId)
    try {
      if (waitMs > 0 && performance.now() >= deadline) {
        throw concurrencyError('UPLOAD_BUSY', 409)
      }
      for (;;) {
        if (await tryLock(client, key)) {
          return lease(client, () => unlock(client, key))
        }
        const remaining = deadline - performance.now()
        if (remaining <= 0) throw concurrencyError('UPLOAD_BUSY', 409)
        await delay(Math.min(this.#pollIntervalMs, remaining))
      }
    } catch (error) {
      client.release(error instanceof Error && !(error instanceof ApiError) ? error : undefined)
      throw error
    }
  }
}
